# Backend services

The actual business logic. Routes are thin — nearly everything of substance
lives here.

## `services/auth.py`

| Name | Kind | Purpose |
|---|---|---|
| `SESSION_USER_KEY` | constant, `"user_id"` | The only key this app stores in the Flask session cookie |
| `PUBLIC_ENDPOINTS` | constant | The only endpoints reachable without a session: `index` (login page), `static`, `favicon` (the `/favicon.ico` redirect), `auth.login`, `auth.logout` |
| `enforce_login()` | `before_request` hook | App-wide default-deny: any endpoint not in `PUBLIC_ENDPOINTS` needs a valid logged-in user, otherwise the session is cleared and pages redirect to `/`, `/api/*` calls get 401. Covers routes added later without a decorator |
| `prevent_caching(response)` | `after_request` hook | `Cache-Control: no-store` (+ `Pragma: no-cache`) on everything except static assets, so the Back button can't show a cached page after signing out |
| `login_required(view)` | decorator | Protects **page** routes — redirects to `/` unless `current_user()` resolves. Redundant with `enforce_login`, kept as an explicit marker / second line of defence |
| `api_login_required(view)` | decorator | Protects **API** routes — returns `{"error": "Authentication required."}`, 401, instead of redirecting |
| `current_user()` | function | Returns the logged-in `UserAccounts` row, or `None` — including when the session points at an account that no longer exists. Used anywhere a route needs to know *which* account is making the request (notably `routes/users.py`, to scope self-service edits) |

## `services/text.py`

Two small, pure string helpers, both used by the upload pipeline to keep
product names/matching stable across uploads.

### `to_title_case(name)`
Normalizes whitespace, then title-cases each word **without** mangling
existing hyphens or numerals — splits on `-` and title-cases each
hyphen-part separately (`"iced-tea 16oz"` → `"Iced-Tea 16Oz"`,
`"bbq rice bowl"` → `"Bbq Rice Bowl"`). Used for the **display** name
(`Products.product_name`).

### `normalize_alias(name)`
Strips whitespace, replaces hyphens with spaces, collapses repeated
internal whitespace — so `"Iced-Tea"`, `"iced tea"`, and `" Iced   Tea "`
all normalize to the same key. This (lowercased on top, at the call site)
is the actual **matching** key used to recognize the same product across
different uploads/POS export quirks, stored in `Products.product_alias`.

## `services/parsing.py`

