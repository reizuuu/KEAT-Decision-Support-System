import hashlib
from datetime import datetime

from flask import Blueprint, current_app, jsonify, request

from models import UploadLog, db
from services.ingest import (
    apply_master_pricing,
    attach_product_ids,
    compute_true_receipt_ids,
    drop_existing_rows,
    insert_raw_transactions,
    upsert_transaction_statistics,
)
from services.parsing import MissingColumnsError, read_and_clean_upload
from services.rules import start_background_remine


upload_bp = Blueprint("upload", __name__)


@upload_bp.post("/api/upload")
def upload_file():
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "Please select a CSV or XLSX file."}), 400

    # a cleanly processed file is rejected, one with skipped rows can be retried
    raw_bytes = file.read()
    file_hash = hashlib.sha256(raw_bytes).hexdigest()
    existing_upload_log = UploadLog.query.filter_by(file_hash=file_hash).first()
    if existing_upload_log is not None and not existing_upload_log.had_unmatched_rows:
        return jsonify({"error": "This file has already been uploaded."}), 400
    file.stream.seek(0)

    try:
        dataframe, rows_dropped = read_and_clean_upload(file)
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
        # dedup compares against the grouped receipt id, so compute it first
        dataframe = compute_true_receipt_ids(dataframe)

        deduped, duplicate_count = drop_existing_rows(dataframe)

        # file_hash is unique, so a retry reuses the earlier log row
        if existing_upload_log is not None:
            upload_log = existing_upload_log
            upload_log.upload_date = datetime.utcnow()
        else:
            upload_log = UploadLog(file_hash=file_hash)
            db.session.add(upload_log)
            db.session.flush()

        matched_rows = deduped
        unmatched_product_names = []
        unpriced_product_names = []
        rows_after_matching = 0
        if not deduped.empty:
            matched_rows, unmatched_product_names = attach_product_ids(deduped)
            rows_after_matching = len(matched_rows)
            if not matched_rows.empty:
                matched_rows, unpriced_product_names = apply_master_pricing(matched_rows)
                upsert_transaction_statistics(matched_rows)
                insert_raw_transactions(matched_rows, upload_log.upload_id)

        upload_log.had_unmatched_rows = bool(unmatched_product_names or unpriced_product_names)

        db.session.commit()
    except Exception:
        db.session.rollback()
        raise

    start_background_remine(current_app._get_current_object())

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
