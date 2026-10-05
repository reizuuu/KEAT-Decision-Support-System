/* ====================================
   KEAT DECISION SUPPORT SYSTEM
   Analytics JavaScript - three-level drill-down
   (Level 1: categories -> Level 2: products in a category ->
    Level 3: one product's rule rows)
   ==================================== */

let analyticsData = { rulesGenerated: 0, transactions: 0, categories: [], bundles: [] };
// productName -> { product, category, ruleCount, rows }
let productIndex = new Map();

let currentLevel = 1;
let currentCategory = null;
let currentProduct = null;
// Which view Level 3 should return to: null = Level 1, otherwise a category name.
let level3CameFromCategory = null;
let level2SortDirection = 'asc';
let level2FilterTerm = '';
// Sorts Level 3's rule rows by confidencePercent ("Chance of Buying
// Together") - independent of level2SortDirection, which sorts Level 2's
// product list alphabetically instead.
let level3SortDirection = 'asc';

// This is a second, separate view from the Level 1/2/3 drill-down (see
// showAnalyticsTab) - a flat table of every persisted rule, independently
// sortable/filterable, rather than the browse hierarchy above.
let bundlesData = [];
// Default order is the backend's composite-score rank (services/mining.rank_rules).
let bundlesSortKey = 'rank';
let bundlesSortDirection = 'asc';
// 'browse' or 'bundles' - which tab is showing. The Print Report button
// prints whichever table this (plus currentLevel, for Browse) points at.
let currentAnalyticsTab = 'browse';

// Plain column names for the bundles table - the on-screen headers get a
// ▲/▼ appended (updateBundlesSortIndicators), the printed ones don't.
const BUNDLES_COLUMN_LABELS = {
    rank: 'Rank',
    products: 'Products',
    score: 'Score',
    support: 'Support',
    confidence: 'Confidence',
    lift: 'Lift',
    leverage: 'Leverage',
    conviction: 'Conviction'
};

// "Recalculating market insights..." badge - shown while any rule in the
// last-loaded payload is still Rules.is_approximate (stale pending the
// background remine a soft-delete kicks off - see
// services/persistence.prune_rules_for_product / remine_rules). Polls a
// small dedicated endpoint rather than re-fetching the full /api/analytics
// payload on every tick.
const RECALC_POLL_INTERVAL_MS = 4000;
let recalcPollTimer = null;

document.addEventListener('DOMContentLoaded', function() {
    if (document.getElementById('analyticsLevel1')) {
        initializeAnalyticsPage();
    }
});

async function initializeAnalyticsPage() {
    await loadAnalyticsData();
    wireControls();
    wireBundlesControls();
    wirePrintReportButton();
    showLevel1();
}

async function loadAnalyticsData() {
    try {
        const response = await fetch('/api/analytics');
        if (response.ok) {
            analyticsData = await response.json();
        }
    } catch (error) {
        console.warn('Unable to load analytics.', error);
    }

    productIndex = new Map();
    (analyticsData.categories || []).forEach(categoryEntry => {
        categoryEntry.products.forEach(productEntry => {
            productIndex.set(productEntry.product, {
                ...productEntry,
                category: categoryEntry.category,
            });
        });
    });
    bundlesData = analyticsData.bundles || [];

    const rulesEl = document.getElementById('statRulesGenerated');
    const transactionsEl = document.getElementById('statTransactions');
    if (rulesEl) rulesEl.textContent = formatNumber(analyticsData.rulesGenerated || 0);
    if (transactionsEl) transactionsEl.textContent = formatNumber(analyticsData.transactions || 0);

    updateRecalculatingBadge();
}

function payloadHasApproximateRules() {
    const categories = analyticsData.categories || [];
    const hasApproximateBrowseRow = categories.some(categoryEntry =>
        categoryEntry.products.some(productEntry =>
            (productEntry.rows || []).some(row => row.isApproximate)
        )
    );
    return hasApproximateBrowseRow || bundlesData.some(rule => rule.isApproximate);
}

