# Architecture

## `config.py`

Static configuration, read once at import time — no environment-specific
logic beyond one `os.environ.get` fallback.

| Name | Value | Purpose |
|---|---|---|
| `BASE_DIR` | directory containing `config.py` | Root for building absolute paths |
| `INSTANCE_DIR` | `<BASE_DIR>/instance` | Where the SQLite file lives |
| `DATABASE_PATH` | `<INSTANCE_DIR>/keat.sqlite3` | Absolute path to the DB file |
| `DATABASE_URI` | `sqlite:///<DATABASE_PATH>` | Passed to `SQLALCHEMY_DATABASE_URI` |
| `MAX_CONTENT_LENGTH` | `50 * 1024 * 1024` (50 MB) | Flask's hard cap on request body size — enforced before any upload route code runs |
| `SECRET_KEY` | `KEAT_SECRET_KEY` env var, else a hardcoded dev default | Signs the Flask session cookie |
| `MIN_CONFIDENCE` | `0.2` | Defined but not imported anywhere — confidence isn't part of the rule filter (see `compute_rules` in [backend-services.md](backend-services.md#compute_rulesdataframe)) |
| `MIN_SUPPORT` | `0.003` | Minimum support passed to `fpgrowth()` |
| `MIN_LIFT` | `1.2` | The `association_rules()` lift threshold. The final actionable-rule filter in `compute_rules` uses its own, stricter hardcoded `lift >= 2` |
| `MASTER_CATALOG_DIR` | `<INSTANCE_DIR>/master_catalog` | Scanned once at startup for an optional `master_catalog.xlsx`/`.csv` file to bulk-seed `Category`/`Products` from — see `services/persistence.seed_master_catalog_if_empty()`. Auto-created (empty) alongside `instance/` on every boot (see `create_app()` below) so the drop-a-file-in location always exists; a missing *file* inside it is still not an error |

## `app.py` — the application factory

### `create_app()`

Builds and returns the configured Flask `app`:

1. Creates the Flask instance with `template_folder="templates"` and
   `static_folder="static"`.
2. Applies the four config values above (`SQLALCHEMY_DATABASE_URI`,
   `SQLALCHEMY_TRACK_MODIFICATIONS=False`, `MAX_CONTENT_LENGTH`,
   `SECRET_KEY`) and calls `db.init_app(app)`.
