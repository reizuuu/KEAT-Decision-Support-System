# Keat — Documentation

Keat is a single-café decision-support web app: staff upload POS export files
(CSV/XLSX), and the app turns that raw transaction data into a sales
dashboard, a market-basket ("frequently bought together") analytics view,
and a product catalog editor.

This `docs/` folder is a full map of the codebase — what each file, function,
and piece of persistent state does. It documents **behavior as implemented**,
not aspirational design; when the code and a comment disagree, trust the
code and treat the mismatch as a bug to flag.

## Documentation map

| File | Covers |
|---|---|
| [architecture.md](architecture.md) | How the app boots (`app.py`, `config.py`), the request lifecycle, auth model, the upload pipeline end-to-end, and the dashboard filter data flow |
| [database-schema.md](database-schema.md) | Every table and column in `models.py`, plus the startup schema-migration logic in `services/migrations.py` |
| [backend-routes.md](backend-routes.md) | Every HTTP endpoint across `routes/*.py` — method, auth, params, response shape, error cases |
| [backend-services.md](backend-services.md) | Every function in `services/*.py` — the actual business logic (parsing, persistence, aggregation, association-rule mining, response caching) |
| [frontend.md](frontend.md) | Every template (`templates/*.html`), every JS file's module-level state and functions (`static/js/*.js`), the stylesheet's structure (`static/css/style.css`, including the responsive breakpoints), and the favicon/web-manifest assets |

## Tech stack & libraries

**Backend** (see [requirements.txt](../requirements.txt)):

| Library | Version constraint | Used for |
|---|---|---|
| [Flask](https://flask.palletsprojects.com/) | `>=3.0,<4.0` | Web framework — routing, sessions, JSON responses, templating |
| [Flask-SQLAlchemy](https://flask-sqlalchemy.palletsprojects.com/) | `>=3.1,<4.0` | ORM layer over SQLite (`models.py`'s `db.Model` classes, query building) |
| [pandas](https://pandas.pydata.org/) | `>=2.0,<3.0` | All tabular data wrangling — cleaning uploaded files, building the in-memory dataframes the dashboard/analytics aggregations run over |
| [openpyxl](https://openpyxl.readthedocs.io/) | `>=3.1,<4.0` | `.xlsx` file reading (pandas' engine for `pd.read_excel`) |
| [mlxtend](https://rasbt.github.io/mlxtend/) | `>=0.23,<1.0` | Market-basket analysis — the FP-Growth algorithm and association-rule generation used to find "frequently bought together" patterns |

Standard library modules used throughout: `os`, `hashlib`, `math`, `re`,
`datetime`, `functools.wraps`, `pathlib.Path`, `decimal.Decimal`.

**Database:** SQLite, single file at `instance/keat.sqlite3`, no separate
DB server — the whole persistence layer is one file that `db.create_all()`
initializes on first run.

**Frontend:** no build step, no framework, no package manager — plain HTML
templates (Jinja2, server-rendered) plus vanilla JavaScript, loaded via
`<script>` tags. Third-party frontend libraries are stored locally in
`static/vendors/` (no build step), so the UI works without an internet
connection:

| Library | Loaded from | Used for |
|---|---|---|
| [Chart.js](https://www.chartjs.org/) 3.9.1 | `vendors/chartjs/` | Every chart on the Dashboard page |
| [Font Awesome](https://fontawesome.com/) 6.4.0 | `vendors/fontawesome/` (CSS + webfonts) | Icons throughout the UI |
| [flatpickr](https://flatpickr.js.org/) 4.6.13 | `vendors/flatpickr/` | Dashboard Start/End Date pickers (locale-independent mm/dd/yyyy display over an ISO-stored value) |
| Google Fonts (Poppins, Cormorant Garamond) | `vendors/fonts/` (`fonts.css` + woff2 files) | Typography |

The UI is responsive: the same pages adapt to desktop, tablet and phone
widths (breakpoints at 1200px, 992px, 768px and 480px — see
[frontend.md](frontend.md#responsive-design)). Below 768px the sidebar
becomes a slide-out menu opened from the ☰ button in the page header.

## Running the app

```bash
python app.py
```

or via Flask's CLI (`flask run`), with `FLASK_APP=app.py`. On first run,
`create_app()` creates `instance/keat.sqlite3` from scratch (see
[architecture.md](architecture.md)).

Seed a login account (role is cosmetic — see
[database-schema.md](database-schema.md#user_accounts) — both commands are
equivalent):

```bash
flask create-admin --username admin --password admin123
flask create-user  --username admin --password admin123
```

## Project layout

```
app.py                     Flask app factory, page routes, /favicon.ico redirect, CLI commands,
                             global error handlers
config.py                  Paths, secret key, mining thresholds
models.py                  SQLAlchemy models (the DB schema)
requirements.txt           Backend dependencies

routes/
  auth.py                  Login/logout/session endpoints
  products.py               Product & category CRUD endpoints
  results.py                Dashboard + analytics data endpoint
  upload.py                 File upload/ingestion endpoint
  users.py                   Self-service account endpoint

services/
  auth.py                   Auth decorators + current_user() helper
  aggregation.py            Dashboard chart/stat computation
  cache.py                  In-memory cache for /api/results and /api/analytics, cleared on every DB commit
  mining.py                 Association-rule mining (FP-Growth) + analytics payload shaping
  migrations.py             Startup schema upgrade-in-place logic
  parsing.py                Upload file reading/cleaning
  persistence.py            All DB read/write helpers (upload pipeline, read-endpoint queries,
                             master catalog seeding, rule pruning)
  text.py                   Small string-normalization helpers

templates/                 Jinja2 page templates (index/dashboard/analytics/products/upload)

static/
  css/style.css            All styling (CSS custom properties + one stylesheet)
  js/script.js             Shared across every page (nav, modals, session header, settings)
  js/dashboard.js           Dashboard page logic (filters + 8 charts)
  js/analytics.js           Analytics page logic (drill-down + bundles table)
  js/products.js             Products page logic (CRUD table)
  js/upload.js               Upload page logic (drag/drop, client-side file checks, progress)
  assets/keat_logo.jpg       Login page branding image (also the logo on printed reports)
  assets/favicons/           Browser-tab icons (.ico + 16/32/48px PNGs), Apple touch icon,
                              Android icons and site.webmanifest (app name "Keat")
  vendors/                   Locally-served Chart.js, Font Awesome, flatpickr and fonts

docs/                      This documentation

instance/
  keat.sqlite3               The SQLite database file (excluded from version control by
                              .gitignore's instance/*.sqlite3 rule)
  master_catalog/            Auto-created on every boot. Optional - drop a master_catalog.xlsx or
                              .csv here (Product Name, Product Alias, Category, Price columns)
                              before first boot to bulk-seed the catalog. Only takes effect on a
                              from-scratch (Products-table-empty) database - see architecture.md
                              and database-schema.md.
```