function updateRecalculatingBadge() {
    const badge = document.getElementById('recalculatingBadge');
    if (payloadHasApproximateRules()) {
        if (badge) badge.hidden = false;
        startRecalcPolling();
    } else {
        if (badge) badge.hidden = true;
        stopRecalcPolling();
    }
}

function startRecalcPolling() {
    if (recalcPollTimer) return;
    recalcPollTimer = setInterval(async () => {
        try {
            const response = await fetch('/api/analytics/status');
            if (!response.ok) return;
            const payload = await response.json();
            if (!payload.hasApproximateRules) {
                stopRecalcPolling();
                await loadAnalyticsData();
                rerenderCurrentView();
            }
        } catch (error) {
            console.warn('Unable to poll analytics status.', error);
        }
    }, RECALC_POLL_INTERVAL_MS);
}

function stopRecalcPolling() {
    if (recalcPollTimer) {
        clearInterval(recalcPollTimer);
        recalcPollTimer = null;
    }
}

// Re-renders whatever the user currently has open, with the now-final
// numbers loadAnalyticsData() just fetched - both the Browse drill-down
// level in view and, if the Product Bundles tab is the active one, its
// table too (the two views can be open independently of each other).
function rerenderCurrentView() {
    if (currentLevel === 1) {
        renderCategoryGrid();
    } else if (currentLevel === 2) {
        renderLevel2List();
    } else if (currentLevel === 3) {
        const entry = productIndex.get(currentProduct);
        if (entry) renderLevel3Rows(entry);
    }

    const bundlesView = document.getElementById('analyticsBundlesView');
    if (bundlesView && !bundlesView.hidden) {
        renderBundlesTable();
    }
}

function wireControls() {
    const searchInput = document.getElementById('analyticsSearch');
    const searchDropdown = document.getElementById('searchDropdown');
    const level2BackBtn = document.getElementById('level2BackBtn');
    const level3BackBtn = document.getElementById('level3BackBtn');
    const sortToggle = document.getElementById('level2SortToggle');
    const level3SortToggle = document.getElementById('level3SortToggle');

    if (searchInput) {
        searchInput.addEventListener('input', function() {
            if (currentLevel === 2) {
                level2FilterTerm = this.value;
                renderLevel2List();
                hideSearchDropdown();
            } else {
                renderSearchDropdown(this.value);
            }
        });

        searchInput.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter' || currentLevel === 2) return;
            const matches = matchingProducts(this.value);
            if (matches.length === 1) {
                selectSearchResult(matches[0].product);
            }
        });

        document.addEventListener('click', function(event) {
            if (!event.target.closest('.controls-row')) {
                hideSearchDropdown();
            }
        });
    }

    if (level2BackBtn) level2BackBtn.addEventListener('click', showLevel1);
    if (level3BackBtn) {
        level3BackBtn.addEventListener('click', function() {
            if (level3CameFromCategory) {
                showLevel2(level3CameFromCategory);
            } else {
                showLevel1();
            }
        });
    }
    if (sortToggle) {
        sortToggle.addEventListener('click', function() {
            level2SortDirection = level2SortDirection === 'asc' ? 'desc' : 'asc';
            sortToggle.textContent = level2SortDirection === 'asc' ? 'Ascending' : 'Descending';
            renderLevel2List();
        });
    }
    if (level3SortToggle) {
        level3SortToggle.addEventListener('click', function() {
            level3SortDirection = level3SortDirection === 'asc' ? 'desc' : 'asc';
            level3SortToggle.textContent = level3SortDirection === 'asc' ? 'Ascending' : 'Descending';
            const entry = productIndex.get(currentProduct);
            if (entry) renderLevel3Rows(entry);
        });
    }
}

// ====================================
// SEARCH
// ====================================

function matchingProducts(term) {
    const trimmed = term.trim().toLowerCase();
    if (!trimmed) return [];
    return Array.from(productIndex.values()).filter(entry =>
        entry.product.toLowerCase().includes(trimmed)
    );
}

