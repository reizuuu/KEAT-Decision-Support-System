# Database schema — `models.py`

SQLite, accessed through Flask-SQLAlchemy (`db = SQLAlchemy()`). One
`db.Model` class per table. No relationships are declared via `db.relationship()`
anywhere — every join in the codebase is written explicitly in
`services/persistence.py`/`routes/*.py` query code instead.

## `UserAccounts` (table: `user_accounts`)

Login accounts.

| Column | Type | Notes |
|---|---|---|
| `user_id` | `Integer`, PK | |
| `username` | `String(120)`, unique, not null | |
| `password` | `String(255)`, not null | Always a werkzeug password **hash**, never plaintext, despite the plain column name |
| `role` | `String(20)`, not null, default `"user"` | **Legacy/cosmetic column.** Originally gated a `superadmin`-only account-management tier; that tier was removed (see [architecture.md](architecture.md#auth-model)) and nothing reads `role` to make an authorization decision anymore. Kept rather than dropped since removing it isn't required for any current behavior. |

## `UploadLog` (table: `upload_log`)

One row per successfully processed upload — exists purely for the
whole-file dedup check.

| Column | Type | Notes |
|---|---|---|
| `upload_id` | `Integer`, PK | Referenced by `RawTransaction.upload_id` |
| `file_hash` | `String(64)`, unique, not null | SHA-256 hex digest of the raw uploaded bytes — a byte-identical re-upload is rejected before parsing even runs, **unless** `had_unmatched_rows` is `True` (see below) |
| `upload_date` | `DateTime`, not null, default `datetime.utcnow` | Bumped to "now" whenever this row is *reused* by a later re-upload attempt of the same file, not just on first insert |
| `had_unmatched_rows` | `Boolean`, not null, default `False` | `True` when this file's most recent processing attempt had to skip at least one row for not matching any active catalog product, **or** for having no resolvable price (no master price and no usable file price). While `True`, the file-hash dedup check in `routes/upload.py` does **not** block a re-upload of this same file — an incomplete upload isn't "done," and the same file re-uploaded after the catalog is fixed should get a chance to pick up what it missed. A re-upload **reuses this same row** (rather than inserting a second one, which would violate the unique `file_hash` constraint) and recomputes this flag from that attempt's own outcome. See [backend-routes.md](backend-routes.md#post-apiupload) |

## `Category` (table: `category`)

| Column | Type | Notes |
|---|---|---|
| `category_id` | `Integer`, PK | |
| `category_name` | `String(120)`, unique, not null | Get-or-created by the Products page's add/edit flow and by master-catalog seeding (`get_or_create_category`). Uploads never create categories — a matched row uses its product's own category |

## `Products` (table: `products`)

| Column | Type | Notes |
|---|---|---|
| `product_id` | `Integer`, PK | |
| `category_id` | `Integer`, FK → `category.category_id` | |
| `product_name` | `String(255)`, not null | Display name — Title Case, staff-editable |
| `product_alias` | `String(255)`, nullable | The **stable matching key**: preserved raw POS text (normalized via `services/text.normalize_alias`). Uploads match against this, not `product_name`, so renaming a product for display doesn't break re-upload matching |
| `price` | `Numeric(12, 2)`, nullable | The **"Current Master Price"** — staff-editable, and authoritative at upload time (see [backend-services.md](backend-services.md#apply_master_pricingdataframe)): every upload row's `Price`/`Total` is overwritten with whatever this is at the moment of ingestion, then permanently locked into `RawTransaction`. `NULL` until set explicitly or backfilled from sales history — `GET /api/products` falls back to the average observed `RawTransaction.price` for display when this is `NULL`, and an upload row for a product with no master price falls back to the row's own CSV price instead of being rejected |
| `is_active` | `Boolean`, not null, default `True` | Soft-delete flag (see §4/§5/§6 of the catalog feature — [backend-routes.md](backend-routes.md#delete-apiproductsintproduct_id)). `False` means removed from the catalog: it disappears from `GET /api/products`, every Category/Product dropdown, and stops matching future uploads — but its historical `RawTransaction` rows are untouched and keep counting in dashboard totals forever. Dashboard/analytics queries (`services/aggregation.py`, `build_transactions_dataframe`/`build_full_transactions_dataframe`) deliberately never filter on this column |

## `TransactionStatistics` (table: `transaction_statistics`)

Pre-aggregated per-(category, day) rolling totals. (Not currently read by
any endpoint documented here — `services/persistence.upsert_transaction_statistics`
writes to it on every upload, but the dashboard/analytics payloads are
computed directly from `RawTransaction` instead.)

| Column | Type | Notes |
|---|---|---|
| `statistic_id` | `Integer`, PK | |
| `category_id` | `Integer`, FK → `category.category_id` | |
| `year`, `month`, `day` | `Integer`, not null | |
| `total_customers` | `Integer`, default `0` | Unique receipt count for that category+day |
| `total_revenue` | `Numeric(12, 2)`, default `0` | |

Unique constraint: `(category_id, year, month, day)` — one row per
category per calendar day; uploads **add** their delta onto the existing
row rather than replacing it.

## `RawTransaction` (table: `raw_transaction`)

The source of truth — one row per (receipt, product) line item. Everything
the dashboard/analytics compute is derived from this table.

| Column | Type | Notes |
|---|---|---|
| `record_id` | `Integer`, PK | |
| `upload_id` | `Integer`, FK → `upload_log.upload_id`, not null | |
| `receipt_id` | `Integer`, not null | The **grouped** `true_receipt_id` from `compute_true_receipt_ids()`, not the raw per-file receipt id. Resets to 1 per calendar day, not globally — always combine with `year`/`month`/`day` to get a globally-unique receipt |
| `product_id` | `Integer`, FK → `products.product_id`, not null | |
| `month`, `day`, `year` | `Integer`, not null | |
| `timestamp` | `DateTime`, nullable | Optional per-row time-of-day, from the CSV's `Timestamp` column. `NULL` when the source file has none — the hour-of-day chart falls back to an empty state in that case |
| `quantity` | `Numeric(12, 2)`, not null | |
| `price` | `Numeric(12, 2)`, not null | Per-unit price locked in at ingestion: the product's master `Products.price` at that moment, or the file's own price when the product had none. May differ from today's `Products.price` |
| `total` | `Numeric(12, 2)`, not null | Line total — always `price × quantity`, recomputed at ingestion |

## `Rules` (table: `rules`)

One row per mined association rule (market-basket "combo"). Fully
replaced by `services/persistence.remine_rules()` — run in the background
after every upload, product add/revive and product delete — never
incrementally updated (apart from a delete's instant prune, see
`is_approximate` below).

| Column | Type | Notes |
|---|---|---|
| `rule_id` | `Integer`, PK | |
| `support`, `confidence`, `lift`, `leverage`, `conviction` | `Float`, not null | Standard association-rule-mining metrics (see [backend-services.md](backend-services.md#servicesminingpy) for definitions) |
| `is_approximate` | `Boolean`, not null, default `False` | `True` when a product delete's **instant prune** (`services/persistence.prune_rules_for_product`) structurally edited this rule's antecedent/consequent set (removed one of *several* items on a side) without recomputing its metrics for the new, smaller itemset — the stored numbers are stale until the next full remine. Never set on a rule that prune deletes outright (sole antecedent/consequent), and never cleared in place — the next `remine_rules()` just replaces the row with a freshly-computed one |

## `RuleItems` (table: `rule_items`)

The antecedent/consequent product sets for each rule (a rule's antecedent
or consequent can contain more than one product, hence a separate table
rather than columns on `Rules`).

| Column | Type | Notes |
|---|---|---|
| `rule_item_id` | `Integer`, PK | |
| `rule_id` | `Integer`, FK → `rules.rule_id`, not null | |
| `product_id` | `Integer`, FK → `products.product_id`, not null | |
| `side` | `String(20)`, not null | Literally `"antecedent"` or `"consequent"` — not a DB-level enum, just a convention |

---

## Startup migrations — `services/migrations.py`

`db.create_all()` (called once, only when `keat.sqlite3` doesn't exist yet)
never alters a table that already exists. Since this prototype ships with
a pre-existing sqlite file that predates some columns, `run_startup_migrations()`
runs unconditionally on **every** app start to bring an older schema/data
up to date in place, without requiring anyone to delete the database.

### `run_startup_migrations()`

Orchestrates, in order:

1. `_add_column_if_missing(inspector, "products", "product_alias", "VARCHAR(255)")`
2. `_add_column_if_missing(inspector, "products", "price", "NUMERIC(12, 2)")`
3. `_add_column_if_missing(inspector, "user_accounts", "role", "VARCHAR(20)")`
4. `_add_column_if_missing(inspector, "products", "is_active", "BOOLEAN")`
5. `_add_column_if_missing(inspector, "rules", "is_approximate", "BOOLEAN")`
6. `_add_column_if_missing(inspector, "upload_log", "had_unmatched_rows", "BOOLEAN")`
7. `_backfill_product_names_and_aliases()`
8. `_merge_duplicate_products()`
9. `_backfill_user_roles()`
10. `_backfill_product_prices()`
11. `_backfill_product_active_flag()`
12. `_backfill_rule_approximate_flag()`
13. `_backfill_upload_log_unmatched_flag()`
14. `db.session.commit()`

### `_add_column_if_missing(inspector, table_name, column_name, column_type)`

Raw `ALTER TABLE ... ADD COLUMN` via `sqlalchemy.text()`, only if the
column isn't already present per `inspector.get_columns()`. Commits
immediately (SQLite DDL needs its own transaction boundary here).

### `_backfill_product_names_and_aliases()`

For every `Products` row: if `product_alias` is empty, seeds it from the
current `product_name`; always re-title-cases `product_name` via
`to_title_case()` (idempotent — a no-op once already title-cased).

### `_merge_duplicate_products()`

Cleans up products that only ever differed by casing (e.g. `"BT SMASH"`
vs `"BT Smash"`) — a pre-existing-data artifact from before upload
matching was made case-insensitive. Groups products by
their (now title-cased) `product_name`, keeps the oldest row per group as
canonical, and for each duplicate: repoints its `RawTransaction`/`RuleItems`
rows to the canonical product, merges in its `product_alias`/`price` if the
canonical row is missing one, then deletes the duplicate row.

### `_backfill_user_roles()`

Sets `role` to `"user"` for any account where it's `NULL`/empty. `role` is
purely informational (see the `UserAccounts` table above), so this just
gives every account the same default new accounts get — no special-casing.

### `_backfill_product_prices()`

For every `Products` row with `price IS NULL`, seeds it from the average
`RawTransaction.price` observed for that product (the same number
`GET /api/products` was already computing on the fly as a display
fallback) — so upgrading doesn't change what anyone sees, it just makes
the value editable going forward. A product with no sales history yet is
left `NULL` (displays as ₱0.00 until sales or a manual price arrive).

### `_backfill_product_active_flag()` / `_backfill_rule_approximate_flag()` / `_backfill_upload_log_unmatched_flag()`

All three new columns start `NULL` for every pre-existing row (the raw
`ALTER TABLE ADD COLUMN` doesn't enforce a default at the SQLite level).
Every pre-existing product was, by definition, an active one, so
`is_active` backfills to `True`; every pre-existing rule was mined
normally, not structurally patched, so `is_approximate` backfills to
`False`; every pre-existing `UploadLog` row predates the "skip unmatched
products" feature entirely (back when auto-create meant nothing was ever
skipped for a catalog reason), so `had_unmatched_rows` backfills to
`False` regardless of what that upload actually contained.

---

## Startup catalog seeding — `services/persistence.seed_master_catalog_if_empty()`

Runs once per app start, right after `run_startup_migrations()` (see
[architecture.md](architecture.md)) — but unlike migrations, this only
ever *does* something on a from-scratch database. Guarded by
`Products.query.count() == 0` (checked before touching the filesystem at
all) so a populated catalog — including one that's had products
edited since — is never touched by this on a later restart.

If `config.MASTER_CATALOG_DIR` (`instance/master_catalog/`, auto-created
on every boot alongside `instance/` itself) contains `master_catalog.xlsx`
or `master_catalog.csv` (checked in that order via `_find_master_catalog_file()`),
it's read and every row with both a `Product Name` and `Category` becomes
a new `Products` row (via `get_or_create_category` for the category, same
shape as `routes/products.create_product`'s manual flow) — `Product Alias`
defaults to the product name when blank, and is stored through
`normalize_alias()` (unlike the manual create-product flow, which stores
an alias raw) since this alias is the matching key upload rows get
resolved against. `Price` stays `NULL` when blank.

A missing directory, missing file, unreadable file, or a file missing the
required `Product Name`/`Category` columns is **not an error** — each case
is logged (`current_app.logger`) and the function returns, leaving the
app to boot with an empty catalog exactly as it always could before this
feature existed.
