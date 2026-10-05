# Architecture

Keat is a single Flask app. `app.py` builds it in `create_app()`, which also runs startup
work inside an app context: it creates the database file if it's missing, runs the column
migrations in `services/migrations.py`, and seeds the catalog from the master catalog file
when there are no products yet. The pages (`/dashboard`, `/analytics`, `/products`,
`/upload`) are plain templates. Everything they show comes from the JSON endpoints in
`routes/`, which the page scripts in `static/js/` call with `fetch`.

```
browser ── page (template) ── static/js/<page>.js ──fetch──> routes/*.py ──> services/*.py ──> SQLite
```

## Auth

Login stores the user id in Flask's signed session cookie. `services/auth.enforce_login`
runs before every request and lets through only the login page, static files and the
login/logout calls. Anything else gets a redirect to `/` for pages, or a 401 JSON error for
`/api/` routes. The frontend wraps `fetch` so any 401 sends the user back to the login page.
Responses other than static files are sent with `Cache-Control: no-store`, so the back
button can't show a page after sign out.

Passwords are stored as werkzeug hashes. There are no roles in practice: the `role` column
still exists but every account is `user` and can only edit itself.

## Upload pipeline

`POST /api/upload` (`routes/upload.py`) goes through these steps:

1. Hash the file. If the same file was already processed without problems, reject it.
2. `services/parsing.read_and_clean_upload` reads the CSV/XLSX, normalizes column names,
   applies the category cleanup rules, drops incomplete rows and renumbers receipts within
   the file.
3. `compute_true_receipt_ids` numbers receipts per day, starting at 1. Re-uploading the same
   day gives the same ids, which is what makes row-level dedup work. The downside is that
   two different files for the same day can produce colliding ids.
4. `drop_existing_rows` removes rows already stored, keyed on receipt id, product alias and
   date.
5. `attach_product_ids` matches rows to active products by normalized alias. Unknown
   products are skipped and reported.
6. `apply_master_pricing` sets each row's price from the product's master price, or the
   file's price if the product has none. Rows with no price at all are skipped. The price
   is fixed at this point, and later price edits don't change stored rows.
7. Rows are written to `raw_transaction`, daily totals to `transaction_statistics`, and the
   upload is logged in `upload_log`. All of it happens in one transaction.

If any rows were skipped, the upload log is marked so the same file can be uploaded again
once the catalog is fixed. Row dedup keeps the retry from inserting anything twice.

## Rules

Rules are mined over all stored transactions, not just the latest upload, and stored in
`rules` / `rule_items`. `services/rules.remine_rules` builds baskets keyed on date plus
receipt id, leaves out inactive products, and calls `services/mining.compute_rules`. That
runs FP-Growth with `MIN_SUPPORT`, then keeps rules that pass `MIN_LIFT`, `MIN_LEVERAGE`
and `MIN_CONVICTION` from `config.py`.

Re-mining is slow, so it runs on a background thread (`start_background_remine`) after an
upload, a new product or a revived product. The thread pushes its own app context.
Deleting a product is a soft delete (`is_active = False`). Its past sales still count on the
dashboard, but it's pruned from the stored rules right away: a rule where it was the only
item on one side is deleted, and other rules lose that item and get flagged
`is_approximate`. The analytics page shows those as approximate and polls
`/api/analytics/status` until the background re-mine replaces them.

For the bundles table, `services/mining.rank_rules` min-max scales support, confidence,
lift, leverage and conviction, sums them with equal weights, and sorts. Conviction can be
infinite, so it's capped for ranking and sent as `null` in JSON.

## Reads and caching

`GET /api/results` loads the filtered transactions into a dataframe
(`services/queries.build_transactions_dataframe`), then `services/aggregation` computes the
dashboard numbers. `GET /api/analytics` builds the browse tree and the ranked bundles from
the stored rules. Neither one mines anything.

Both responses are cached in memory (`services/cache.py`). A SQLAlchemy `after_commit` hook
bumps a counter and clears the cache on every commit, so any write, including the
background re-mine, invalidates it. This only works with a single process.

## Frontend

There's no framework and no build step. `static/js/script.js` is loaded on every page and
holds the shared pieces: login, the session guard, modals, notifications, number
formatting, `escapeHtml` and the print report helpers. Each page then loads its own script.
The dashboard's printed report is built in `dashboard-report.js` as HTML with inline SVG
charts, rendered into a hidden `#printReport` element and printed from there.