function renderSearchDropdown(term) {
    const dropdown = document.getElementById('searchDropdown');
    if (!dropdown) return;

    const matches = matchingProducts(term);
    if (!term.trim() || matches.length === 0) {
        hideSearchDropdown();
        return;
    }

    dropdown.innerHTML = matches
        .map(entry => `<div class="search-dropdown-item" data-product="${escapeHtml(entry.product)}">${escapeHtml(entry.product)} <span class="search-dropdown-item-category">${escapeHtml(entry.category)}</span></div>`)
        .join('');
    dropdown.hidden = false;

    dropdown.querySelectorAll('.search-dropdown-item').forEach(item => {
        item.addEventListener('click', function() {
            selectSearchResult(this.getAttribute('data-product'));
        });
    });
}

function hideSearchDropdown() {
    const dropdown = document.getElementById('searchDropdown');
    if (dropdown) {
        dropdown.hidden = true;
        dropdown.innerHTML = '';
    }
}

function selectSearchResult(productName) {
    hideSearchDropdown();
    showLevel3(productName, null);
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

// ====================================
// LEVEL 1: CATEGORY GRID
// ====================================

function showLevel1() {
    currentLevel = 1;
    currentCategory = null;
    currentProduct = null;
    clearSearchInputKeepingDropdownHidden();

    setLevelVisibility(1);
    renderCategoryGrid();
}

function renderCategoryGrid() {
    updateAnalyticsPrintButton();
    const grid = document.getElementById('categoryGrid');
    const emptyMessage = document.getElementById('level1EmptyMessage');
    if (!grid) return;

    const categories = analyticsData.categories || [];
    if (categories.length === 0) {
        grid.innerHTML = '';
        if (emptyMessage) emptyMessage.hidden = false;
        return;
    }
    if (emptyMessage) emptyMessage.hidden = true;

    grid.innerHTML = categories
        .map(entry => `<button class="category-tile" data-category="${escapeHtml(entry.category)}">${escapeHtml(entry.category)}</button>`)
        .join('');

    grid.querySelectorAll('.category-tile').forEach(tile => {
        tile.addEventListener('click', function() {
            showLevel2(this.getAttribute('data-category'));
        });
    });
}

// ====================================
// LEVEL 2: CATEGORY -> PRODUCT LIST
// ====================================

function showLevel2(categoryName) {
    currentLevel = 2;
    currentCategory = categoryName;
    currentProduct = null;
    level2FilterTerm = '';
    clearSearchInputKeepingDropdownHidden();

    const titleEl = document.getElementById('level2CategoryTitle');
    if (titleEl) titleEl.textContent = categoryName;

    setLevelVisibility(2);
    renderLevel2List();
}

// currentCategory's products, filtered by the search box and sorted - the
// single source for both renderLevel2List() and the Print Report output, so
// the printed list can't drift from the one on screen.
function getLevel2Products() {
    if (!currentCategory) return [];
    const categoryEntry = (analyticsData.categories || []).find(entry => entry.category === currentCategory);
    let products = categoryEntry ? categoryEntry.products.slice() : [];

    if (level2FilterTerm.trim()) {
        const term = level2FilterTerm.trim().toLowerCase();
        products = products.filter(entry => entry.product.toLowerCase().includes(term));
    }

    products.sort((a, b) => a.product.localeCompare(b.product));
    if (level2SortDirection === 'desc') products.reverse();
    return products;
}

function renderLevel2List() {
    updateAnalyticsPrintButton();
    const tbody = document.getElementById('level2ProductList');
    if (!tbody || !currentCategory) return;

    const products = getLevel2Products();

    if (products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="table-empty-message">No products match your search.</td></tr>';
        return;
    }

    tbody.innerHTML = products
        .map(entry => `
            <tr class="clickable-row" data-product="${escapeHtml(entry.product)}">
                <td>${escapeHtml(entry.product)}</td>
                <td>${entry.ruleCount} combo${entry.ruleCount === 1 ? '' : 's'} found</td>
                <td class="row-expand-cell">
                    <button type="button" class="row-expand-btn" aria-label="View combos for ${escapeHtml(entry.product)}">
                        Open
                    </button>
                </td>
            </tr>
        `)
        .join('');

    tbody.querySelectorAll('tr[data-product]').forEach(row => {
        row.addEventListener('click', function() {
            showLevel3(this.getAttribute('data-product'), currentCategory);
        });
    });
}

// ====================================
// LEVEL 3: PRODUCT -> RULE ROWS
// ====================================

function showLevel3(productName, cameFromCategory) {
    const entry = productIndex.get(productName);
    if (!entry) return;

    currentLevel = 3;
    currentProduct = productName;
    level3CameFromCategory = cameFromCategory;

    const titleEl = document.getElementById('level3ProductTitle');
    const cardTitleEl = document.getElementById('level3ProductCardTitle');
    if (titleEl) titleEl.textContent = productName;
    if (cardTitleEl) cardTitleEl.textContent = productName;

    setLevelVisibility(3);
    renderLevel3Rows(entry);
}

function joinWithAnd(names) {
    if (names.length <= 1) return names[0] || '';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Rendered next to a confidence value whenever its underlying rule was
// structurally patched (not re-mined) by a product delete's instant prune
// - see Rules.is_approximate / services/persistence.prune_rules_for_product.
// A native `title` attribute rather than the .info-tooltip click-modal
// component, since this specifically calls for a hover tooltip.
function approximateMarkerHtml(isApproximate) {
    if (!isApproximate) return '';
    return ' <span class="approximate-marker" title="Approximate value. The exact probability is currently being recalculated due to recent catalog updates.">~</span>';
}

// A product's rule rows sorted by level3SortDirection, and each row's
// "Frequently Bought Together" label - shared by renderLevel3Rows() and the
// Print Report output, so both show the same rows in the same order/wording.
function getLevel3Rows(entry) {
    if (!entry || !entry.rows) return [];
    return entry.rows.slice().sort((a, b) => {
        const direction = level3SortDirection === 'asc' ? 1 : -1;
        return direction * (a.confidencePercent - b.confidencePercent);
    });
}

function formatLevel3RowLabel(row) {
    const consequentLabel = joinWithAnd(row.consequents);
    return row.otherAntecedents && row.otherAntecedents.length
        ? `+ ${row.otherAntecedents.join(', ')} → ${consequentLabel}`
        : consequentLabel;
}

function renderLevel3Rows(entry) {
    updateAnalyticsPrintButton();
    const tbody = document.getElementById('level3RuleRows');
    if (!tbody) return;

    const rows = getLevel3Rows(entry);
    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" class="table-empty-message">No combos found for this product yet.</td></tr>';
        return;
    }

    tbody.innerHTML = rows
        .map(row => {
            const label = formatLevel3RowLabel(row);
            return `
                <tr>
                    <td><strong>${escapeHtml(label)}</strong></td>
                    <td style="font-weight: 600;">${row.confidencePercent}%${approximateMarkerHtml(row.isApproximate)}</td>
                </tr>
            `;
        })
        .join('');
}

// ====================================
// SHARED
// ====================================

function setLevelVisibility(level) {
    const level1 = document.getElementById('analyticsLevel1');
    const level2 = document.getElementById('analyticsLevel2');
    const level3 = document.getElementById('analyticsLevel3');
    if (level1) level1.hidden = level !== 1;
    if (level2) level2.hidden = level !== 2;
    if (level3) level3.hidden = level !== 3;
}

function clearSearchInputKeepingDropdownHidden() {
    const searchInput = document.getElementById('analyticsSearch');
    if (searchInput) searchInput.value = '';
    hideSearchDropdown();
}

// ====================================
// ALL RULES: FLAT PRODUCT BUNDLES TABLE
// ====================================

function wireBundlesControls() {
    const tabBrowse = document.getElementById('analyticsTabBrowse');
    const tabBundles = document.getElementById('analyticsTabBundles');
    if (tabBrowse) tabBrowse.addEventListener('click', () => showAnalyticsTab('browse'));
    if (tabBundles) tabBundles.addEventListener('click', () => showAnalyticsTab('bundles'));

    ['bundlesMinSupport', 'bundlesMinConfidence', 'bundlesMinLift'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.addEventListener('input', renderBundlesTable);
    });

    document.querySelectorAll('#analyticsBundlesView th.sortable-th').forEach(th => {
        th.addEventListener('click', function() {
            const key = this.getAttribute('data-sort-key');
            if (bundlesSortKey === key) {
                bundlesSortDirection = bundlesSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                bundlesSortKey = key;
                bundlesSortDirection = 'asc';
            }
            renderBundlesTable();
        });
    });
}

