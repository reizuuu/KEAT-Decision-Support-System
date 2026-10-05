# Keat

Keat is a sales dashboard and market-basket analytics tool for a single café. Staff upload
the POS export (CSV or XLSX) and Keat turns it into sales charts, "frequently bought
together" rules and a product catalog they can edit.

It started as a capstone prototype, so it assumes one café, a handful of staff accounts and
a single server process.

## Features

- Dashboard with revenue, transaction and product charts, filterable by date range,
  category and product, plus a printable report.
- Analytics page that mines association rules (FP-Growth) over all uploaded sales. You can
  browse by category and product, or see every rule ranked in one table.
- Products page for the catalog: names, POS aliases, categories and master prices.
- Uploads are deduplicated by file and by row, so re-uploading overlapping exports is safe.
- Each account can change its own username and password.

## Tech stack

Python 3.11, Flask, Flask-SQLAlchemy on SQLite, pandas, openpyxl and mlxtend. The frontend
is server-rendered Jinja templates with plain JavaScript. Chart.js, flatpickr, Font Awesome
and the fonts are vendored under `static/vendors/`, so there's no build step and it works
offline.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Create an account (`create-admin` does the same thing):

```bash
flask --app app create-user --username admin
```

Run it:

```bash
python app.py                    # or: flask --app app run
```

Then open http://127.0.0.1:5000. On first start the app creates `instance/keat.sqlite3`.
If the products table is empty and `instance/master_catalog/master_catalog.xlsx` (or `.csv`)
exists, the catalog is seeded from it. That file needs `Product Name` and `Category`
columns, and can also have `Product Alias` and `Price`.

Set `KEAT_SECRET_KEY` to something private for anything beyond local use.

## Upload format

Required columns: `Receipt ID`, `Date`, `Product Name`, `Category`, `Quantity`,
`Timestamp`. `Price` and `Total` are optional. If there's no `Date` column, `Year`, `Month`
and `Day` columns work instead. Files can be up to 50 MB.

Rows are matched to the catalog by product alias (case and hyphens don't matter). Rows for
unknown products, or products with no price anywhere, are skipped and listed in the upload
summary. Fix the catalog and upload the same file again to pick them up. A few cleanup rules
are hardcoded in `services/parsing.py`, for example dropping `CUSTOM AMOUNT` rows and the
`Add On` and `Beverage` categories.

## Project layout

```
app.py              app factory, page routes, CLI commands
config.py           paths, secret key, mining thresholds
models.py           SQLAlchemy models
routes/             JSON API blueprints (auth, products, upload, results, users)
services/
  parsing.py        reading and cleaning uploaded files
  ingest.py         upload pipeline: receipt ids, dedup, matching, pricing, inserts
  catalog.py        product/category lookups, master catalog seeding
  rules.py          mining and storing rules, background remine, pruning
  queries.py        read queries and analytics payloads
  aggregation.py    dashboard numbers
  mining.py         FP-Growth and rule ranking
  cache.py          response cache for the dashboard/analytics endpoints
  migrations.py     adds newer columns to old databases on startup
templates/          one template per page
static/js/          script.js (shared) plus one file per page
tests/              smoke test
docs/               architecture, database and API notes
```

Run the tests with `python -m unittest discover tests`.

## Known limitations

- `debug=True` in `app.py`, a default secret key, no CSRF protection and no login rate
  limiting. Fine on a laptop, not ready to deploy as is.
- Receipt ids restart each day, so two different exports covering the same day can merge
  receipts that share a number.
- The rules re-mine runs on a background thread with no lock. Two quick changes can start
  two re-mines at once, and the last one to finish wins.
- The cache and background thread assume a single process.
- Uploads go row by row in pandas (`iterrows`/`apply`), which gets slow on big files.
- `transaction_statistics` is filled on upload but nothing reads it yet.

More detail is in [docs/architecture.md](docs/architecture.md),
[docs/database.md](docs/database.md) and [docs/api.md](docs/api.md).