3. Inside `app.app_context()`, before serving any request:
   - Ensures `instance/` and `instance/master_catalog/` both exist
     (`os.makedirs(..., exist_ok=True)`).
   - If `keat.sqlite3` doesn't exist yet, calls `db.create_all()` — this is
     the **only** path that creates the schema from scratch, and it only
     fires once, on a brand-new database file.
   - Always calls `run_startup_migrations()` (see
     [database-schema.md](database-schema.md)) — this is what brings an
     *existing* pre-upgrade database up to date, since `create_all()` never
     alters a table that already exists.
   - Always calls `services/persistence.seed_master_catalog_if_empty()` —
     but it only actually does anything the first time, on a
     product-count-zero database (see
     [database-schema.md](database-schema.md#startup-catalog-seeding---servicespersistenceseed_master_catalog_if_empty)).
4. Registers all five blueprints: `auth_bp`, `upload_bp`, `results_bp`,
   `products_bp`, `users_bp`.
5. Registers the `enforce_login` (`before_request`) and `prevent_caching`
   (`after_request`) hooks from `services/auth.py`.
6. Registers two error handlers (see below).
7. Registers the `/favicon.ico` redirect and the five page routes (`/`,
   `/dashboard`, `/analytics`, `/products`, `/upload`).
8. Registers the `create-admin`/`create-user` CLI commands.
9. Returns `app`.

The module then does `app = create_app()` at import time, so `flask run`
and `python app.py` both work without extra wiring.

### Error handlers

- **`@app.errorhandler(413)` → `request_entity_too_large`**: returns
  `{"error": "File size exceeds the 50 MB limit."}`, 413. Registered
  *specifically* for 413 so it takes precedence over the generic handler
  below.
- **`@app.errorhandler(Exception)` → `handle_unexpected_error`**:
  - If the raised error is a Werkzeug `HTTPException` (404, 405, etc. —
    anything Flask/Werkzeug raises for routing-level problems), it's
    **re-raised as-is**, which means Flask/Werkzeug renders its own default
    **HTML** error page. This is the one gap in the "API routes always
    return JSON" guarantee: a `fetch()` call that hits a nonexistent or
    wrong-method `/api/...` URL gets an HTML body back, and
    `await response.json()` on the frontend throws a browser-level
    `SyntaxError` ("Unexpected token '<' ... is not valid JSON").
  - Otherwise, if the request path starts with `/api/`, it logs the full
    traceback and returns `{"error": "Something went wrong processing your
    request."}`, 500 — this is what keeps a genuine unhandled exception
    (a bug, not a routing mismatch) from ever reaching the frontend as an
    HTML page.
  - Otherwise (a non-API page route with a genuine unhandled exception),
    it re-raises, letting Flask's normal debug/error behavior handle it.

### Page routes

Every page except `/` is protected by `@login_required` and the app-wide
`enforce_login` guard (redirect-based, not JSON — see `services/auth.py`).
Each just renders its template with no server-side data injected; all real
data loading happens client-side via the `/api/*` endpoints.

| Route | Template |
|---|---|
| `GET /favicon.ico` | No template — a redirect to `static/assets/favicons/favicon.ico`, for browsers that request the root path on their own regardless of the `<link rel="icon">` tags. Public (endpoint `favicon` is in `PUBLIC_ENDPOINTS`) |
| `GET /` | `index.html` (login page, public; an already-logged-in user is redirected to `/dashboard`) |
| `GET /dashboard` | `dashboard.html` |
| `GET /analytics` | `analytics.html` |
| `GET /products` | `products.html` |
| `GET /upload` | `upload.html` |

### CLI commands

`create-admin` and `create-user` are functionally identical — both call
`_create_account(username, password, role="user", label="admin")`. They
exist as two names only because either might already be muscle-memory /
in a setup script; `role` no longer gates any permission (see
[database-schema.md](database-schema.md#user_accounts)).

**`_create_account(username, password, role, label)`** — module-level
helper (not a CLI command itself): no-ops with a message if the username
already exists, otherwise inserts a new `UserAccounts` row with a hashed
password (`generate_password_hash`) and prints a confirmation.

## Auth model

- **Session-based**, not token-based: `services/auth.py`'s
  `SESSION_USER_KEY = "user_id"` is the only thing stored in the signed
  Flask session cookie.
- **Default-deny:** `enforce_login` (an app-wide `before_request` hook in
  services/auth.py) requires a valid logged-in user for every endpoint
  except `PUBLIC_ENDPOINTS` (login page, static files, the `/favicon.ico`
  redirect, login/logout). So
  typing a page or API URL directly while logged out never works, including
  for routes added later. Pages redirect to `/`; `/api/*` returns `401` JSON.
- `login_required` / `api_login_required` decorators repeat the same check
  per route as a second line of defence.
- `current_user()` resolves the session's `user_id` to a `UserAccounts` row
  (or `None`). A session pointing at an account that no longer exists counts
  as logged out and is cleared.
- `prevent_caching` (`after_request`) sends `Cache-Control: no-store` on
  pages and API responses, so after signing out the Back button can't show
  a cached page. On the client, `script.js` also reloads any page restored
  from the back/forward cache, and sends the user to the login page when an
  API call returns 401 (session ended while the page was open).
- There is no "forgot password" flow; passwords are changed by a logged-in
  user via the settings modal (`PUT /api/users/me`); a locked-out admin
  can create a new account with the `create-admin` CLI.
- There is no separate permission tier anymore (the former
  `superadmin_required` was removed) — every authenticated account can
  view and change only its **own** credentials, via `PUT /api/users/me`,
  which resolves the target user server-side from the session rather than
  trusting any id in the request. See
  [backend-routes.md](backend-routes.md#usersapi) for why that scoping
  matters.

## Data flow: file upload → dashboard

This is the app's core pipeline, spanning `routes/upload.py`,
`services/parsing.py`, and `services/persistence.py`:

```
Browser (upload.js)
  │  POST /api/upload  (multipart/form-data, field "file")
  ▼
routes/upload.py: upload_file()
  1. Validate a file was actually attached.
  2. SHA-256 the raw bytes → reject if UploadLog already has this hash
     (whole-file dedup, before pandas even runs).
  3. services/parsing.read_and_clean_upload(file)
       - reads CSV/XLSX into a pandas DataFrame
       - normalizes column names/aliases, derives Date from Year/Month/Day
         if needed, coerces dtypes (Price/Total are optional columns)
       - cleans/filters rows (drops nulls, blanks, "CUSTOM AMOUNT" products,
         excluded categories), renumbers Receipt ID
       - raises MissingColumnsError / ValueError on structural problems
  4. Reject if the cleaned dataframe is empty.
  5. services/persistence.compute_true_receipt_ids(df)
       - groups rows into per-day "true" receipts (POS receipt counters
         reset daily; this reproduces that per (Year, Month, Day))
  6. services/persistence.drop_existing_rows(df)
       - row-level dedup against what's already stored, keyed on
         (receipt_id, normalized product alias, day, month, year)
  7. Inside one DB transaction:
       - insert an UploadLog row (captures upload_id)
       - services/persistence.attach_product_ids(df)
           - LOOKUP-ONLY match against ACTIVE catalog products by alias -
             no auto-create anymore. Splits into (matched_df,
             unmatched_product_names); a matched row's category comes from
             the matched Products row itself, not the CSV's own Category
             column
       - if any rows matched:
           - services/persistence.apply_master_pricing(matched_df)
               - overwrites Price with each product's CURRENT
                 Products.price (falls back to the CSV's own price only
                 when Products.price is NULL) and recomputes
                 Total = Price x Quantity - locked in permanently once
                 written below
               - a row with no resolvable price (no master price and no
                 file price) is skipped and its product name reported,
                 the same way an unmatched row is
           - services/persistence.upsert_transaction_statistics(matched_df)
               - adds this file's deltas onto existing (category, day) totals
           - services/persistence.insert_raw_transactions(matched_df, upload_id)
               - bulk-inserts one RawTransaction row per matched row
       - mark the UploadLog row had_unmatched_rows if any row was
         skipped as unmatched OR unpriced (so the same file can be
         re-uploaded after fixing the catalog)
       - commit (or roll back everything on any exception)
  8. services/persistence.start_background_remine() - kicks off
     remine_rules() on a background daemon thread (re-mines over the FULL
     accumulated dataset, not just this file, EXCLUDING soft-deleted
     products' transactions, and replaces Rules/RuleItems) and returns
     immediately - the request does NOT wait for this to finish.
  9. Return a JSON summary: rowsProcessed, duplicateRowsDropped,
     invalidRowsDropped, skippedUnmatchedRows, unmatchedProductNames,
     skippedUnpricedRows, unpricedProductNames, insightsUpdating: true.
```

The same `start_background_remine()` helper also fires after `POST`/`DELETE
/api/products` (a product added/revived or soft-deleted), so every
operation that can change what's mineable - a new dataset, a new/revived
product, or a deleted one - triggers a full re-mine, always off the
request thread. See [backend-routes.md](backend-routes.md) for the
per-route detail, including the `product_name`/`product_alias` uniqueness
guard `POST`/`PUT /api/products` now enforce against active products.

A row whose product isn't in the (active) catalog is **skipped and
reported**, not auto-created — see
[backend-services.md](backend-services.md#attach_product_idsdataframe) for
why that reversed a previous behavior once `Products.price` became the
authoritative source for what gets written into `RawTransaction`.

Later, viewing the Dashboard or Analytics page never re-reads uploaded
files — everything is served from the already-persisted
`RawTransaction`/`Rules`/`RuleItems` tables. The Dashboard reads
`GET /api/results`, which calls
`services/persistence.build_transactions_dataframe()` (filtered,
reconstructed into the same dataframe shape `services/aggregation.py`
expects) and `services/aggregation.build_dashboard_payload()`. The
Analytics page reads `GET /api/analytics`. Both responses are cached by
`services/cache.py` until the next database commit.

## Data flow: dashboard filters

```
dashboard.js state: selectedCategories[], selectedProducts[],
                     start/end date (via flatpickr, ISO underneath)
        │
        ▼  every filter change calls loadDashboardResults()
GET /api/results?start_date=...&end_date=...&category=A&category=B&product=X
        │
        ▼
routes/results.py: get_results()
  - services/persistence.build_transactions_dataframe(categories, products,
    start_date, end_date)  → filtered pandas DataFrame
  - services/aggregation.build_dashboard_payload(df) → all stat-card and
    chart values, computed over that already-filtered dataframe
  (both cached per filter combination by services/cache.get_or_build)
        │
        ▼
{"dashboard": {...}}

Analytics data is a separate request, GET /api/analytics (always
UNFILTERED — Analytics reflects the whole accumulated dataset regardless
of the Dashboard's filters).
```

Selecting/deselecting a Category re-fetches `GET /api/products` (scoped to
the newly selected categories, unioned) to re-populate the Product
checkbox list, pruning any now-invalid product selection, before
re-running the results fetch above.

## Data flow: deleting a product (soft-delete + rule pruning + re-mine)

```
Browser (products.js)                                       app.py's global
  │  DELETE /api/products/<id>                            error handler is
  ▼                                                      irrelevant here -
routes/products.py: delete_product()                    this path can't
  1. 404 if the id doesn't exist.                        raise an HTTPException
  2. Already is_active=False? -> idempotent no-op, return early.
  3. product.is_active = False
  4. services/persistence.prune_rules_for_product(product_id)
       SYNCHRONOUS structural edit of EXISTING Rules/RuleItems - not a
       re-mine:
         - product is the SOLE antecedent/consequent of a rule -> delete
           the whole rule (cascades RuleItems)
         - product is one of SEVERAL items on its side -> delete just its
           RuleItems row, flag that Rules.is_approximate = True
  5. db.session.commit()   <- steps 3+4 committed together, atomically
  6. Response returns to the browser HERE - the client sees the delete as
     "done" at this point, with any affected rules already showing the
     approximate marker (see build_analytics_browse_payload /
     build_rule_bundles_payload's isApproximate field).
  7. Only AFTER the response goes out: a background daemon thread runs
     services/persistence.remine_rules() inside its OWN app.app_context()
     (a background thread can't reuse the request's Flask-SQLAlchemy
     session) - a full re-mine over the accumulated dataset, excluding
     the now-inactive product's transactions, then commits.
  8. Once that background commit lands, Rules/RuleItems have been fully
     replaced with freshly-computed rows - every is_approximate flag is
     implicitly gone (the old approximate rows no longer exist). No
     push/notification channel needed: the next ordinary GET /api/analytics
     just reflects whatever's in the DB by then.
```

Deliberately asymmetric by design: the **dashboard's historical numbers**
for the deleted product's past sales never change (nothing in
`services/aggregation.py`/`build_transactions_dataframe`/
`build_full_transactions_dataframe` filters on `is_active`), while the
**association rules** stop counting that product going forward, both
instantly (step 4, structurally) and eventually-exactly (step 7, a real
recomputation from scratch).

Re-adding a product whose name/alias matches a soft-deleted one
(`POST /api/products`) revives that same row instead of creating a
duplicate — see
[backend-routes.md](backend-routes.md#post-apiproducts).