function showAnalyticsTab(tab) {
    const browseView = document.getElementById('analyticsBrowseView');
    const bundlesView = document.getElementById('analyticsBundlesView');
    const tabBrowse = document.getElementById('analyticsTabBrowse');
    const tabBundles = document.getElementById('analyticsTabBundles');

    currentAnalyticsTab = tab;
    if (browseView) browseView.hidden = tab !== 'browse';
    if (bundlesView) bundlesView.hidden = tab !== 'bundles';
    if (tabBrowse) tabBrowse.classList.toggle('active', tab === 'browse');
    if (tabBundles) tabBundles.classList.toggle('active', tab === 'bundles');

    if (tab === 'bundles') renderBundlesTable();
    updateAnalyticsPrintButton();
}

// The three min-threshold inputs, read the same way the filter always has
// (blank/unparseable = 0 = no filter). `isSet` lets the printed report say
// "None" for a blank box instead of "0.000".
function getBundlesThresholds() {
    const readThreshold = id => {
        const input = document.getElementById(id);
        const raw = input ? input.value.trim() : '';
        const parsed = parseFloat(raw);
        return { isSet: raw !== '' && !isNaN(parsed), value: parsed || 0 };
    };
    return {
        support: readThreshold('bundlesMinSupport'),
        confidence: readThreshold('bundlesMinConfidence'),
        lift: readThreshold('bundlesMinLift')
    };
}

