# Frontend

No build step, no framework, no bundler — server-rendered Jinja2 templates
plus plain `<script>`-tag JavaScript. Every page loads `script.js` (shared)
plus its own page-specific file. All third-party libraries are served
locally from `static/vendors/` (see [README.md](README.md#tech-stack--libraries)).

## Templates (`templates/*.html`)

| Template | Route | Loads | Purpose |
|---|---|---|---|
| `index.html` | `/` | `script.js` | Login page. Plain form (`#loginForm`), posts to `/api/login` via `handleLoginPage()` in `script.js`. Public (an already-logged-in visitor is redirected to `/dashboard`). |
| `dashboard.html` | `/dashboard` | `script.js`, `dashboard.js`, flatpickr, Chart.js | Filter bar (Start/End Date, Quick Filters, Category checkbox-dropdown, Product checkbox-dropdown-with-search, and a right-aligned **Print Report** button `#printReportBtn` in `.filter-group-print`) + 4 stat cards + 8 charts |
| `analytics.html` | `/analytics` | `script.js`, `analytics.js` | Two stat boxes, then a tab toggle between the Browse drill-down (Level 1 category grid → Level 2 product list → Level 3 rule rows) and the flat "Product Bundles" table. The tabs row also holds a right-aligned **Print Report** button (`#printReportBtn`, wrapped in `.print-report-btn-wrap`), shown on both tabs except Browse Level 1 (the category grid, which has no table — the wrapper is hidden there, not just disabled) |
| `products.html` | `/products` | `script.js`, `products.js` | Product count, search box, single-select category filter (`#categoryFilter`, its own independent `<select>` — **not** the Dashboard's multi-select checkbox dropdown, see [backend-routes.md](backend-routes.md#get-apiproducts)), Add Product button, product table, Add/Edit modal, delete-confirm modal |
| `upload.html` | `/upload` | `script.js`, `upload.js` | Drag-and-drop zone + Browse button, Required Fields / Optional Fields (Price, Total) reference lists, progress modal, success modal |

Every template's `<head>` has the same favicon block: `favicon.ico`, the
16/32/48px PNG icons, the Apple touch icon and the web manifest, all from
`static/assets/favicons/` via `url_for('static', ...)`, plus
`<meta name="theme-color" content="#2c1e1d">`. `site.webmanifest` names the
app "Keat" and references its two Android icons by relative path, so they
resolve next to the manifest. (The server also redirects `/favicon.ico` to
the same file — see [architecture.md](architecture.md#page-routes).)

Every authenticated page shares the same shell markup: sidebar nav
(`#sidebar`/`#sidebarNav`), a ☰ menu button (`#hamburger`,
`aria-label="Open menu"`, shown only below 768px — see
[Responsive design](#responsive-design)), header with a user avatar/name/role
(`#userAvatar`/`#userName`/`#userRole`) and a settings gear
(`#settingsGearBtn`, hidden until `script.js` confirms a session), a
Sign Out confirm modal, and a Help modal — all wired up by
`initializeCommonFunctionality()` in `script.js`.

`dashboard.html` and `analytics.html` also end `<body>` with an empty
`<div id="printReport" class="print-report" data-logo-src="…">` — the
print-only container the **Print Report** buttons fill just before
`window.print()` and empty again on `afterprint` (see
[Print reports](#print-reports) below). `data-logo-src` carries the
`url_for()` path of `static/assets/keat_logo.jpg` so the JS doesn't hardcode
the static URL. Both buttons start `disabled` (title "Loading … data...")
until their page's data has loaded.

## Print reports

Pure client-side, print-CSS based — no backend changes, no PDF library.
Clicking **Print Report** builds an HTML report string from data already in
memory (no refetch), puts it in `#printReport`, adds `body.printing-report`
(plus `body.print-landscape` for the Product Bundles table), waits briefly
for the header logo to load, and calls `window.print()`. On `afterprint`
the container is emptied and both body classes removed, so the on-screen
page is left exactly as it was. The print CSS only swaps the app for the
report while `body.printing-report` is set, so a plain Ctrl+P on any page
prints as it did before.

- **Dashboard** — a four-page report built from the same `payload.dashboard`
  object the on-screen charts were drawn from (`lastDashboardResults`). Its
  charts are redrawn as inline SVG (sharp on paper, nothing to wait for
  before `window.print()`), with HTML legends/labels over them:
  1. Header with "Filters applied" (date range, categories, products —
     truncated to 10 names + "+N more"), Summary (the 4 stat-card values),
     Key Highlights (top category, best-seller, best month, busiest day,
     peak hour in 12-hour time — each skipped if empty), and a Revenue by
     Category **pie** with leader-line labels (category, ₱, %).
  2. Top 10 Best-Selling Items table + a generated **Summary Report**
     callout (lead over #2, ratio to #10, a common dish word shared by 3+
     items, share of all items sold), then the Monthly Summary **combo
     chart** (revenue line on the left axis, transaction bars on the right
     axis stretched ~2x so the line rides above the bars, and an
     average-₱-per-transaction row).
  3. Transaction Volume of Each Category per Month as **stacked bars**
     (items sold, legend with each category's total, totals on top,
     values inside segments tall enough to hold them), then the Day of
     Week table + a generated Summary Report (busiest vs quietest day,
     Friday–Sunday share).
  4. Transactions by Hour of Day as a **heat grid**: three shift rows
     (`REPORT_SHIFTS` — 2–4 PM, 5–8 PM, 9–11 PM) of hour boxes shaded by
     volume, with dashed "before opening" / "after closing" boxes folding
     in the hours outside opening time, and a PEAK HOUR badge.

  Category colours come from `REPORT_CATEGORY_PALETTE` in revenue order, so
  the pie and the stacked bars always agree. Sections 2–4 start on a new
  page (`report-section-break`).
  "Top 10 Products per Month" is intentionally not included. The button is
  disabled while a `/api/results` request is in flight and when the
  filters return no data.
- **Analytics** — prints only the table currently on screen, honoring every
  control that shapes it: Level 2 (Product | Combos Found; search term and
  sort), Level 3 (Frequently Bought Together | Chance of Buying Together;
  sort), or Product Bundles (Rank, Products, the 5 metric columns and Score; min thresholds and sort,
  landscape). Rows come from the same `getLevel2Products()` /
  `getLevel3Rows()` / `getFilteredBundleRows()` helpers the render
  functions use, so print and screen can't drift. The header shows
  "Transactions analysed" / "Combos found" and a note that Analytics always
  uses the full dataset. A "~ Approximate value…" footnote is added only if
  a printed row is approximate. The button is disabled (with the reason as
  its tooltip) on Level 1 and whenever the current table has zero rows.

## `static/js/script.js` — shared across every page

### Module-level state

| Variable | Purpose |
|---|---|
| `infoPopupModalReady` | Guards `ensureInfoPopupModal()` so the shared info-popup modal HTML is only injected into the DOM once |
| `settingsModalReady` | Same guard, for the account-settings modal |
| `currentSessionUsername` | Cached from the last `/api/session` load, so opening the settings modal can pre-fill the username field without a second network round trip |
| `pendingReportCleanup` | The cleanup function of a printed report whose `afterprint` hasn't fired yet — run first if another print starts, so the old listener can't wipe the new report |

### Functions

| Function | Purpose |
|---|---|
| `guardApiSessions()` (IIFE, runs on load) | Wraps `window.fetch`: any API response with status 401 (except `/api/login`, and never on the login page) sends the user to `/` — the session ended while the page was open |
| (anonymous `pageshow` listener) | Reloads a page restored from the back/forward cache (`event.persisted`), so the server's login check runs again after signing out |
| `handleLoginPage()` | Wires `#loginForm`'s submit: posts `{username, password}` to `/api/login`, shows `#errorMessage` on failure, redirects to `/dashboard` on success. Also handles the "remember me" checkbox (stores/reads `localStorage.rememberEmail`) and the show/hide password eye button (`wirePasswordToggle`). There is no "forgot password" link. |
| `wirePasswordToggle(input, button)` | Eye button inside the password box (`#passwordToggle`): switches the input between `password` and `text`, swaps the `fa-eye`/`fa-eye-slash` icon and updates `aria-label`/`aria-pressed`. Always switches back to hidden on submit, so the browser never saves it as a plain text field |
| `initializeCommonFunctionality()` | Called on every non-login page. Wires navigation highlighting, hamburger menu, sign-out, help modal, user header, and info tooltips. |
| `initializeInfoTooltips()` | Wires every `.info-tooltip` button on the page to open the shared info popup on click |
| `ensureInfoPopupModal()` | Lazily injects the `#infoPopupModal` HTML into `<body>` (once) |
| `openInfoPopup(tooltipEl)` | Reads the tooltip's `.info-tooltip-bubble` text and derives a title from the enclosing label (`.stat-card-title`/`.stat-box-label`/`label`, with the icon itself stripped out of the cloned text), then opens the popup |
| `initializeNavigation()` | Highlights the sidebar link matching the current page (`getCurrentPage()`) |
| `getCurrentPage()` | Maps `window.location.pathname` to one of `/dashboard`, `/analytics`, `/products`, `/upload` (defaults to `/dashboard`) |
| `initializeHamburger()` | Toggles the sidebar's `active` class on click; closes it on an outside click (including a tap on the dimmed backdrop, which is just the open sidebar's box-shadow, not a separate element) |
| `initializeSignOut()` | Wires every `#signOutBtn` to open the sign-out confirm modal |
| `closeSignOutConfirm()` / `confirmSignOut()` | Close the modal / actually call `POST /api/logout` then redirect to `/` (redirects even if the request fails, via `finally`) |
| `initializeHelpModal()` / `closeHelpModal()` | Open/close the page's Help modal |
| `initializeUserHeader()` | Fetches `/api/session`, caches the username, renders the header, and unconditionally calls `showSettingsGear()` — every authenticated session can manage its own account now (no more role check gating this) |
| `renderUserHeader(session)` | Fills in the avatar initial, name, and capitalized role text from a `{username, role}` object |
| `showSettingsGear()` | Un-hides `#settingsGearBtn` and wires its click to `openSettingsModal()` |
| `ensureSettingsModal()` | Lazily injects the settings modal HTML (username + password fields only — no account picker, since there's nothing to pick anymore) |
| `openSettingsModal()` | Pre-fills the username field from `currentSessionUsername`, clears the password field, opens the modal |
| `closeSettingsModal()` | Closes the modal |
| `saveSettingsAccount()` | Validates the username isn't blank, builds a body with only the changed username (if different) and/or a new password (if entered), `PUT`s to `/api/users/me`, updates `currentSessionUsername` and the header display on success |
| `closeModal(modalId)` / `openModal(modalId)` | Toggle a modal's `active` class by id |
| (anonymous, document click listener) | Closes any open `.modal-overlay` when its backdrop (not its content) is clicked |
| `showNotification(message, type)` | Injects a floating `.notification` element (replacing any existing one), auto-removes after 3 seconds |
| `formatCurrency(value)` | `₱` + the value formatted with thousands separators and exactly 2 decimals |
| `formatNumber(value)` | Thousands separators, 0–2 decimals (no trailing zeros forced) |
| `escapeReportHtml(value)` | HTML-escapes a string for the print reports. Deliberately not named `escapeHtml` — `analytics.js`/`products.js`/`upload.js` each declare their own global `escapeHtml()`, which a same-named declaration here would collide with |
| `formatReportTimestamp(date)` | `en-US` local date + time (e.g. "Sep 30, 2026, 10:57 PM") for the report's "Generated:" line |
| `buildReportHeader(title, filterLines, options)` | Report header HTML: logo (from `#printReport`'s `data-logo-src`, ~40px tall), title, "Generated: …", "Generated by: <text of `#userName`>", optional `options.metaLines`, the "Filters applied" block, and optional `options.note`. `filterLines`/`metaLines` are `[{label, value}]` |
| `renderReportLabelList(lines)` | Renders `[{label, value}]` as a "Label: value" list (used by the header) |
| `renderReportTable({columns, rows, align, footerRow, className})` | Returns an escaped `<table>` string. `align` is per-column `'left'`/`'right'`/`'center'`; `footerRow` becomes a bold last `<tbody>` row — not a `<tfoot>`, since browsers repeat `<tfoot>` on every printed page |
| `renderReportSection(title, bodyHtml, className)` / `renderReportMessage(text, className)` | A titled report section / a single escaped paragraph (empty-state lines, captions, footnotes) |
| `setPrintButtonState(button, enabled, disabledReason)` | Enables/disables a Print Report button, putting the reason in the `title` of both the button and its wrapper (some browsers don't show a disabled button's own tooltip) |
| `waitForReportImages(container, timeoutMs)` | Resolves once the report's images have loaded (or errored), capped at `timeoutMs` |
| `printReportHtml(html, options)` | Fills `#printReport`, adds `body.printing-report` (and `body.print-landscape` if `options.landscape`), waits for the logo, calls `window.print()`, and undoes all of it on `afterprint` |
| `window.mockData` | `{products: []}` — populated per-page from the server (see `products.js`); the name is a holdover from an earlier mock-data prototype phase |

## `static/js/dashboard.js`

### Module-level state

| Variable | Purpose |
|---|---|
| `orderSummaryChart`, `bestSellingChart`, `transactionVolumeChart`, `revenueByCategoryChart`, `monthlySalesTrendChart`, `topProductsMonthlyChart`, `transactionsByDayChart`, `transactionsByHourChart` | The 8 live `Chart.js` instances — each destroyed and rebuilt on every filter-driven refresh |
| `topProductsSortDirection` | `'desc'`/`'asc'` — which way the Top-10-Products-per-Month chart's datasets are ordered. Reset to `'desc'` on every filter change |
| `lastTopProductsMonthlyData` | The last-fetched raw data for that chart, kept so toggling sort direction can re-render without a network round trip |
| `currentCategoryOptions`, `currentProductOptions` | The full list of category/product names currently available to pick (product list is re-scoped whenever the category selection changes) |
| `selectedCategories`, `selectedProducts` | The checked items in each checkbox-dropdown filter. Empty array = "All" (no filter) |
| `productFilterSearchTerm` | Live text from the Product dropdown's search box — narrows which checkboxes *render*, never touches `selectedProducts` |
| `startDatePicker`, `endDatePicker` | The two flatpickr instances, kept so quick-filter clicks can call their `.setDate()`/`.clear()` API (updating what's on screen) instead of just setting the underlying input's value |
| `lastDashboardResults` | The last `/api/results` payload the dashboard actually rendered (`null` = no data for those filters). Set in `initializeDashboardCharts()`; the Print Report button builds from it, so the printout matches the screen without a refetch |
| `lastDashboardFilterLines` | The "Filters applied" description (`[{label, value}]`) captured in `loadDashboardResults()` *before* the fetch that produced `lastDashboardResults`, so the printed filters always belong to the printed numbers |
| `REPORT_FILTER_LIST_LIMIT` | `10` — longer category/product selections print as the first 10 names + "+N more" |
| `REPORT_NO_DATA_TEXT` | Empty-state line for a report section with no data |
| `CHART_PALETTE` | 10 hex colors, ordered so no two array-adjacent entries share a hue family (alternating warm/cool) — the default for every multi-dataset chart via `colorizeDatasets()` |
| `TOP_PRODUCTS_PALETTE` | The Top 10 Products per Month chart's own fixed 10-color set (similar-shade pairs placed 5 slots apart), passed to `colorizeDatasets()` for that chart only |
| `MONTH_NAMES` | Full month names, used by `formatDisplayDate()` |
| `REPORT_CATEGORY_PALETTE`, `REPORT_REVENUE_LINE_COLOR`, `REPORT_TRANSACTION_BAR_COLOR`, `REPORT_HEAT_STOPS` | Print-report colours: category colours (pie + stacked bars), the Monthly Summary line/bars, and the hour heat-grid gradient stops |
| `REPORT_SHIFTS`, `REPORT_OPENING_HOUR` (14), `REPORT_LAST_OPEN_HOUR` (23), `REPORT_EARLY_MORNING_END` (6) | Opening-hours model for the printed Hour of Day grid |
| `REPORT_THEME_STOP_WORDS` | Words (size/serving words like "solo", "set", "combo") ignored when looking for a common dish word among the best sellers |
| `NO_DATA_MESSAGE` | `"No data yet. Upload a file to get started."` |
| `orderSummaryValueLabels` | A Chart.js plugin object (`afterDatasetsDraw`) that draws the numeric value above each point on the order-count line chart |

### Functions

**Bootstrapping**
- `initializeDashboardPage()` — wires all controls, then loads category options, product options and results in parallel (`Promise.all` — no filters are selected yet, so they don't depend on each other). Runs on `DOMContentLoaded`.

**Time period (dates + quick filters)**
- `wireTimePeriodControls()` — sets up flatpickr and the Today/This Week/This Year/Custom Range buttons
- `initDateFilterPickers()` — creates the two flatpickr instances (`altInput`/`altFormat: 'm/d/Y'`/`dateFormat: 'Y-m-d'`), wiring their `onChange` to re-sync highlighting and reload results
- `setDateFilterValue(input, picker, isoValue)` — pushes an ISO date into a filter through the flatpickr API (falls back to setting `.value` directly if flatpickr isn't loaded)
- `clearTimePeriodFilter()` — clears both date inputs and reloads
- `computeQuickRange(range)` — returns `{start, end}` ISO strings for `'today'`/`'week'`/`'year'` ("This Week" = Monday-start through today; "This Year" = Jan 1–Dec 31 of the current year)
- `toDateInputValue(date)` — `Date` → `yyyy-mm-dd`
- `syncQuickFilterHighlight()` — highlights whichever quick-filter button's computed range matches the current date inputs, or "Custom Range" if none match
- `setActiveQuickFilter(range)` — toggles the `.active` class across the quick-filter buttons

**Category / Product cascading filters**
- `wireCategoryProductControls()` — wires both dropdowns
- `wireCategoryFilterDropdown()` — toggle/outside-click-to-close behavior, plus the "All Categories" reset checkbox
- `wireProductFilterDropdown()` — same, plus the search box's `input` listener
- `loadCategoryOptions()` — fetches `/api/categories`, prunes any now-invalid selection, re-renders
- `renderCategoryFilterList()` — renders the category checkboxes and wires each one's `change` (which also re-loads product options, since category selection re-scopes the product union)
- `updateCategoryFilterToggleLabel()` — "All Categories" / one name / "N categories selected"
- `loadProductOptions()` — fetches `/api/products` scoped to `selectedCategories` (union), prunes invalid product selections, clears the search term, re-renders
- `renderProductFilterList()` — filters `currentProductOptions` by `productFilterSearchTerm` for **display only**, renders checkboxes, wires each one's `change`
- `updateProductFilterToggleLabel()` — same pattern as the category label
- `escapeHtmlAttr(value)` — HTML-escapes a string for safe interpolation into an attribute/label

**Results loading**
- `loadDashboardResults()` — builds the query string from dates + selected categories/products, snapshots the report filter description (`buildDashboardReportFilterLines()`), disables the Print Report button while fetching `/api/results`, resets the Top-Products sort back to descending, stores the snapshot in `lastDashboardFilterLines`, hands off to `initializeDashboardCharts()`
- `initializeDashboardCharts(results)` — stores `lastDashboardResults`, enables/disables the Print Report button (disabled when there's no data), then calls `updateDashboardStats()` plus all 8 `initialize*Chart()` functions
- `updateDashboardStats(results)` — fills in the 4 stat cards (and their date-range subtext, unconditionally — see below); `'—'` placeholders when there's no data
- `formatDisplayDate(isoValue)` — `yyyy-mm-dd` → `"Month D, YYYY"`, parsed by splitting the string rather than `new Date(iso)` to avoid a timezone-driven off-by-one day
- `buildDateRangeSubtext()` — describes the current Start/End Date filter for the stat cards' `.stat-card-date-range` subtext: `"All time"` if neither is set; if the range matches one of the quick filters (via `computeQuickRange()`, the same check `syncQuickFilterHighlight()` uses), a friendly label — `"As of today"` / `"As of this week"` / `"As of this year"` (see `QUICK_FILTER_SUBTEXT_LABELS`) — regardless of whether it was reached via the button or a hand-typed match; a hand-picked single-day range (start equals end, but doesn't match "today") collapses to `"As of <date>"` rather than `"<date> to <date>"`; otherwise `"As of <start> to <end>"` for a genuine multi-day custom range, or an open-ended `"As of <start> onward"`/`"Through <end>"` if only one side is set. Reflects what was *requested*, independent of whether any data was found
- `formatAverageProductsRange(value)` — buckets the precise average into a `"low-high"` display string (`Math.floor` → low, `low+1` → high; an exact integer like `3.0` displays `"3-4"`, not `"2-3"`)
- `buildAverageProductsTooltip(value)` — builds the info-tooltip sentence, varying wording by whether the value is below/within/above the 2–3 reference range

**Print report** (see [Print reports](#print-reports))
- `wirePrintReportButton()` — wires `#printReportBtn`'s click to `printDashboardReport()`
- `printDashboardReport()` — builds the report from `lastDashboardResults` + `lastDashboardFilterLines` and hands it to `printReportHtml()`
- `buildDashboardReportFilterLines()` — Date range (the `buildDateRangeSubtext()` wording, with the explicit dates appended to a relative phrase like "As of this week"), Categories, Products
- `summarizeReportList(names)` — joins names, truncating past `REPORT_FILTER_LIST_LIMIT` with "+N more"
- `buildDashboardReportHtml(dashboard, filterLines)` — works out the category order/colours (`getReportCategoryOrder`), month list and total items sold, then joins the header and every section below, in order
- `reportNumber(value)` / `sumReportValues(values)` / `sumReportDatasets(series)` / `reportRound(value)` / `formatReportPercent(value, total)` / `hasReportSeries(series)` / `findReportSeriesMax(series)` — small math helpers (nulls count as 0; percentages guard divide-by-zero; `reportRound` rounds to 1 decimal)
- `formatReportHourRange(label)` (`"22:00"` → `"10:00 PM – 10:59 PM"`), `formatReportHour`, `formatReportClock`, `formatReportPesoWhole`, `formatReportAxisPeso` — report formatting
- `niceReportStep`, `reportSvgText`, `reportSvgMonthLabel`, `reportHeatColor`, `reportTextColorOn` (with `hexToRgb`/`reportRelativeLuminance`), `spreadReportLabels` — SVG chart helpers (axis steps, text, heat-grid colour, readable text on a fill, non-overlapping pie labels)
- `reportStrong(text)`, `renderReportChartCard(innerHtml)`, `renderReportChartCaption(html)`, `renderReportSummaryCallout(html)` — small HTML wrappers (escaped bold text, the bordered chart card, the caption under a chart, the blue "Summary Report" callout)
- `buildBestSellingNarrative`, `buildDayOfWeekNarrative` (with `findReportNameTheme`) — the generated Summary Report text
- `buildReportSummarySection`, `buildReportHighlightsSection`, `buildReportRevenueByCategorySection`, `buildReportBestSellingSection`, `buildReportMonthlySummarySection`, `buildReportCategoryPerMonthSection`, `buildReportDayOfWeekSection`, `buildReportHourOfDaySection` — one per report section

**Empty-state / shared chart helpers**
- `showChartEmptyState(canvas, message)` / `hideChartEmptyState(canvas)` — hide the canvas and show/remove a text message in its place
- `colorizeDatasets(datasets, palette)` — assigns each dataset a color by its index, from `palette` (defaults to `CHART_PALETTE`)

**The 8 charts** (each follows the same shape: bail if the canvas isn't on the page, destroy any existing instance, show the empty state if there's no data, else build a `new Chart(...)`):

| Function | Chart | Type |
|---|---|---|
| `initializeOrderSummaryChart` | Transaction Volume per Month | line |
| `initializeBestSellingChart` | Top 10 Best-Selling Menu Items | bar |
| `initializeTransactionVolumeChart` | Transaction Volume of each Category per Month | clustered bar |
| `initializeRevenueByCategoryChart` | Revenue by Category | bar |
| `initializeMonthlySalesTrendChart` | Trajectory of Monthly Sales | line |
| `initializeTopProductsMonthlyChart` | Top 10 Products per Month | clustered bar (sortable, `TOP_PRODUCTS_PALETTE`) |
| `initializeTransactionsByDayChart` | Transactions by Day of Week | line (filled) |
| `initializeTransactionsByHourChart` | Transactions by Hour of Day | line |

The Top-Products chart has extra machinery since it supports a
sort-direction toggle:
- `ensureTopProductsSortToggleWired()` — wires the toggle button exactly
  once (`dataset.wired` guard), flipping `topProductsSortDirection` and
  re-rendering on click
- `sortProductDatasets(datasets, direction)` — reorders (not filters)
  datasets by each product's total volume across all months — sorting
  here means dataset order, not axis order, since this is a clustered
  chart with one series per product
- `renderTopProductsMonthlyChart()` — the actual chart build/rebuild,
  called both on data load and on sort-toggle click

## `static/js/analytics.js`

### Module-level state

| Variable | Purpose |
|---|---|
| `analyticsData` | The full `{rulesGenerated, transactions, categories, bundles}` payload from `/api/analytics` |
| `productIndex` | `Map<productName, {product, category, ruleCount, rows}>` — flattened for O(1) lookup by product name (search, Level 3 view) |
| `currentLevel` | `1`/`2`/`3` — which drill-down level is showing |
| `currentCategory`, `currentProduct` | The currently-viewed category (Level 2) / product (Level 3) |
| `level3CameFromCategory` | Which view the Level 3 back button returns to — `null` means Level 1, otherwise a category name (reached via search instead of drilling through a category) |
| `level2SortDirection` | `'asc'`/`'desc'` — Level 2's product-list sort |
| `level2FilterTerm` | Live search text while on Level 2, filters the visible product list |
| `bundlesData` | The flat list of persisted rules for the "Product Bundles" tab (a separate view from the Level 1/2/3 drill-down) |
| `bundlesSortKey`, `bundlesSortDirection` | Current sort column/direction for the bundles table (default `'rank'`/`'asc'` — the backend's composite-score order) |
| `currentAnalyticsTab` | `'browse'`/`'bundles'` — which tab is showing (set by `showAnalyticsTab()`); decides which table Print Report prints |
| `BUNDLES_COLUMN_LABELS` | Plain bundles column names (no ▲/▼) for the printed headers and the "Sorted by" line |
| `PRINT_NO_ROWS_REASON`, `APPROXIMATE_FOOTNOTE` | Disabled-button tooltip for an empty table / the "~ Approximate value…" footnote text |
| `RECALC_POLL_INTERVAL_MS` | `4000` — how often the "Recalculating market insights..." badge polls `/api/analytics/status` |
| `recalcPollTimer` | The running `setInterval` id while polling, else `null` |

### Functions

- `initializeAnalyticsPage()` — loads data, wires controls, shows Level 1. Runs on `DOMContentLoaded` (only if `#analyticsLevel1` exists on the page)
- `loadAnalyticsData()` — fetches `/api/analytics`, builds `productIndex`, populates the two top stat boxes, then calls `updateRecalculatingBadge()`
- `payloadHasApproximateRules()` — `true` if any Browse row or Product Bundles rule in the loaded data has `isApproximate` (a product delete's instant prune left it stale)
- `updateRecalculatingBadge()` — shows `#recalculatingBadge` and starts polling while approximate rules exist; hides it and stops polling otherwise
- `startRecalcPolling()` / `stopRecalcPolling()` — every `RECALC_POLL_INTERVAL_MS`, asks `/api/analytics/status`; once `hasApproximateRules` is false, stops, reloads the data and calls `rerenderCurrentView()`
- `rerenderCurrentView()` — re-renders whichever drill-down level is showing and, if the Product Bundles tab is open, its table, with the freshly recalculated numbers
- `wireControls()` — wires the search input (behaves differently on Level 2 — filters the list — vs. Levels 1/3 — shows a dropdown of matches), Enter-to-select-if-exactly-one-match, back buttons, and the Level 2 sort toggle
- `matchingProducts(term)` — case-insensitive substring match against `productIndex`
- `renderSearchDropdown(term)` / `hideSearchDropdown()` — show/hide the floating list of matching products under the search bar
- `selectSearchResult(productName)` — jumps straight to Level 3 for that product
- `escapeHtml(value)` — HTML-escapes a string
- `showLevel1()` / `renderCategoryGrid()` — resets to the category-grid landing view; renders one tile per category, wired to `showLevel2`
- `showLevel2(categoryName)` / `renderLevel2List()` — shows that category's product list (from `getLevel2Products()`), each row wired to `showLevel3`
- `getLevel2Products()` — `currentCategory`'s products filtered by `level2FilterTerm`, sorted alphabetically then reversed if `level2SortDirection === 'desc'`. Shared by `renderLevel2List()` and the print report
- `showLevel3(productName, cameFromCategory)` / `renderLevel3Rows(entry)` — shows one product's rule rows (from `getLevel3Rows()`, labelled by `formatLevel3RowLabel()`), appending the approximate marker (see below) when `row.isApproximate`
- `getLevel3Rows(entry)` / `formatLevel3RowLabel(row)` — the rows sorted by `level3SortDirection`, and each row's "+ other antecedents → consequents" label. Shared by `renderLevel3Rows()` and the print report
- `joinWithAnd(names)` — `["A"]` → `"A"`, `["A","B"]` → `"A and B"`, `["A","B","C"]` → `"A, B and C"`
- `approximateMarkerHtml(isApproximate)` — returns a `~` marker span (with a native `title` hover tooltip: *"Approximate value. The exact probability is currently being recalculated due to recent catalog updates."*) when `isApproximate` is true, else `''`. Used by both `renderLevel3Rows` and `renderBundlesTable`. Deliberately a native `title` attribute rather than the shared `.info-tooltip` click-modal component — that component's click listeners are wired once at page load and wouldn't pick up markers rendered later into dynamically-built table rows, and the spec for this marker specifically calls for a hover tooltip anyway (`.info-tooltip` is explicitly click-triggered, per its own comment in `script.js`)
- `setLevelVisibility(level)` — toggles which of the three level containers is `hidden`
- `clearSearchInputKeepingDropdownHidden()` — resets the search box when navigating between levels
- `wireBundlesControls()` — wires the Browse/Product Bundles tab buttons, the three min-support/confidence/lift filter inputs, and each sortable column header
- `showAnalyticsTab(tab)` — toggles between the Browse view and the Bundles view (recording it in `currentAnalyticsTab`), then refreshes the Print Report button
- `getBundlesThresholds()` — reads the three min-threshold inputs as `{support, confidence, lift}`, each `{isSet, value}` (blank/unparseable → `value` 0, `isSet` false — printed as "None")
- `getFilteredBundleRows(thresholds)` — `bundlesData` filtered by the thresholds and sorted by `bundlesSortKey`/`bundlesSortDirection`. Shared by `renderBundlesTable()` and the print report
- `renderBundlesTable()` — renders `getFilteredBundleRows()` (or an empty-state message distinguishing "no rules at all" from "no rules match these filters"); the Confidence cell appends the approximate marker (`approximateMarkerHtml`) when `rule.isApproximate`
- `compareBundleRows(a, b, key, direction)` — comparator; nulls (infinite `conviction` when confidence is exactly 100%) always sort last regardless of direction; equal values fall back to `rank`
- `formatBundleMetric(value, decimals = 3)` — `null` → `"∞"`, else fixed to `decimals` (Leverage and Score use 4)
- `updateBundlesSortIndicators()` — appends ▲/▼ to the currently-sorted column header's label (caching the plain label text in a `data-label` attribute the first time)
- `wirePrintReportButton()` — wires `#printReportBtn`'s click to `printAnalyticsReport()`
- `updateAnalyticsPrintButton()` — hides the button's wrapper on Browse Level 1; elsewhere enables/disables the button from `buildAnalyticsPrintableView()`. Called at the top of every render function (`renderCategoryGrid`, `renderLevel2List`, `renderLevel3Rows`, `renderBundlesTable`) and in `showAnalyticsTab()` — the only points where the printable table can change
- `buildAnalyticsPrintableView()` — describes what would be printed for the current tab/level (`{viewName, sectionTitle, filterLines, columns, align, rows, hasApproximate, landscape}`), or `{disabledReason}` on Level 1 / an empty table
- `formatSortDirectionLabel(direction)` / `formatThresholdValue(threshold)` — "Ascending"/"Descending"; a threshold as 3 decimals or "None"
- `printAnalyticsReport()` — header ("Product Combos Report – <view>", Transactions analysed, Combos found, full-dataset note) + row count + table + optional "~" footnote, printed via `printReportHtml()` (landscape for Product Bundles)

## `static/js/products.js`

### Module-level state

| Variable | Purpose |
|---|---|
| `currentEditingProductId` | `null` when the modal is in "Add" mode, else the product id being edited |
| `currentSearchTerm` | Live text search, applied client-side |
| `currentCategoryFilter` | The single selected category (`'all'` or a name) — applied **server-side** via a re-fetch |
| `NEW_CATEGORY_SENTINEL` | `'__new__'` — the special `<option>` value in the category `<select>` that reveals a "New Category Name" input |

### Functions

- `initializeProductsPage()` — wires the table, modal, search, and category filter. Runs on `DOMContentLoaded`
- `initializeProductTable()` — loads categories then products, renders
- `loadAllCategoriesForFilter()` — fetches `/api/categories`, populates both the filter `<select>` and the modal's category `<select>`
- `loadProductsFromServer()` — fetches `/api/products` scoped to `currentCategoryFilter` into `window.mockData.products`
- `updateProductCount()` — updates the `#productCount` number
- `getVisibleProducts()` — applies `currentSearchTerm` (against name or category) on top of the already category-scoped server list, sorted alphabetically by name
- `renderProductTable()` — renders rows (name + alias sub-line + category + price + edit/delete icons), or an empty-state message distinguishing "no products at all" from "no products match your search"
- `escapeHtml(value)` — HTML-escapes a string
- `initializeProductModal()` — wires the Add Product button and the category `<select>`'s change (to reveal/hide the new-category input)
- `showNewCategoryInput()` / `hideNewCategoryInput()` — toggle `#newCategoryGroup`
- `refreshProductCategoryOptions()` — re-fetches `/api/categories` fresh (rather than reusing what's cached) right before the modal opens, so a category created elsewhere since page load is available; fixes a "blank category on edit" bug that a stale `<select>` would otherwise cause
- `setProductCategorySelectValue(categoryName)` — sets the modal's category `<select>` to a value, inserting a temporary `<option>` if that category was renamed/removed elsewhere since the refresh (so the field never silently ends up blank)
- `openAddProductModal()` — resets the form, opens in "Add" mode
- `initializeProductSearch()` — wires `#productSearch`'s input to update `currentSearchTerm` and re-render
- `populateCategoryFilterOptions(categories)` — rebuilds the filter `<select>`, preserving the previous selection if still valid
- `populateProductCategoryOptions(categories)` — rebuilds the modal's category `<select>` (plus the "+ Add New Category" sentinel option), preserving the previous selection if still valid
- `initializeCategoryFilter()` — wires the filter `<select>`'s change to re-fetch and re-render
- `initializeProductActions()` — wires each row's edit/delete icons (re-run after every table render, since the rows are rebuilt)
- `openEditProductModal(productId)` — populates the form from the in-memory product, opens in "Edit" mode
- `saveProduct()` — validates required fields and a non-negative price, `POST`s or `PUT`s depending on `currentEditingProductId`, refreshes the table on success
- `closeProductModal()` — closes the modal, resets edit state
- `openDeleteConfirm(productId)` / `closeDeleteConfirm()` — open/close the delete-confirm modal, tracking `deleteProductId`
- `confirmDelete()` — `DELETE`s the product (a soft delete — its sales history stays in the dashboard, see [backend-routes.md](backend-routes.md#delete-apiproductsintproduct_id)), refreshes the table, and shows the server's error message if the request fails

## `static/js/upload.js`

### Module-level state

| Variable | Purpose |
|---|---|
| `selectedFile` | The currently-chosen `File` object, or `null` |

### Functions

- `initializeUploadPage()` — wires drag/drop, the Browse button, and the Upload button. Runs on `DOMContentLoaded`
- `initializeDragDrop()` — prevents default browser drag/drop behavior, highlights the drop zone while dragging over it, and hands dropped files to `handleFiles()`
- `handleFiles(files)` — takes the first file, validates type and size **client-side** (a first line of defense — the server independently validates everything again; see [backend-routes.md](backend-routes.md#post-apiupload)), stores it as `selectedFile`
- `isValidFileType(file)` — checks MIME type first, falls back to extension
- `updateFileSelected()` — shows the selected filename and size in `#fileSelected`
- `initializeBrowseButton()` — wires the Browse button to open the native file picker, and the hidden `<input type="file">`'s change to `handleFiles()`
- `initializeUploadButton()` — wires the Upload button to `performUpload()`
- `performUpload()` — guards against no file selected, opens the progress modal, calls `uploadFile()`
- `uploadFile()` — builds a `FormData`, `POST`s to `/api/upload`, on success stashes the response in `sessionStorage.keatResults` and shows the success modal, on failure shows a notification with the server's error message
- `showUploadSuccess(payload)` — fills in and opens the success modal, resets `selectedFile`
- `buildUploadSuccessMessage(payload)` — composes the human-readable summary from `rowsProcessed`/`duplicateRowsDropped`/`invalidRowsDropped`; when `skippedUnmatchedRows > 0` it lists the distinct `unmatchedProductNames`, and when `skippedUnpricedRows > 0` it lists the `unpricedProductNames` (rows skipped because no price could be determined), each ending with a `.form-note-warning`-styled note telling staff to fix the catalog and re-upload. Returns HTML with block-level tags (`<p>`/`<ul>`/`<div>`) now, which is why `#uploadSuccessMessage`'s container in `upload.html` is a `<div>`, not a `<p>` (a `<p>` can't validly contain block children)
- `escapeHtml(value)` — HTML-escapes a string
- `closeUploadSuccess()` — closes the modal, resets the progress bar

## `static/css/style.css`

One stylesheet, ~2570 lines, organized into clearly-commented sections (no
preprocessor — plain CSS with custom properties).

### `:root` custom properties
- **Color palette** (coffee/café theme): `--cream`, `--ivory`,
  `--brown-dark`, `--brown-medium`, `--brown-light`, `--text-dark`,
  `--text-light`, `--border-color`, `--hover-brown`
- **Spacing scale**: `--spacing-xs` (4px) through `--spacing-2xl` (48px)
- **Border radius scale**: `--radius-sm`/`-md`/`-lg`/`-full`
- **Typography**: `--font-primary` (Poppins), `--font-display` (Cormorant
  Garamond)
- **Border shorthands**: `--border-thin`, `--border-medium`

### Section map

| Section | Covers |
|---|---|
| Global & Reset | `*` box-sizing reset, base `body` styles |
| Typography | Heading sizes, `.text-sm`/`.text-xs`, `.logo` |
| Links & Buttons | `.btn-primary`/`.btn-secondary`/`.btn-small` |
| Forms | Base `input`/`select`/`textarea` styling, `.form-group`, `.form-note` (and `.form-note-warning` — a visually distinct variant reusing the app's existing warning/error red, for the upload success modal's unmatched-products note), `.checkbox-group`, `.error-message` |
| Layout: Login Page | `.login-container` split-screen layout and its children |
| Layout: Authenticated Pages | `.app-container` (`100dvh`, with a `100vh` fallback), `.sidebar` + nav, `.hamburger` and the off-canvas sidebar below 768px, `.main-content` (`min-width: 0`, so wide content scrolls inside its own box instead of widening the page), `.page-header`, `.user-profile`/`.user-avatar`/`.settings-gear` |
| Dashboard Components | `.filter-bar`/`.filter-group`, `.quick-filter-btn`, `.checkbox-dropdown` (and children `-toggle`/`-panel`/`-item`/`-all`/`-search`/`-empty` — the shared component both the Category and Product filters use), `.stats-grid`/`.stat-card`, `.info-tooltip`, `.chart-container`/`.chart-wrapper`/`.charts-row` |
| Print Report Button | `.filter-group-print` (right end of the Dashboard filter bar, bottom-aligned with the controls), `.print-report-btn-wrap` (right end of the Analytics tabs row), `.print-report-btn` (+ its `:disabled` look — scoped to this class so no other `.btn-primary` changes), and `.print-report { display: none; }` for the on-screen state of `#printReport` |
| Analytics Components | `.stat-box`, `.search-bar`/`.search-dropdown`, `.analytics-tabs`, `.bundles-filters`, `.category-grid`/`.category-tile`, `.drilldown-subheader`, `.product-detail-card`, `.approximate-marker` (the hover-tooltipped `~` next to a stale, pending-remine confidence value) |
| Tables | `.table-container` (scrolls horizontally at every width), `.action-icons` |
| Products Page | `.products-header`, `.products-toolbar`, `.category-filter`, `.product-name-cell`/`.product-alias-cell` |
| Upload Page | `.upload-container`/`.upload-row`/`.upload-left`/`.upload-right`, `.upload-info-box`, `.required-fields-list` |
| Modals | `.modal-overlay`/`.modal`/`.modal-header`/`.modal-body`/`.modal-footer` — `.modal` is capped to `85vh` and laid out as a flex column so a long `.modal-body` (e.g. the upload success modal's unmatched-products list) scrolls within itself instead of overflowing the viewport, while the header/footer stay fixed |
| Help Modal | `.help-content` |
| Notifications | `.notification` (the floating toast `showNotification()` creates) |
| Responsive Design | Breakpoints at 1200px, 992px, 768px and 480px — see [Responsive design](#responsive-design) below |
| Utility Classes | `.hidden`, `.text-center`/`.text-right`, `.mt-*`/`.mb-*`/`.gap-*` spacing helpers |
| Print | Named pages `@page report` (A4 portrait, 15mm margins) and `@page report-landscape`, both with a "Page X of Y" `@bottom-right` margin box (shown where the browser supports margin boxes). Named rather than a bare `@page` so printing any other page keeps the browser's default paper/margins. Then `@media print`: while `body.printing-report` is set, every direct child of `<body>` except `#printReport` is hidden (sidebar, header, filters, tabs, modals, toasts, flatpickr calendars), `#printReport` is shown on the `report` page (`report-landscape` with `body.print-landscape`), and `html`/`body` go white. Report styling: `.report-header`/`.report-logo`/`.report-title`/`.report-filters`, `.report-section` (+ `.report-section-break`), `.report-table` (light-grey header row with `print-color-adjust: exact`, thin borders, right-aligned `.report-num`, bold `.report-total-row`), `thead { display: table-header-group }` so header rows repeat on each page, `tr { break-inside: avoid }`, headings `break-after: avoid`; plus the chart styling (`.report-chart-card`, legends, `.report-pie*`, `.report-summary-callout`, and the `.report-hour-*` heat grid) |

### Responsive design

The layout adapts by viewport width. Page and component sections hold
their base styles; the breakpoints live in the Responsive Design section
(plus a few small `@media` blocks next to the login page, sidebar, tables
and upload styles).

| Width | What changes |
|---|---|
| ≤ 1200px | Dashboard stat cards go to 2 columns; chart rows stack to 1 column |
| ≤ 992px (tablet) | Sidebar narrows to a 96px icon rail (smaller labels so "Dashboard" fits its selection box); tighter page padding; Analytics header and Products toolbar wrap; Analytics category tiles and Level 2/3 table cells shrink; Upload page stacks to one column with less padding |
| ≤ 768px (phone) | Sidebar becomes a slide-out menu: hidden off-screen, opened by `#hamburger`, half the screen wide (200–320px), links laid out as icon + label rows, page behind dimmed. Header title shrinks and truncates; user name/role hidden. Inputs go to 16px (stops iOS zoom-on-focus). Dashboard filters stack full-width (dates side by side), Print Report full-width, stat cards 2 columns, charts one per row at 260px. Analytics stat boxes share a row; search bar and dropdown full-width; category tiles 1 column. Products toolbar stacks. Tables keep a 600px min-width and scroll sideways. Modals fit the screen; notifications span the top |
| ≤ 480px (small phone) | Date filters, stat cards and the upload field lists go to 1 column; quick-filter and Analytics tab buttons fill the row; chart height 220px; modal buttons full-width |

`.charts-row > *` and `.stats-grid > *` set `min-width: 0` so a chart canvas
can't hold its grid column wider than the screen.

The `.checkbox-dropdown-search` rule (styling the Product filter's search
input) and the `.stats-grid` 4-column layout are the two style additions
tied directly to the Dashboard filter/stat-card changes documented in
[architecture.md](architecture.md).
