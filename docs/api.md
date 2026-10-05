# API

All endpoints return JSON. Every endpoint except login and logout needs a session and
returns `401 {"error": "Authentication required."}` without one. An unexpected error on an
`/api/` route returns `500` with a JSON error instead of an HTML page.

| method | path | purpose | notable errors |
|---|---|---|---|
| POST | `/api/login` | `{username, password}` (JSON or form), starts a session | 401 wrong username or password |
| POST | `/api/logout` | clears the session | |
| GET | `/api/session` | `{username, role}` of the logged-in user | |
| GET | `/api/users/me` | `{id, username, role}` | |
| PUT | `/api/users/me` | change own `username` and/or `password`, blank fields are left alone | 409 username taken |
| GET | `/api/products` | active products, `?category=` can repeat. Price falls back to the average sold price, then 0 | |
| GET | `/api/categories` | all category names | |
| POST | `/api/products` | `{product_name, product_alias?, category, price?}`. Returns 201, or 200 when it revives a deleted product with the same name/alias | 400 missing name or category, bad price, name/alias already used |
| PUT | `/api/products/<id>` | update any of the same fields | 404, 400 empty name or category, bad price, duplicate |
| DELETE | `/api/products/<id>` | soft delete, prunes rules, re-mines in the background. Repeating it is a no-op | 404 |
| POST | `/api/upload` | multipart `file` (.csv/.xlsx). Returns row counts and skipped product names, see below | 400 no file, already uploaded, unsupported type, unreadable file, missing columns (with `missingColumns`), no valid rows. 413 over 50 MB |
| GET | `/api/results` | dashboard data. `start_date`, `end_date` (yyyy-mm-dd), `category` and `product` (both repeatable). Returns `{"dashboard": {...}}` or `{"empty": true}` | |
| GET | `/api/analytics` | `{rulesGenerated, transactions, categories, bundles}`, always over all data | |
| GET | `/api/analytics/status` | `{hasApproximateRules}`, polled while a re-mine is pending | |

The upload response looks like this:

```json
{
  "rowsProcessed": 3624,
  "duplicateRowsDropped": 0,
  "invalidRowsDropped": 0,
  "skippedUnmatchedRows": 0,
  "unmatchedProductNames": [],
  "skippedUnpricedRows": 0,
  "unpricedProductNames": [],
  "insightsUpdating": true
}
```

Rules are re-mined after the response is sent, so the analytics page can lag behind for a
few seconds after an upload.