// The bundle rows the table shows: threshold-filtered, then sorted by the
// current column/direction - shared by renderBundlesTable() and the Print
// Report output.
function getFilteredBundleRows(thresholds) {
    const limits = thresholds || getBundlesThresholds();
    return bundlesData
        .filter(rule =>
            (rule.support || 0) >= limits.support.value &&
            (rule.confidence || 0) >= limits.confidence.value &&
            (rule.lift || 0) >= limits.lift.value
        )
        .sort((a, b) => compareBundleRows(a, b, bundlesSortKey, bundlesSortDirection));
}

function renderBundlesTable() {
    updateAnalyticsPrintButton();
    const tbody = document.getElementById('bundlesTableBody');
    const emptyMessage = document.getElementById('bundlesEmptyMessage');
    if (!tbody) return;

    if (!bundlesData || bundlesData.length === 0) {
        tbody.innerHTML = '';
        if (emptyMessage) {
            emptyMessage.textContent = 'No association rules yet. Upload a file to get started.';
            emptyMessage.hidden = false;
        }
        updateBundlesSortIndicators();
        return;
    }

    const rows = getFilteredBundleRows();

    if (rows.length === 0) {
        tbody.innerHTML = '';
        if (emptyMessage) {
            emptyMessage.textContent = 'No rules match these filters.';
            emptyMessage.hidden = false;
        }
        updateBundlesSortIndicators();
        return;
    }
    if (emptyMessage) emptyMessage.hidden = true;

    tbody.innerHTML = rows
        .map(rule => `
            <tr>
                <td>${rule.rank}</td>
                <td>${escapeHtml(rule.products)}</td>
                <td>${formatBundleMetric(rule.support)}</td>
                <td>${formatBundleMetric(rule.confidence)}${approximateMarkerHtml(rule.isApproximate)}</td>
                <td>${formatBundleMetric(rule.lift)}</td>
                <td>${formatBundleMetric(rule.leverage, 4)}</td>
                <td>${formatBundleMetric(rule.conviction)}</td>
                <td>${formatBundleMetric(rule.score, 4)}</td>
            </tr>
        `)
        .join('');

    updateBundlesSortIndicators();
}