Reads and cleans an uploaded file into a pandas DataFrame the rest of the
pipeline can trust. See [architecture.md](architecture.md#data-flow-file-upload--dashboard)
for where this fits in the overall upload flow.

### Module-level constants

| Name | Purpose |
|---|---|
| `REQUIRED_COLUMNS` | `["Receipt ID", "Date", "Product Name", "Category", "Quantity", "Timestamp"]` — a file must end up with all of these (after renaming) or the upload is rejected |
| `OPTIONAL_COLUMNS` | `["Price", "Total"]` — read and cleaned when present, but a file may omit them: the catalog's master price is authoritative (see `apply_master_pricing`), so they only matter for a product with no master price |
| `COLUMN_RENAME_MAP` / `_COLUMN_RENAME_LOOKUP` | Known column-name variants (`"RECEIPTID"`, `"RECEIPT_ID"`, `"RECEIPT NO"`) mapped to the canonical `"Receipt ID"`, matched case-insensitively |
| `CATEGORY_RENAME_MAP` / `_CATEGORY_RENAME_LOOKUP` | Category values rewritten to a canonical display form before filtering (currently just `"Sandwich"` → `"Burger & Sandwiches"`) |
| `CATEGORY_DROP_LIST` / `_CATEGORY_DROP_SET` | Category values whose rows are dropped outright: `""`, `"0"`, `"Add On"`, `"Beverage"` (blank/NaN-equivalent categories normalize to `""` earlier in cleaning, so that entry covers both) |
| `CUSTOM_AMOUNT_PRODUCT_NAME` | `"CUSTOM AMOUNT"` — rows for this product are dropped (not a real menu item) |
| `STARTING_RECEIPT_ID` | `1` — per-file intermediate renumbering base (see `read_and_clean_upload`) |

### `read_and_clean_upload(file_storage)`
The main entry point. Returns `(cleaned_dataframe, rows_dropped)`. Steps,
in order:

1. **Extension check** — only `.csv`/`.xlsx`; anything else raises
   `ValueError`.
2. **Read** via `pd.read_csv` or `pd.read_excel(engine="openpyxl")`; any
   exception here is wrapped into a `ValueError` with the original message.
3. **Column normalization** — strips column-name whitespace, applies
   `COLUMN_RENAME_MAP`.
4. **Date fallback** — if there's no `Date` column but there are separate
   `Year`/`Month`/`Day` columns, builds `Date` by parsing
   `"<year>-<month>-<day>"` as free-form text (not by coercing each part
   numerically) specifically because `Month` might be a name like
   `"June"` rather than a numeral.
5. Renames only the columns actually recognized as one of
   `REQUIRED_COLUMNS`/`OPTIONAL_COLUMNS` (case-insensitive match) — a
   required column that's still missing after this is left absent and
   caught later.
6. **Dtype coercion**, only for columns present: `Date`/`Timestamp` →
   datetime (`Timestamp` via `_parse_timestamp_value`, see below);
   `Quantity`/`Price`/`Total` → numeric (`errors="coerce"`, so unparseable
   becomes `NaN`); `Receipt ID`/`Product Name`/`Category` → cleaned
   strings (`_clean_str_column`).
7. **Category taxonomy cleanup** — applies `CATEGORY_RENAME_MAP`, then
   drops rows whose (uppercased) category is in `CATEGORY_DROP_SET`.
8. **Custom-amount drop** — drops rows whose `Product Name` is
   `"CUSTOM AMOUNT"`.
9. **Null/empty filtering** — drops rows with a null in any required
   column *except* `Timestamp` (optional `Price`/`Total` aren't checked
   here — a missing price is resolved or reported later by
   `apply_master_pricing`) (a bad/blank Timestamp becomes `NaT` and
   the row survives, since Timestamp is optional-in-spirit despite being
   a required *column*); separately drops rows where `Receipt ID`,
   `Product Name`, or `Category` is an empty string.
10. **Receipt ID renumbering** — on the final surviving row set, assigns
    clean sequential ints starting at `STARTING_RECEIPT_ID`, incrementing
    every time the value changes from the previous row. This is only an
    intermediate per-file grouping key — `services/persistence.compute_true_receipt_ids`
    takes it from here and rebuilds the real persisted id, scoped per
    calendar day.
11. **Required-columns check** — *after* all the above, so a column that
    could have been derived (like `Date`) gets its chance first. Raises
    `MissingColumnsError` listing exactly what's still missing.
12. Returns `(dataframe, original_row_count - len(dataframe))` — the second
    value is what `routes/upload.py` reports as `invalidRowsDropped`.

### `_clean_str_column(series)`
Fills nulls with `""`, casts to `str`, strips whitespace. Used for the
three string columns above.

### `_parse_timestamp_value(value)`
Normalizes a single raw `Timestamp` cell into a `datetime` (or `pd.NaT`):
handles `None`/NaN, an already-`datetime`, a plain `time` (combined with a
dummy date `1900-01-01`), an Excel serial number (`float`/`int`, converted
via the 1900-01-01 epoch), or falls back to `pd.to_datetime(str(value),
format="mixed", errors="coerce")` for anything else.

### `MissingColumnsError(ValueError)`
Carries `.columns` (the list of missing column names) alongside the
standard exception message, so `routes/upload.py` can report them as a
structured `missingColumns` array, not just prose.

## `services/persistence.py`

Every function that talks to the database. Split into two halves by a
comment in the file itself: upload-pipeline helpers, then read-endpoint
helpers.

### Upload pipeline

#### `compute_true_receipt_ids(dataframe)`
Builds the persisted `RawTransaction.receipt_id` ("true_receipt_id"):
contiguous groups of the cleaned per-file `Receipt ID` column, scoped per
`(Year, Month, Day)` and **restarting at 1 for each day** — matching how a
till's own receipt counter resets daily. Restarting per-day (rather than
continuing from whatever's already stored) is deliberate: it's what makes
the id reproducible across uploads, which `drop_existing_rows()` relies on
to detect overlap. Tradeoff (no column exists for the original per-file
receipt id): if two separate uploads each contribute genuinely different
*new* receipts for the same day, their local sequences can collide on the
same `true_receipt_id`, merging them into one "basket" for
mining/statistics purposes.

#### `drop_existing_rows(dataframe)`
Row-level dedup against already-stored `RawTransaction` rows, keyed on
`(receipt_id, normalized+lowercased product alias, day, month, year)`.
Must run *after* `compute_true_receipt_ids()`. Returns
`(deduped_dataframe, duplicate_count)`.

#### `get_or_create_category(name)`
Straightforward get-or-create against `Category.category_name`, with a
`db.session.flush()` so the new row's id is available immediately. No
longer called from the upload pipeline (see `attach_product_ids` below) —
still used by `routes/products.py`'s manual add/edit-product flow and by
`seed_master_catalog_if_empty()`.

#### `find_active_product_by_alias(raw_name)`
**Lookup-only**, no create-on-miss (this replaced the old
`get_or_create_product`, which auto-created an unmatched product). Matches
against `product_alias` (normalized + lowercased), **not** `product_name`
— staff can rename a product for display in a way that no longer matches
the raw POS text, and uploads must still resolve to the same product.
Filters to `is_active == True` only — a soft-deleted product doesn't
silently start accepting new upload rows again just because a later file
happens to reference it; reviving one is only ever done explicitly (see
`routes/products.create_product`'s revive flow).

Why lookup-only now, when it used to auto-create: once the Products table
is a curated, price-authoritative master catalog (see
`apply_master_pricing` below), silently auto-creating a product from a
possibly-mistyped CSV cell would create a priceless, uncategorized ad-hoc
entry — the correct move is to skip the row and report it, not invent a
product.

#### `find_product_by_name_or_alias(name, alias, exclude_product_id=None)`
Looks up an existing product — **active or inactive** — matching the
submitted name/alias, via the same `normalize_alias()`-based comparison,
checked against both the stored `product_name` and `product_alias` (a
manual Products-page entry may not always provide an alias, so
name-to-name is a legitimate match path here, unlike the stricter
alias-only upload matching above). Does a full Python-side scan of every
product rather than a SQL filter, since the comparison needs
`normalize_alias()` applied to the *stored* value too (a plain SQL
`lower()` can't express that) — fine at this app's catalog scale.
`exclude_product_id` skips that one product from the scan, so a product
being edited never collides with its own unchanged name/alias.

Used by `routes/products.create_product`'s duplicate-active-product guard
and revive-on-re-add flow, and by `update_product`'s duplicate guard (with
`exclude_product_id` set to the product being edited) — together these
enforce that `product_name`/`product_alias` are unique among active
products.

#### `attach_product_ids(dataframe)`
Resolves each row's `ProductId`/`CategoryId` via lookup-only matching
against active products (`find_active_product_by_alias`) — no
get-or-create fallback. A matched row's `CategoryId` comes from the
*matched product's own category*, not the upload's raw `Category` column
— once a product is in the catalog, the catalog's category is
authoritative (the same way `apply_master_pricing` makes the catalog's
price authoritative), so the CSV's own Category value is effectively
vestigial for a matched row.

Returns `(matched_dataframe, unmatched_product_names)` — the second is the
sorted, deduplicated list of raw `"Product Name"` values that didn't match
any active product. `routes/upload.py` reports these back to the caller
(`skippedUnmatchedRows`/`unmatchedProductNames`) instead of silently
dropping them, and the frontend lists them explicitly with a note to add
them to the catalog and re-upload.

#### `apply_master_pricing(dataframe)`
Returns `(priced_dataframe, unpriced_product_names)`. Overwrites each
already-matched row's `Price` with the matched product's **current**
`Products.price`, then recomputes `Total = Price × Quantity` for every row — the "Current Master Price" —
captured once at the moment of ingestion and permanently locked into
`RawTransaction` from then on. A later price edit on the Products page
must never retroactively change historical `RawTransaction`/
`TransactionStatistics` rows; this holds simply by construction, since
nothing anywhere re-touches an already-inserted row's price.

**Decision, documented per the spec that introduced this** (not guessed
silently): the master price is **always authoritative** once a product has
one set, overriding whatever the uploaded file's own Price/Total columns
said — "Current Master Price active at the exact moment of ingestion" is
what "master" means here. The file's own Price/Total are vestigial for a
fully-priced catalog, which is why they're **optional** upload columns
(`services/parsing.OPTIONAL_COLUMNS`).

**Fallback**: a product whose `Products.price` is still `NULL` (never
priced) keeps the row's own CSV price instead of the row being rejected —
the least disruptive default, consistent with how `GET /api/products`
already falls back to a sales-average display price for the same case.

**Unpriced rows**: if there's no master price *and* no usable file price
(the file has no `Price` column, or the cell is blank/non-numeric), the row
is dropped and its product name returned in `unpriced_product_names` —
`routes/upload.py` reports these as `skippedUnpricedRows`/
`unpricedProductNames` and keeps the file open for re-upload, the same
"skip and report" treatment unmatched rows get.

#### `upsert_transaction_statistics(dataframe)`
Groups by `(CategoryId, Year, Month, Day)`; for each group, **adds** the
delta (`unique receipt count`, `revenue sum`) onto any existing
`TransactionStatistics` row for that key, or creates one. Adding (not
replacing) is correct because row-level dedup has already removed
anything already reflected in a prior upload — remaining rows are
strictly new activity.

#### `insert_raw_transactions(dataframe, upload_id)`
Bulk-inserts one `RawTransaction` per surviving row
(`db.session.bulk_save_objects`), converting numeric columns to `Decimal`
and the optional `Timestamp` to a native `datetime` (or `None`).

#### `count_receipts()`
Number of distinct receipts (year/month/day/receipt_id), counted in SQL.
Same figure as `build_full_transactions_dataframe()["Receipt ID"].nunique()`
without loading every row; used for the Analytics page's Transactions box.

#### `build_full_transactions_dataframe()`
Every `RawTransaction` row joined to `Products`, reshaped into the
`(Receipt ID, Product Name)` contract `services/mining.py` expects — the
globally-unique `Receipt ID` here is composed from
`year-month-day-receipt_id`, since `receipt_id` alone only resets daily.
Also returns a `product_name → product_id` lookup dict, used to persist
`RuleItems`. Used by `remine_rules()` and (unfiltered) by the Analytics
transaction count.

#### `replace_rules(rules_dataframe, product_id_by_name)`
Wipes `RuleItems` and `Rules` entirely, then inserts the freshly-mined
set (if any). Always a full replace, never incremental. (This is also what
implicitly clears every `Rules.is_approximate` flag after a background
remine — the old approximate rows are gone, replaced by freshly-mined
ones, so there's no separate "clear the flag" step anywhere.)

#### `remine_rules()`
Re-mines over the **full accumulated dataset** (via
`build_full_transactions_dataframe()`, not just the just-uploaded file)
and calls `replace_rules()` — so recommendations always reflect everything
ever ingested, not only the latest change. Called (always via
`start_background_remine()`, below) after every upload, every product
add/revive, and every product soft-delete.

Deliberately asymmetric with the dashboard: a soft-deleted product's past
transactions still count everywhere in dashboard totals (the shared
dataframe-building functions below never filter on `is_active`), but
they're excluded from what gets fed into `compute_rules()` **here** —
filtered at this call site (via a `Products.query.filter_by(is_active=True)`
name set) rather than inside `build_full_transactions_dataframe()` itself,
since that function is also used, unfiltered on purpose, for the analytics
transaction count.

#### `start_background_remine(app)` / `_remine_rules_in_background(app)`
Shared helper that fires `remine_rules()` on a **background daemon
thread** and returns immediately, so none of its three call sites
(`routes/upload.upload_file`, `routes/products.create_product`,
`routes/products.delete_product`) block their HTTP response on mlxtend.
`_remine_rules_in_background` is the actual thread target: since a
background thread can't reuse the request's Flask-SQLAlchemy session, it
pushes its own `app.app_context()` — from the *real* Flask app object the
caller passes in (`current_app._get_current_object()`), not the
`current_app` proxy, which only resolves inside a request/app context and
can't be handed across threads — then calls `remine_rules()` and commits.
On any exception it rolls back and logs instead of raising, since there's
no caller left (by the time this runs, the triggering request has already
responded) to propagate a failure to.

#### `prune_rules_for_product(product_id)`
The **synchronous, instant** half of product deletion (the background
remine above is the other half) — a structural edit of the *existing*
`Rules`/`RuleItems` rows, not a re-mine. Does not commit; the caller
controls the transaction boundary. For every rule referencing
`product_id`:
- it's the **sole antecedent or sole consequent** → delete the whole rule
  (cascading its `RuleItems`) — there's no meaningful rule left without
  that side.
- it's one of **several** items on whichever side it's on → delete just
  that one `RuleItems` row, leave the rest of the set intact, and set
  `Rules.is_approximate = True` — its stored metrics were computed for the
  original, now-changed itemset and are stale until the background remine
  recomputes them from scratch. A rule deleted outright is never flagged —
  it's just gone.

Called from `routes/products.delete_product`, in the same transaction as
flipping `is_active = False`.

### Read-endpoint helpers

#### `build_transactions_dataframe(start_date=None, end_date=None, categories=None, products=None)`
Builds the dataframe `services/aggregation.py` expects
(`Receipt ID, Date, Product Name, Category, Quantity, Price, Total`, plus
`Timestamp` when present), scoped to what the Dashboard's filters ask for.
`categories`/`products` are pushed down into the SQL join (`.in_(...)`,
empty/`None` = no filter on that dimension); `start_date`/`end_date` are
applied afterward against the constructed `Date` column, since a requested
range doesn't necessarily align to whole months.

#### `build_analytics_browse_payload(transaction_count)`
Builds the category → antecedent-product → rule-row structure the
Analytics page's Level 1/2/3 drill-down renders directly from, computed
from the **persisted** `Rules`/`RuleItems` tables (mining happens at
upload time and, in the background, after a product delete — see
`remine_rules`/`prune_rules_for_product` above — this function itself
never re-mines, only reads). A multi-item-antecedent rule is attributed to
*every* product in its antecedent set (falls naturally out of looping per
antecedent product id) — which is also why a product's Level 2
"N combos found" count and its Level 3 row count are guaranteed equal:
both are read from the same underlying rows list, so there's no separate
counting logic that could drift. A category only appears in the output if
one of its products is some rule's antecedent — there's no separate "show
empty categories" filter; it falls out of how the structure is built.
Each row also carries `isApproximate` (straight from `Rules.is_approximate`)
so the frontend can mark a confidence value as pending-remine.

#### `build_rule_bundles_payload()`
The flat "Product Bundles" table data — one row per persisted rule,
formatted as `"antecedent, antecedent → consequent, consequent"` plus its
five metrics and `isApproximate`. Sourced from the DB, not by re-running
`compute_rules()`. Rows are scored and ordered by `mining.rank_rules()` (on
the raw, unrounded metrics) before being made JSON-safe, so each also
carries `score` and `rank`.

#### `rank_rules(rules)` (`services/mining.py`)
Weighted composite ranking. Each of support/confidence/lift/leverage/
conviction is Min-Max scaled to 0–1 across the current pool, weighted 0.20,
and summed into `score`. Infinite conviction is first capped at the pool's
largest finite conviction; a metric whose min equals its max is skipped
(contributes 0) to avoid dividing by zero. Sorted by score descending, exact
ties broken by raw leverage → lift → conviction → support → confidence
(highest first), then numbered 1..N as `rank`.

#### `_safe_number(value)` (private)
Converts a rule metric to a JSON-safe float, or `None` if it's `NaN`/`inf`
(e.g. `conviction` is mathematically infinite whenever confidence is
exactly 1.0 — Python's `json` module would otherwise emit the
non-standard `Infinity` token, which browsers reject).

### Startup catalog seeding

#### `seed_master_catalog_if_empty()`
Called once from `app.py`'s `create_app()`, right after
`run_startup_migrations()`. Bulk-populates `Category`/`Products` from an
optional master catalog file — a bulk version of what
`routes/products.create_product` already does per-row, reusing
`get_or_create_category` rather than a parallel path.

Guarded by `Products.query.count() == 0`, checked *before* touching the
filesystem — the one thing that keeps a populated (or since-edited)
database from ever being touched by this on a later restart. Looks for
`master_catalog.xlsx` then `master_catalog.csv` in `config.MASTER_CATALOG_DIR`
(`_find_master_catalog_file()`); a missing directory/file, an unreadable
file, or one missing the required `Product Name`/`Category` columns is
logged and skipped, not an error — this is an optional from-scratch
bootstrap, not a hard requirement to run the app.

Per catalog row: `Product Name` is title-cased (`to_title_case`) like every
other stored name, and `Product Alias` is normalized via `normalize_alias()`
before storing (unlike `create_product`'s manual flow, which stores an
alias raw) — deliberately, since this alias is the matching key upload
rows get resolved against later (`find_active_product_by_alias`), so it
has to already be in the same normalized form that lookup compares
against, regardless of how the catalog file happened to format it. Falls
back to the (also-normalized) product name when the row leaves alias
blank. `Price` stays `NULL` when blank — same "unset until sales data or a
manual edit arrives" convention as everywhere else.

#### `_find_master_catalog_file()` (private)
Returns the first of `master_catalog.xlsx`/`master_catalog.csv` that
exists in `config.MASTER_CATALOG_DIR`, or `None`.

## `services/aggregation.py`

### `build_dashboard_payload(dataframe)`
Takes the already-filtered dataframe from `build_transactions_dataframe()`
and computes **everything** the Dashboard page displays, in one pass.
Deliberately has no concept of `Products.is_active` — a soft-deleted
product's historical sales count here exactly as before deletion, since
this operates purely on already-persisted `RawTransaction` rows and never
joins against the "is this product still in the catalog" question. Only
*listing* the catalog (dropdowns, the Products page, upload matching)
filters on `is_active`; nothing that computes a historical number does:

- `totalRevenue`, `totalTransactions`
- `averageProductsPerTransaction` = total quantity sold ÷ total
  transactions (0 if there are no transactions) — the raw item-count
  average (the frontend buckets this into a display range; see
  `formatAverageProductsRange` in [frontend.md](frontend.md))
- `averageSalesPerTransaction` = total revenue ÷ total transactions (same
  zero-transaction guard) — the currency counterpart of the above
- `orderSummary` — monthly order (unique receipt) counts, for the
  "Transaction Volume per Month" line chart
- `bestSelling` — top 10 products by quantity sold
- `transactionVolume` — one dataset per category, quantity sold per month
  (clustered bar chart)
- `revenueByCategory` — revenue sum per category, sorted descending
- `monthlySalesTrend` — revenue per month (line chart)
- `topProductsMonthly` — one dataset per (top 10) product, quantity sold
  per month
- `transactionsByDayOfWeek` — unique receipt count per weekday
  (Monday-first)
- `transactionsByHour` — unique receipt count per hour of day, plus
  `hasTimeData`: `True` when the `Timestamp` column has at least one
  non-null value; otherwise the hours fall back to `Date`'s hour and the
  flag is `True` only if any of those hours is non-zero (in practice
  `False`, since the dataframe's `Date` is built from year/month/day with
  no time component)

A filter that restricts to specific products still produces meaningful
(not hidden/disabled) stats — e.g. `averageProductsPerTransaction` under a
product filter reads as "average quantity of the checked product(s) per
transaction they appear in," since filtering happens once, upstream, in
`build_transactions_dataframe()`, and every stat here is computed over
whatever dataframe it's handed.

### `_number(value)` (private)
Converts to `float`, returns `None` for `NaN`/`inf` (same JSON-safety
reasoning as `persistence._safe_number`), and returns an `int` instead of
a `float` when the value is a whole number (so `"totalTransactions": 42`
prints as `42`, not `42.0`).

## `services/cache.py`

In-memory cache for the two read-only payloads, `GET /api/results` and
`GET /api/analytics`. Both only change when the database does, and
rebuilding the dashboard payload loads every `RawTransaction` row, so the
result is reused until the next write.

- **Invalidation by generation:** a SQLAlchemy `after_commit` listener
  (`_bump_generation`) increments a counter and clears every entry on
  *any* committed session — routes, the background remine thread, startup
  migrations — so no write path has to remember to clear the cache. An
  entry is only served if it was built under the current generation; one
  built while a commit landed mid-build is never served.
- **`get_or_build(key, build)`** — returns the cached value for `key`, or
  calls `build()` (outside the lock, so a slow build doesn't block other
  requests) and stores it. The returned value is shared between requests
  and must not be mutated.
- **`_MAX_ENTRIES = 32`** — distinct entries kept (LRU via `OrderedDict`),
  enough for many dashboard filter combinations.
- **Process-local:** fine for this single-process Flask app; under a
  multi-worker server each worker would only see its own commits.

## `services/mining.py`

Market-basket analysis via `mlxtend`'s FP-Growth implementation.

### `_ASSOCIATION_RULES_PARAMS` (module-level)
`inspect.signature(association_rules).parameters` — inspected once at
import time to detect whether the installed `mlxtend` version's
`association_rules()` requires (or even accepts) an explicit
`num_itemsets` argument, since that changed across `0.23.x` point
releases. Avoids hardcoding a version check.

### `compute_rules(dataframe)`
Input: a `(Receipt ID, Product Name)` dataframe (from
`build_full_transactions_dataframe()`). Returns
`(rules_dataframe, transaction_count)`.

1. Groups by `Receipt ID`, collapses each receipt to a sorted set of
   distinct product names — one "transaction" (basket) per receipt.
2. Empty input → `(empty DataFrame, 0)`.
3. One-hot encodes via `TransactionEncoder`.
4. `fpgrowth(..., min_support=MIN_SUPPORT, use_colnames=True)` to find
   frequent itemsets (no itemset-length cap) (FP-Growth builds a compact FP-tree instead of
   Apriori's repeated candidate-generation-and-pruning passes — same
   inputs/outputs contract as `apriori()`, just faster on larger datasets).
5. Empty itemsets → `(empty DataFrame, transaction_count)`.
6. `association_rules(itemsets, metric="lift", min_threshold=MIN_LIFT)`
   (with `num_itemsets` added to the kwargs only if the installed
   `mlxtend` signature accepts it).
7. **Final actionable-rule filter** (hardcoded thresholds, separate from
   the config constants): `lift >= 2 AND leverage >= 0.0015 AND
   conviction >= 1.05`. There is no extra support floor beyond
   `MIN_SUPPORT`, and `config.MIN_CONFIDENCE` (`0.2`) is defined but never
   imported — confidence isn't part of the filter.

No minimum basket size is applied: a receipt left with a single active
item (e.g. after `remine_rules` excludes inactive products) can't produce a
rule itself but still counts in the transaction total, so support and
confidence reflect every real transaction.

The returned dataframe's `antecedents`/`consequents` columns are
`frozenset`s of product names (mlxtend's native format) — callers format
these for display (`build_analytics_payload`) or persist them
(`services/persistence.replace_rules`, via `remine_rules`).

### `build_analytics_payload(dataframe)`
**Currently dead code** — not called from any route in this codebase
(`routes/results.py` builds its analytics payload from the persisted
`Rules`/`RuleItems` tables via `services/persistence.py` instead, per the
comment in `build_rule_bundles_payload`). Kept for reference/possible
reuse: given a dataframe, calls `compute_rules()` directly (re-mining on
the spot rather than reading persisted rules) and shapes the result into
`{"rulesGenerated", "transactions", "productBundles", "topPairings"}` —
`productBundles` mirrors every rule, `topPairings` is the subset with
exactly one antecedent and one consequent product.

### `_number(value)` (private)
Same `NaN`/`inf` → `None` JSON-safety helper as elsewhere, duplicated in
this file rather than imported.
