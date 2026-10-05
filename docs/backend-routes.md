# Backend routes

Every `/api/*` endpoint, grouped by blueprint file. All are JSON in/out and
protected by `@api_login_required` (401 JSON, not a redirect) unless noted.
Page routes (`/`, `/dashboard`, etc.) and the `/favicon.ico` redirect are
documented in [architecture.md](architecture.md#page-routes) instead.

## `routes/auth.py` — blueprint `auth_bp`

### `POST /api/login`
Not protected (this *is* the login endpoint). Body: `{"username", "password"}`
(also accepts form-encoded via `request.form` fallback). Looks up
`UserAccounts` by username, verifies via `check_password_hash`. On success:
`session.clear()`, stores `user_id`, returns `{"username", "role"}`, 200.
On failure: `{"error": "Invalid username or password."}`, 401.

### `POST /api/logout`
Not protected. `session.clear()`, returns `{}`, 200.

### `GET /api/session`
Protected. Returns the current session's `{"username", "role"}`, 200. This
is what every page's `initializeUserHeader()` (in `script.js`) calls on
load to populate the header and decide whether to show the settings gear.

## `routes/products.py` — blueprint `products_api`

### `GET /api/products`
Query params: `category` (repeatable — `?category=A&category=B`). Values of
`"all"` (case-insensitive) or blank are ignored, so no category param, an
empty one, or `category=all` all mean "no filter." When one or more real
category names are given, results are the **union** of products across all
of them (`Category.category_name.in_(...)`).

Always filtered to `Products.is_active == True` — a soft-deleted product
never appears here, which is also what makes it vanish from the Products
page and every Category/Product dropdown (this endpoint backs all of
them). Its historical `RawTransaction` rows are untouched and keep
counting in dashboard totals regardless (see
[backend-services.md](backend-services.md#servicesaggregationpy)) — that's
a completely separate query path.

Joins `Products` → `Category` (inner) and → `RawTransaction` (outer, for
the price fallback). Returns:
```json
{"products": [{"id", "name", "alias", "category", "price"}, ...]}
```
`price` is `Products.price` if set, else the average observed
`RawTransaction.price` for that product, else `0` — rounded to 2 decimals.
Ordered case-insensitively by name.

**Backward compatibility note:** the Products page (`static/js/products.js`)
only ever sends a single `?category=X`, which `request.args.getlist()`
still returns correctly as `["X"]` — the multi-value support added for the
Dashboard's checkbox filter doesn't change that page's behavior.

### `GET /api/categories`
No params. Returns `{"categories": [name, ...]}`, alphabetical. Not
filtered by whether a category has any active products — a category with
zero active products still lists here (this endpoint is intentionally
left alone; only the *product* side of "the catalog" was in scope for the
is_active work).

### `POST /api/products`
Body: `{"product_name", "product_alias"?, "category", "price"?}`.
`product_name`/`category` required (400 if missing). Price is validated by
`_parse_price()` (below). Category is get-or-created
(`services.persistence.get_or_create_category`).

**Duplicate guard**: `product_name` and `product_alias` must each be
unique among **active** products. Before creating or reviving anything,
checks `services.persistence.find_product_by_name_or_alias(name, alias)`
for an existing product — active or not — matching the submitted
name/alias (comparison is via `normalize_alias()`, so e.g. "Iced Tea"
collides with a stored "Iced-Tea" alias too, and matches on name OR alias
either way). If that match is currently **active**, the request is
rejected: `{"error": "A product with this name or alias already exists."}`,
400.

**Revive-on-re-add**: otherwise, if a match is found and it's currently
**inactive**, no new row is created: that row's `is_active` flips back to
`True` and its `product_name`/`product_alias`/`category`/`price` are all
updated to what was just submitted, then it's returned as an **update
(200)**, not a creation. It then reappears everywhere `is_active` is
filtered on, automatically. Otherwise falls through to the normal
create-new path (`product_name` is title-cased, `is_active=True`, **201**).

Either way (revive or create), a successful response kicks off
`services.persistence.start_background_remine()` — see below — before
returning, so the response goes out without waiting for the re-mine.

### `PUT /api/products/<int:product_id>`
404 if the id doesn't exist (not filtered by `is_active` — can still edit
an inactive row directly by id, though nothing in the UI links to one).
Body fields are all optional and only applied if present in the JSON
(partial update): `product_name` (rejected empty), `product_alias`,
`category` (get-or-created, rejected empty), `price` (validated).

**Duplicate guard**: if `product_name` and/or `product_alias` is present
in the body, the resulting name/alias (the submitted value for whichever
field(s) were sent, the product's current value for whichever weren't) is
checked against every *other* active product the same way `POST
/api/products` does (`find_product_by_name_or_alias(..., exclude_product_id
=product_id)`, so the product never collides with its own unchanged
values). A conflict with another active product → `{"error": "A product
with this name or alias already exists."}`, 400.

Returns the updated product, 200. Does **not** trigger a background
remine — renaming/repricing/recategorizing an existing active product
doesn't change which products are mineable (rules are keyed by
`product_id`, and mining reads the catalog's *current* `product_name` at
remine time regardless), so there's nothing here for a re-mine to pick up.

### `DELETE /api/products/<int:product_id>`
404 if missing. **Soft-deletes** — no more 409 for "has history" (that
used to hard-block deletion of any product with `RawTransaction`/`RuleItems`
references; this feature replaces that block entirely):

1. If the product is already `is_active == False`, this is an **idempotent
   no-op** — returns `{"id", "isActive": false}`, 200, without re-running
   anything below (guards a double-click/stale request from redoing rule
   pruning or spinning up a second background remine).
2. Otherwise: sets `is_active = False`.
3. `services.persistence.prune_rules_for_product(product_id)` —
   synchronous, instant structural edit of any `Rules`/`RuleItems` rows
   referencing this product (see [backend-services.md](backend-services.md#prune_rules_for_productproduct_id)).
   Commits together with step 2 as one atomic change.
4. Kicks off `services.persistence.start_background_remine()` (below) —
   the response goes out immediately without waiting on this.
5. Returns `{"id", "isActive": false}`, 200.

Historical `RawTransaction` rows for the product are never touched — the
dashboard's numbers for its past sales don't change. See
[architecture.md](architecture.md) for the full soft-delete/re-mine data
flow.

### `_parse_price(raw_price)` (module-private helper, not a route)
Blank/omitted → `(None, None)` (falls back to the sales-average display).
Non-numeric → `(None, "price must be a number.")`. Negative → `(None,
"price cannot be negative.")`. Otherwise `(float(price), None)`.

### `services.persistence.start_background_remine(app)` / `_remine_rules_in_background(app)`
Shared helper (not route-specific — used by `POST`/`DELETE
/api/products` above and `POST /api/upload` below) that kicks off
`remine_rules()` **on a background daemon thread** and returns
immediately. `_remine_rules_in_background` is the thread target: it pushes
its own `app.app_context()` (from the real Flask app object passed in, not
the `current_app` proxy — a proxy resolves per-request-context and can't
be handed to a different thread) so `remine_rules()`'s `db.session` calls
work safely off the request thread, then commits (or rolls back and logs,
on failure).

## `routes/results.py` — blueprint `results_bp`

Both read endpoints below are cached in memory by `services/cache.py`
(`get_or_build`). An entry is reused until the next database commit (any
write path, including the background remine thread, bumps the cache
generation), so returning to a page is near-instant while data is unchanged.
The first request after a server start or a write rebuilds it.

### `GET /api/results`
Dashboard data. Query params: `start_date`, `end_date` (both `yyyy-mm-dd`),
`category` (repeatable), `product` (repeatable). Cached per filter
combination.

1. `services.persistence.build_transactions_dataframe(start_date, end_date,
   categories, products)` — the **filtered** dataset.
2. If that's empty: returns `{"empty": true}`, 200 (the "no data yet" / "no
   rows match this filter" signal the dashboard checks before rendering
   charts).
3. Otherwise returns `{"dashboard": services.aggregation.build_dashboard_payload(filtered_df)}`, 200.

### `GET /api/analytics`
Analytics page data, always over the **full** accumulated dataset (the
dashboard's filters never apply here). Returns
`build_analytics_browse_payload(count_receipts())` with
`build_rule_bundles_payload()` added as `bundles`:
`{"rulesGenerated", "transactions", "categories", "bundles"}`, 200. Split
from `/api/results` so neither page builds the other's data.

### `GET /api/analytics/status`
`{"hasApproximateRules": bool}` — the cheap poll target for the Analytics
page's "recalculating" badge. Not cached.

See [backend-services.md](backend-services.md) for what's actually inside
each payload.

## `routes/upload.py` — blueprint `upload_bp`

### `POST /api/upload`
Multipart form, field `file`. Full step-by-step pipeline is documented in
[architecture.md](architecture.md#data-flow-file-upload--dashboard); this
is the response-shape/error-case reference:

| Condition | Response |
|---|---|
| No file attached | `{"error": "Please select a CSV or XLSX file."}`, 400 |
| Exact file (by SHA-256) already **fully** processed (`UploadLog.had_unmatched_rows == False`) | `{"error": "This file has already been uploaded."}`, 400 |
| Wrong extension | `{"error": "Only .csv and .xlsx files are supported."}`, 400 |
| Unreadable/corrupt file | `{"error": "Unable to read the uploaded file: <detail>"}`, 400 |
| Missing required column(s) — `Receipt ID`, `Date` (or `Year`/`Month`/`Day`), `Product Name`, `Category`, `Quantity`, `Timestamp`; `Price`/`Total` are optional | `{"error": "Missing required columns: <list>", "missingColumns": [...]}`, 400 |
| No valid rows survive cleaning | `{"error": "The file contains no valid transaction rows."}`, 400 |
| Success | `{"rowsProcessed", "duplicateRowsDropped", "invalidRowsDropped", "skippedUnmatchedRows", "unmatchedProductNames", "skippedUnpricedRows", "unpricedProductNames", "insightsUpdating": true}`, 200 |
| Anything else unhandled | rolls back the whole transaction, re-raises → caught by `app.py`'s global handler → generic 500 JSON |

`rowsProcessed` = rows actually inserted (after invalid-row, duplicate-row,
unmatched-product-row *and* unpriced-row dropping). `duplicateRowsDropped`,
`invalidRowsDropped`, `skippedUnmatchedRows` (with `unmatchedProductNames`
— the distinct raw product names that didn't match any active catalog
product) and `skippedUnpricedRows` (with `unpricedProductNames` — matched
products that have no master price *and* no usable price in the file) are
reported **separately** so the frontend can state specifically why rows
were excluded instead of one opaque total. An unmatched product is
**skipped, not auto-created**, and an unpriced row is **skipped, not
stored with a guessed price** — see `attach_product_ids` and
`apply_master_pricing` in [backend-services.md](backend-services.md).

**Re-mining is asynchronous**: the ingested rows (`UploadLog`,
`RawTransaction`, `TransactionStatistics`) are committed first, and only
*then* does the handler call `services.persistence.start_background_remine()`
(the same helper `routes/products.py` uses — see above) and return. The
response therefore goes out as soon as the raw data is safely persisted,
without waiting for `remine_rules()`/mlxtend to finish — that's what
`"insightsUpdating": true` signals to the frontend (see
`static/js/upload.js`'s success message). There is no `rulesGenerated`
count in the response anymore, since mining hasn't necessarily finished by
the time it's built; a rule count taken here would just be the stale
pre-upload one. The Analytics page always reads the current `Rules` table
fresh on its own request, so it reflects the finished remine once it's
done regardless.

**Re-uploading the same file after fixing a catalog gap:** an upload that
had to skip rows for an unmatched or unpriced product leaves its `UploadLog` row
"open" (`had_unmatched_rows = True`) instead of permanently blocking that
exact file — see the `UploadLog.had_unmatched_rows` entry in
[database-schema.md](database-schema.md#uploadlog-table-upload_log). So
the workflow "upload → 1 row skipped, product not in catalog yet → add
that product (or set its price) → re-upload the *same* file" works: the
second attempt is **not** rejected as a duplicate, `drop_existing_rows`
correctly skips re-inserting whatever already succeeded the first time
(reported as `duplicateRowsDropped`), and only the previously-skipped
row(s) that now resolve get inserted. Once an attempt has no unmatched or
unpriced rows left, that file's dedup closes for good and a further
identical re-upload is rejected as before.

## `routes/users.py` — blueprint `users_api`

Self-service only — there is no "manage any other account" capability in
this app (see [architecture.md](architecture.md#auth-model)).

### `GET /api/users/me`
Returns the caller's own `{"id", "username", "role"}`, resolved via
`current_user()` (i.e. from the session, never from a URL parameter).

### `PUT /api/users/me`
Body: `{"username"?, "password"?}`, both optional. If `username` is given,
checked for a collision against every *other* account (409 if taken).
If `password` is given, it's hashed and stored. Returns the updated
`{"id", "username", "role"}`, 200.

**Why this is scoped the way it is:** the endpoint has no `<user_id>` in
its URL at all — the target account is always `current_user()`, resolved
server-side from the session. This is a deliberate hardening over an
earlier design (`PUT /api/users/<int:user_id>`) where merely relaxing the
decorator to "any logged-in user" without also changing how the target
user was resolved would have let any account edit *any other* account by
changing the id in the URL.