function compareBundleRows(a, b, key, direction) {
    const directionFactor = direction === 'asc' ? 1 : -1;
    if (key === 'products') {
        return directionFactor * a.products.localeCompare(b.products);
    }
    const aValue = a[key];
    const bValue = b[key];
    // Nulls (e.g. infinite conviction, when confidence is exactly 100%)
    // always sort last, regardless of direction.
    // Equal values (including two nulls) fall back to the composite rank,
    // so ties keep the backend's tie-breaker order.
    if (aValue === null && bValue === null) return a.rank - b.rank;
    if (aValue === null) return 1;
    if (bValue === null) return -1;
    return directionFactor * (aValue - bValue) || a.rank - b.rank;
}

// Leverage and Score use 4 decimals so the small differences that drive
// the ranking's tie-breakers are visible.
function formatBundleMetric(value, decimals = 3) {
    if (value === null || value === undefined) return '∞';
    return Number(value).toFixed(decimals);
}

function updateBundlesSortIndicators() {
    document.querySelectorAll('#analyticsBundlesView th.sortable-th').forEach(th => {
        let label = th.getAttribute('data-label');
        if (!label) {
            label = th.textContent.trim();
            th.setAttribute('data-label', label);
        }
        const key = th.getAttribute('data-sort-key');
        th.textContent = key === bundlesSortKey ? `${label} ${bundlesSortDirection === 'asc' ? '▲' : '▼'}` : label;
    });
}

// ====================================
// PRINT REPORT
// ====================================

/* Prints only the table currently on screen, honoring every control that's
   shaping it (tab, drill-down level, search, sort, thresholds). The rows
   come from the same getLevel2Products / getLevel3Rows / getFilteredBundleRows
   helpers the render functions use, so the printout can't drift from the
   screen. Shared building blocks (header, table, print/cleanup) live in
   script.js. */

const PRINT_NO_ROWS_REASON = 'No rows match the current filters.';
const APPROXIMATE_FOOTNOTE = '~ Approximate value, currently being recalculated';

function wirePrintReportButton() {
    const button = document.getElementById('printReportBtn');
    if (!button) return;
    button.addEventListener('click', printAnalyticsReport);
}

// Called at the top of every render function (and on tab switches): by the
// time a render runs, the state it depends on is already final, and those
// are the only points where the printable table can change.
function updateAnalyticsPrintButton() {
    const button = document.getElementById('printReportBtn');
    // Browse Level 1 is a category grid, not a table - there's never
    // anything to print there, so the button is hidden rather than disabled.
    const isBrowseLevel1 = currentAnalyticsTab === 'browse' && currentLevel === 1;
    if (button && button.parentElement) button.parentElement.hidden = isBrowseLevel1;
    if (isBrowseLevel1) return;

    const view = buildAnalyticsPrintableView();
    setPrintButtonState(button, !view.disabledReason, view.disabledReason);
}

function formatSortDirectionLabel(direction) {
    return direction === 'asc' ? 'Ascending' : 'Descending';
}

function formatThresholdValue(threshold) {
    return threshold.isSet ? threshold.value.toFixed(3) : 'None';
}

