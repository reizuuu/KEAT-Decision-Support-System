import hashlib
from datetime import datetime

from flask import Blueprint, current_app, jsonify, request

from models import UploadLog, db
from services.parsing import MissingColumnsError, read_and_clean_upload
from services.persistence import (
    apply_master_pricing,
    attach_product_ids,
    compute_true_receipt_ids,
    drop_existing_rows,
    insert_raw_transactions,
    start_background_remine,
    upsert_transaction_statistics,
)


upload_bp = Blueprint("upload", __name__)


@upload_bp.post("/api/upload")
def upload_file():
    uploaded_file = request.files.get("file")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify({"error": "Please select a CSV or XLSX file."}), 400

    # 1. File-level dedup, before pandas even runs - but only a hard block
    # if this exact file was already FULLY processed before. An earlier
    # attempt that had to skip rows for a catalog reason
    # (had_unmatched_rows=True) isn't "done" in any meaningful sense - the
    # same file re-uploaded after the catalog is fixed deserves a chance to
    # pick up what it missed. Row-level dedup (drop_existing_rows) below
    # independently guarantees this never double-inserts whatever already
    # succeeded, regardless of how many times the same file comes through.
    raw_bytes = uploaded_file.read()
    file_hash = hashlib.sha256(raw_bytes).hexdigest()
    existing_upload_log = UploadLog.query.filter_by(file_hash=file_hash).first()
    if existing_upload_log is not None and not existing_upload_log.had_unmatched_rows:
        return jsonify({"error": "This file has already been uploaded."}), 400
    uploaded_file.stream.seek(0)

    # 2. Read & clean via the existing pandas pipeline.
    try:
        dataframe, rows_dropped = read_and_clean_upload(uploaded_file)
    except MissingColumnsError as exc:
        return jsonify({"error": str(exc), "missingColumns": exc.columns}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if dataframe.empty:
        return jsonify({"error": "The file contains no valid transaction rows."}), 400

    dataframe["Year"] = dataframe["Date"].dt.year.astype(int)
    dataframe["Month"] = dataframe["Date"].dt.month.astype(int)
    dataframe["Day"] = dataframe["Date"].dt.day.astype(int)

    try:
        # 5 (before 3): true_receipt_id has to exist before row-level dedup
        # can run, since RawTransaction.receipt_id - what dedup compares
        # against - stores the grouped true_receipt_id, not the raw per-file
        # receipt id.
        dataframe = compute_true_receipt_ids(dataframe)

        # 3. Row-level dedup against everything already stored.
        deduped, duplicate_count = drop_existing_rows(dataframe)

        # 6. Aggregate & persist, inside one transaction so a failure partway
        # through (including this UploadLog row) rolls back cleanly.
        # Reuses the SAME UploadLog row (rather than inserting a new one)
        # when this file_hash already has an incomplete prior attempt -
        # file_hash is unique, so a second row for it would violate that
        # constraint. Reusing it also means every RawTransaction row this
        # file has ever contributed, across however many attempts it took,
        # still points at one consistent upload_id.
        if existing_upload_log is not None:
            upload_log = existing_upload_log
            upload_log.upload_date = datetime.utcnow()
        else:
            upload_log = UploadLog(file_hash=file_hash)
            db.session.add(upload_log)
            db.session.flush()  # populate upload_log.upload_id for RawTransaction rows

        matched_rows = deduped
        unmatched_product_names = []
        unpriced_product_names = []
        rows_after_matching = 0
        if not deduped.empty:
            # 4. FK translation (product_name -> product_id / category_id) -
            # lookup-only against the active catalog now (see
            # services/persistence.attach_product_ids); a row whose product
            # isn't in the catalog is skipped, not auto-created, and its
            # name is reported back rather than silently dropped.
            matched_rows, unmatched_product_names = attach_product_ids(deduped)
            rows_after_matching = len(matched_rows)
            if not matched_rows.empty:
                # 4b. Lock in the catalog's CURRENT price for every matched
                # row before it's ever persisted - see apply_master_pricing
                # for why this must run before insert, never after. A row
                # whose price can't be resolved (no master price AND no
                # usable file price, since Price/Total are now optional
                # upload columns) is skipped here too, and reported the same
                # way as a catalog-unmatched row rather than persisted with
                # a guessed price.
                matched_rows, unpriced_product_names = apply_master_pricing(matched_rows)
                upsert_transaction_statistics(matched_rows)
                insert_raw_transactions(matched_rows, upload_log.upload_id)

        # This attempt's own outcome, not an OR with any prior attempt's -
        # if a previous partial upload's gaps are now fully resolved, this
        # file's dedup should close for good; if new gaps remain, it stays
        # open for another retry. Both catalog-unmatched AND unpriced rows
        # are "gaps" in this sense - either is fixed by editing the Products
        # catalog (adding the product, or setting its master price) and
        # re-uploading the same file.
        upload_log.had_unmatched_rows = bool(unmatched_product_names or unpriced_product_names)

        db.session.commit()
    except Exception:
        db.session.rollback()
        raise

    # 7. Re-mine over the full accumulated dataset and replace Rules/RuleItems,
    # kicked off in the background only after the ingested rows above have
    # already committed - so this request returns as soon as the data itself
    # is safely persisted, instead of blocking on mlxtend (see
    # services.persistence.start_background_remine).
    start_background_remine(current_app._get_current_object())

    # 8. JSON summary. Duplicate rows (already stored, from drop_existing_rows),
    # invalid rows (malformed, from read_and_clean_upload), unmatched-product
    # rows (not in the catalog, from attach_product_ids), and unpriced rows
    # (no resolvable price, from apply_master_pricing) are reported
    # separately so the frontend can state specifically *why* rows were
    # excluded rather than one opaque total. Rule counts are deliberately
    # NOT reported here anymore - mining now happens after this response is
    # sent (see above), so any count taken now would just be the stale
    # pre-upload one.
    return (
        jsonify(
            {
                "rowsProcessed": int(len(matched_rows)),
                "duplicateRowsDropped": int(duplicate_count),
                "invalidRowsDropped": int(rows_dropped),
                "skippedUnmatchedRows": int(len(deduped) - rows_after_matching),
                "unmatchedProductNames": unmatched_product_names,
                "skippedUnpricedRows": int(rows_after_matching - len(matched_rows)),
                "unpricedProductNames": unpriced_product_names,
                "insightsUpdating": True,
            }
        ),
        200,
    )
