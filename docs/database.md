# Database

SQLite at `instance/keat.sqlite3`, defined in `models.py`. Tables are created with
`db.create_all()` when the file doesn't exist. Columns added later (`products.product_alias`,
`products.price`, `products.is_active`, `user_accounts.role`, `rules.is_approximate`,
`upload_log.had_unmatched_rows`) are added to older databases at startup by
`services/migrations.py`, which also backfills them.

### user_accounts

| column | type | notes |
|---|---|---|
| user_id | integer pk | |
| username | string(120) | unique |
| password | string(255) | werkzeug hash |
| role | string(20) | always `user`, not used for permissions |

### upload_log

| column | type | notes |
|---|---|---|
| upload_id | integer pk | |
| file_hash | string(64) | sha256 of the file, unique |
| upload_date | datetime | updated when a file is retried |
| had_unmatched_rows | boolean | rows were skipped, so the file can be uploaded again |

### category

| column | type | notes |
|---|---|---|
| category_id | integer pk | |
| category_name | string(120) | unique |

### products

| column | type | notes |
|---|---|---|
| product_id | integer pk | |
| category_id | fk category | |
| product_name | string(255) | display name, title-cased |
| product_alias | string(255) | raw POS name, what uploads match on |
| price | numeric(12,2) | master price, null if never set |
| is_active | boolean | false = soft deleted |

### raw_transaction

One row per product line on a receipt.

| column | type | notes |
|---|---|---|
| record_id | integer pk | |
| upload_id | fk upload_log | |
| receipt_id | integer | per-day receipt number, starts at 1 each day |
| product_id | fk products | |
| year, month, day | integer | sale date |
| timestamp | datetime | time of day from the file, nullable |
| quantity | numeric(12,2) | |
| price | numeric(12,2) | price at upload time |
| total | numeric(12,2) | price × quantity |

A receipt is identified by its date plus `receipt_id`.

### transaction_statistics

Daily totals per category, added to on each upload. Nothing reads this table yet.

| column | type | notes |
|---|---|---|
| statistic_id | integer pk | |
| category_id | fk category | |
| year, month, day | integer | unique together with category_id |
| total_customers | integer | distinct receipts |
| total_revenue | numeric(12,2) | |

### rules

| column | type | notes |
|---|---|---|
| rule_id | integer pk | |
| support, confidence, lift, leverage | float | |
| conviction | float | can be infinite |
| is_approximate | boolean | an item was pruned out, metrics are stale until the next re-mine |

### rule_items

| column | type | notes |
|---|---|---|
| rule_item_id | integer pk | |
| rule_id | fk rules | |
| product_id | fk products | |
| side | string(20) | `antecedent` or `consequent` |

`rules` and `rule_items` are replaced as a whole every time rules are re-mined.