// Describes exactly what the Print Report button would print for the view
// on screen - {viewName, sectionTitle, filterLines, columns, align, rows,
// hasApproximate, landscape} - or {disabledReason} when there's no table to
// print. An empty table disables the button rather than printing an empty
// page (one consistent rule for every view).
function buildAnalyticsPrintableView() {
    if (currentAnalyticsTab === 'bundles') {
        if (!bundlesData || bundlesData.length === 0) {
            return { disabledReason: 'No association rules yet. Upload a file to get started.' };
        }
        const thresholds = getBundlesThresholds();
        const rules = getFilteredBundleRows(thresholds);
        if (rules.length === 0) return { disabledReason: PRINT_NO_ROWS_REASON };

        return {
            viewName: 'Product Bundles',
            sectionTitle: 'Product Bundles',
            filterLines: [
                { label: 'Min support', value: formatThresholdValue(thresholds.support) },
                { label: 'Min confidence', value: formatThresholdValue(thresholds.confidence) },
                { label: 'Min lift', value: formatThresholdValue(thresholds.lift) },
                { label: 'Sorted by', value: `${BUNDLES_COLUMN_LABELS[bundlesSortKey]} (${formatSortDirectionLabel(bundlesSortDirection)})` }
            ],
            columns: ['rank', 'products', 'support', 'confidence', 'lift', 'leverage', 'conviction', 'score'].map(key => BUNDLES_COLUMN_LABELS[key]),
            align: ['right', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
            rows: rules.map(rule => [
                String(rule.rank),
                rule.products,
                formatBundleMetric(rule.support),
                formatBundleMetric(rule.confidence) + (rule.isApproximate ? ' ~' : ''),
                formatBundleMetric(rule.lift),
                formatBundleMetric(rule.leverage, 4),
                formatBundleMetric(rule.conviction),
                formatBundleMetric(rule.score, 4)
            ]),
            hasApproximate: rules.some(rule => rule.isApproximate),
            // Eight columns with a free-text Products column read better with
            // the extra width.
            landscape: true
        };
    }

    if (currentLevel === 2 && currentCategory) {
        const products = getLevel2Products();
        if (products.length === 0) return { disabledReason: PRINT_NO_ROWS_REASON };

        const filterLines = [{ label: 'Category', value: currentCategory }];
        if (level2FilterTerm.trim()) filterLines.push({ label: 'Search', value: level2FilterTerm.trim() });
        filterLines.push({ label: 'Sorted by', value: `Product name (${formatSortDirectionLabel(level2SortDirection)})` });

        return {
            viewName: 'Category Products',
            sectionTitle: `Products in ${currentCategory}`,
            filterLines,
            columns: ['Product', 'Combos Found'],
            align: ['left', 'right'],
            rows: products.map(entry => [entry.product, formatNumber(entry.ruleCount)]),
            hasApproximate: false,
            landscape: false
        };
    }

    if (currentLevel === 3 && currentProduct) {
        const entry = productIndex.get(currentProduct);
        const rows = getLevel3Rows(entry);
        if (rows.length === 0) return { disabledReason: 'This product has no combos to print.' };

        const filterLines = [{ label: 'Product', value: currentProduct }];
        if (entry && entry.category) filterLines.push({ label: 'Category', value: entry.category });
        filterLines.push({ label: 'Sorted by', value: `Chance (${formatSortDirectionLabel(level3SortDirection)})` });

        return {
            viewName: 'Frequently Bought Together',
            sectionTitle: `Frequently bought with ${currentProduct}`,
            filterLines,
            columns: ['Frequently Bought Together', 'Chance of Buying Together'],
            align: ['left', 'right'],
            rows: rows.map(row => [
                formatLevel3RowLabel(row),
                `${row.confidencePercent}%` + (row.isApproximate ? ' ~' : '')
            ]),
            hasApproximate: rows.some(row => row.isApproximate),
            landscape: false
        };
    }

    return { disabledReason: 'Open a category or the Product Bundles tab to print a table.' };
}

function printAnalyticsReport() {
    const view = buildAnalyticsPrintableView();
    if (view.disabledReason) return;

    const header = buildReportHeader(`Product Combos Report – ${view.viewName}`, view.filterLines, {
        metaLines: [
            { label: 'Transactions analysed', value: formatNumber(analyticsData.transactions || 0) },
            { label: 'Combos found', value: formatNumber(analyticsData.rulesGenerated || 0) }
        ],
        note: 'Analytics always uses the full uploaded dataset; the Dashboard date, category and product filters do not apply to this report.'
    });

    let body = renderReportMessage(`${formatNumber(view.rows.length)} row${view.rows.length === 1 ? '' : 's'}`, 'report-caption');
    body += renderReportTable({ columns: view.columns, align: view.align, rows: view.rows });
    if (view.hasApproximate) body += renderReportMessage(APPROXIMATE_FOOTNOTE, 'report-footnote');

    printReportHtml(header + renderReportSection(view.sectionTitle, body), { landscape: view.landscape });
}
