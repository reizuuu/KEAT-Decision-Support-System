/* ====================================
   KEAT DECISION SUPPORT SYSTEM
   Dashboard JavaScript
   ==================================== */

let orderSummaryChart = null;
let bestSellingChart = null;
let transactionVolumeChart = null;
let revenueByCategoryChart = null;
let monthlySalesTrendChart = null;
let topProductsMonthlyChart = null;
let transactionsByDayChart = null;
let transactionsByHourChart = null;

// "Transaction Volume for the Top 10 Products per Month" reorders its
// datasets (which product-series appears first) rather than sorting a
// single axis - defaults to descending total volume on load and is reset
// to descending after every filter-driven refresh (see loadDashboardResults).
let topProductsSortDirection = 'desc';
let lastTopProductsMonthlyData = null;

let currentCategoryOptions = [];
let currentProductOptions = [];
// Empty = "All Categories"/"All Products" (no filter). Populated from
// checked boxes in the Category/Product checkbox-dropdown filters.
let selectedCategories = [];
let selectedProducts = [];
// Substring filter for the Product dropdown's search box - narrows which
// checkboxes render, but never touches selectedProducts (a checked product
// stays checked/counted even while scrolled out of view by the search term).
let productFilterSearchTerm = '';

// flatpickr instances for the Start/End Date filters (see
// initDateFilterPickers) - kept so quick-filter clicks can push a date into
// the picker's own API instead of just setting the underlying input's
// value, which wouldn't update what's on screen.
let startDatePicker = null;
let endDatePicker = null;

// The last /api/results payload the dashboard actually rendered (null = no
// data for those filters), plus a description of the filters that request
// was sent with - captured before the fetch rather than read at click time,
// so a printout can never pair one request's numbers with another's
// filters. The Print Report button builds from these instead of refetching,
// so the printout always matches what's on screen.
let lastDashboardResults = null;
let lastDashboardFilterLines = [];

// Longer selections are cut to this many names + "+N more" in the printed
// report's "Filters applied" block.
const REPORT_FILTER_LIST_LIMIT = 10;

// Ordered so no two array-adjacent entries share a hue family (adjacency is
// always defined by final index position here, regardless of how a chart
// sorts/filters its datasets before calling colorizeDatasets) - hues are
// spaced roughly evenly around the wheel and alternate warm/cool.
const CHART_PALETTE = [
    '#2a78d6', // blue
    '#eb6834', // orange
    '#1baf7a', // teal green
    '#e34948', // red
    '#4a3aa7', // purple
    '#eda100', // amber
    '#008300', // dark green
    '#e87ba4', // pink
    '#6b6b6b', // gray
    '#5D4E37'  // brown
];

// "Transaction Volume for the Top 10 Products per Month" chart's own fixed
// palette (a specific requested set of colors, not the general CHART_PALETTE
// above - other charts that share colorizeDatasets() are unaffected). Same
// spacing logic as CHART_PALETTE: the 5 "similar shade" pairs here (red/pink,
// orange/yellow, teal/green, blue/purple, brown/charcoal) are each placed
// exactly 5 slots apart - the maximum possible separation in a 10-color
// array - so no two array-adjacent entries are a shade of the same hue.
const TOP_PRODUCTS_PALETTE = [
    '#2A9D8F', // teal
    '#E63946', // red
    '#277DA1', // blue
    '#F4A261', // orange
    '#343A40', // charcoal
    '#90BE6D', // green
    '#F15BB5', // pink
    '#6A4C93', // purple
    '#F9C74F', // yellow
    '#795548'  // brown
];

const NO_DATA_MESSAGE = 'No data yet. Upload a file to get started.';

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const orderSummaryValueLabels = {
    id: 'orderSummaryValueLabels',
    afterDatasetsDraw(chart) {
        const dataset = chart.data.datasets[0];
        const meta = chart.getDatasetMeta(0);
        const context = chart.ctx;

        context.save();
        context.fillStyle = '#5D4E37';
        context.font = '600 11px Poppins, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'bottom';

        meta.data.forEach((point, index) => {
            const value = dataset.data[index];
            if (value === null || value === undefined) return;
            context.fillText(formatNumber(value), point.x, point.y - 10);
        });

        context.restore();
    }
};

document.addEventListener('DOMContentLoaded', function() {
    initializeDashboardPage();
});

async function initializeDashboardPage() {
    wireTimePeriodControls();
    wireCategoryProductControls();
    wirePrintReportButton(printDashboardReport);
    // No filters are selected on a fresh page load, so the three requests
    // don't depend on each other - run them in parallel instead of in turn.
    await Promise.all([loadCategoryOptions(), loadProductOptions(), loadDashboardResults()]);
}

// ====================================
// TIME PERIOD: START/END DATE + QUICK FILTERS
// ====================================

function wireTimePeriodControls() {
    const startInput = document.getElementById('startDateFilter');
    const endInput = document.getElementById('endDateFilter');
    const quickButtons = document.querySelectorAll('.quick-filter-btn');

    initDateFilterPickers();

    quickButtons.forEach(button => {
        button.addEventListener('click', function() {
            // Clicking the already-highlighted slicer turns it off instead
            // of reapplying the same range - clears both date inputs back
            // to "all dates" rather than leaving the filter stuck on.
            if (this.classList.contains('active')) {
                clearTimePeriodFilter();
                return;
            }

            const range = this.getAttribute('data-range');
            if (range === 'custom') {
                setActiveQuickFilter('custom');
                return;
            }
            const computed = computeQuickRange(range);
            if (!computed) return;
            setDateFilterValue(startInput, startDatePicker, computed.start);
            setDateFilterValue(endInput, endDatePicker, computed.end);
            setActiveQuickFilter(range);
            loadDashboardResults();
        });
    });
}

// The date filters are rendered as flatpickr-driven text inputs so their
// displayed format (mm/dd/yyyy) is controlled by this code rather than the
// visitor's browser/OS locale - a native <input type="date">'s displayed
// format can't be forced that way. altInput:true keeps the original input
// (#startDateFilter/#endDateFilter) holding the plain ISO yyyy-mm-dd value
// that the rest of this file already reads/writes, while a separate visible
// input shows altFormat - so wireTimePeriodControls()/computeQuickRange()/
// toDateInputValue()/syncQuickFilterHighlight()/loadDashboardResults() don't
// need to change what they read or write, only how it's displayed.
function initDateFilterPickers() {
    const startInput = document.getElementById('startDateFilter');
    const endInput = document.getElementById('endDateFilter');
    if (typeof flatpickr === 'undefined') return;

    const options = {
        altInput: true,
        altFormat: 'm/d/Y',
        dateFormat: 'Y-m-d',
        allowInput: true,
        onChange: function() {
            syncQuickFilterHighlight();
            loadDashboardResults();
        }
    };

    if (startInput) startDatePicker = flatpickr(startInput, options);
    if (endInput) endDatePicker = flatpickr(endInput, options);
}

// Pushes an ISO yyyy-mm-dd value into a date filter, going through the
// flatpickr instance's own API (when there is one) so the visible altInput
// updates too - setting `.value` directly on the picker's original,
// now-hidden input would leave the on-screen mm/dd/yyyy text stale. `false`
// skips flatpickr's onChange, since callers already trigger the resulting
// refresh themselves.
function setDateFilterValue(input, picker, isoValue) {
    if (picker) {
        if (isoValue) {
            picker.setDate(isoValue, false);
        } else {
            picker.clear(false);
        }
        return;
    }
    if (input) input.value = isoValue || '';
}

function clearTimePeriodFilter() {
    const startInput = document.getElementById('startDateFilter');
    const endInput = document.getElementById('endDateFilter');
    setDateFilterValue(startInput, startDatePicker, '');
    setDateFilterValue(endInput, endDatePicker, '');
    setActiveQuickFilter(null);
    loadDashboardResults();
}

// Decision (documented, not guessed silently): "This Week" is Monday-start
// (Monday through today), and "This Year" is Jan 1 - Dec 31 of the current
// year (not Jan 1 - today) - the simpler definition, harmless since future
// dates simply won't match any data yet.
function computeQuickRange(range) {
    const today = new Date();
    if (range === 'today') {
        return { start: toDateInputValue(today), end: toDateInputValue(today) };
    }
    if (range === 'week') {
        const dayOfWeek = today.getDay(); // 0 = Sunday .. 6 = Saturday
        const diffToMonday = (dayOfWeek + 6) % 7;
        const monday = new Date(today);
        monday.setDate(today.getDate() - diffToMonday);
        return { start: toDateInputValue(monday), end: toDateInputValue(today) };
    }
    if (range === 'year') {
        const jan1 = new Date(today.getFullYear(), 0, 1);
        const dec31 = new Date(today.getFullYear(), 11, 31);
        return { start: toDateInputValue(jan1), end: toDateInputValue(dec31) };
    }
    return null;
}

function toDateInputValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Highlights whichever quick filter's computed range matches the current
// date inputs; if the user has hand-edited the dates away from every
// preset, "Custom Range" becomes the highlighted one instead.
function syncQuickFilterHighlight() {
    const startInput = document.getElementById('startDateFilter');
    const endInput = document.getElementById('endDateFilter');
    if (!startInput || !endInput) return;

    const start = startInput.value;
    const end = endInput.value;

    if (!start && !end) {
        setActiveQuickFilter(null);
        return;
    }

    let matchedRange = null;
    ['today', 'week', 'year'].forEach(range => {
        const computed = computeQuickRange(range);
        if (computed && computed.start === start && computed.end === end) {
            matchedRange = range;
        }
    });

    setActiveQuickFilter(matchedRange || 'custom');
}

function setActiveQuickFilter(range) {
    document.querySelectorAll('.quick-filter-btn').forEach(button => {
        button.classList.toggle('active', range !== null && button.getAttribute('data-range') === range);
    });
}

// ====================================
// CATEGORY / PRODUCT CASCADING FILTERS
// ====================================

function wireCategoryProductControls() {
    wireCategoryFilterDropdown();
    wireProductFilterDropdown();
}

function wireCategoryFilterDropdown() {
    const toggleBtn = document.getElementById('categoryFilterToggle');
    const panel = document.getElementById('categoryFilterPanel');
    const allCheckbox = document.getElementById('categoryFilterAll');

    if (toggleBtn && panel) {
        toggleBtn.addEventListener('click', function(event) {
            event.stopPropagation();
            panel.hidden = !panel.hidden;
        });
    }

    document.addEventListener('click', function(event) {
        if (panel && !panel.hidden && !event.target.closest('#categoryFilterDropdown')) {
            panel.hidden = true;
        }
    });

    if (allCheckbox) {
        allCheckbox.addEventListener('change', async function() {
            // "All Categories" acts as a reset, not an independent toggle -
            // checking it clears every individual selection.
            selectedCategories = [];
            renderCategoryFilterList();
            updateCategoryFilterToggleLabel();
            await loadProductOptions();
            loadDashboardResults();
        });
    }
}

function wireProductFilterDropdown() {
    const toggleBtn = document.getElementById('productFilterToggle');
    const panel = document.getElementById('productFilterPanel');
    const allCheckbox = document.getElementById('productFilterAll');
    const searchInput = document.getElementById('productFilterSearch');

    if (toggleBtn && panel) {
        toggleBtn.addEventListener('click', function(event) {
            event.stopPropagation();
            panel.hidden = !panel.hidden;
        });
    }

    document.addEventListener('click', function(event) {
        if (panel && !panel.hidden && !event.target.closest('#productFilterDropdown')) {
            panel.hidden = true;
        }
    });

    if (allCheckbox) {
        allCheckbox.addEventListener('change', function() {
            // "All Products" acts as a reset, not an independent toggle -
            // checking it clears every individual selection.
            selectedProducts = [];
            renderProductFilterList();
            updateProductFilterToggleLabel();
            loadDashboardResults();
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', function() {
            productFilterSearchTerm = this.value;
            renderProductFilterList();
        });
    }
}

async function loadCategoryOptions() {
    try {
        const response = await fetch('/api/categories');
        if (response.ok) {
            const payload = await response.json();
            currentCategoryOptions = payload.categories || [];
        }
    } catch (error) {
        console.warn('Unable to load categories.', error);
    }

    // Drop any previously-checked category that no longer exists, rather
    // than leaving an invalid selection.
    selectedCategories = selectedCategories.filter(name => currentCategoryOptions.includes(name));

    renderCategoryFilterList();
    updateCategoryFilterToggleLabel();
}

function renderCategoryFilterList() {
    const list = document.getElementById('categoryFilterList');
    const allCheckbox = document.getElementById('categoryFilterAll');
    if (!list) return;

    if (currentCategoryOptions.length === 0) {
        list.innerHTML = '<div class="checkbox-dropdown-empty">No categories yet.</div>';
    } else {
        list.innerHTML = currentCategoryOptions
            .map(name => `
                <label class="checkbox-dropdown-item">
                    <input type="checkbox" class="category-filter-checkbox" value="${escapeHtml(name)}" ${selectedCategories.includes(name) ? 'checked' : ''}>
                    <span>${escapeHtml(name)}</span>
                </label>
            `)
            .join('');
    }

    if (allCheckbox) allCheckbox.checked = selectedCategories.length === 0;

    list.querySelectorAll('.category-filter-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', async function() {
            const name = this.value;
            if (this.checked) {
                if (!selectedCategories.includes(name)) selectedCategories.push(name);
            } else {
                selectedCategories = selectedCategories.filter(selected => selected !== name);
            }
            if (allCheckbox) allCheckbox.checked = selectedCategories.length === 0;
            updateCategoryFilterToggleLabel();
            // Re-scopes the Product dropdown to the union of products
            // across every selected category before refreshing results.
            await loadProductOptions();
            loadDashboardResults();
        });
    });
}

function updateCategoryFilterToggleLabel() {
    const label = document.getElementById('categoryFilterToggleLabel');
    if (!label) return;

    if (selectedCategories.length === 0) {
        label.textContent = 'All Categories';
    } else if (selectedCategories.length === 1) {
        label.textContent = selectedCategories[0];
    } else {
        label.textContent = `${selectedCategories.length} categories selected`;
    }
}

async function loadProductOptions() {
    const params = new URLSearchParams();
    selectedCategories.forEach(name => params.append('category', name));
    const query = params.toString();

    try {
        const response = await fetch(`/api/products${query ? '?' + query : ''}`);
        if (response.ok) {
            const payload = await response.json();
            currentProductOptions = (payload.products || []).map(product => product.name);
        }
    } catch (error) {
        console.warn('Unable to load products.', error);
        currentProductOptions = [];
    }

    // Drop any previously-checked product that's no longer valid under the
    // newly-scoped category selection, rather than leaving an invalid
    // selection.
    selectedProducts = selectedProducts.filter(name => currentProductOptions.includes(name));

    // The search box narrows a list scoped to a particular category
    // selection - once that scope changes, a stale search term could hide
    // every option in the new list, so it's cleared along with it.
    productFilterSearchTerm = '';
    const searchInput = document.getElementById('productFilterSearch');
    if (searchInput) searchInput.value = '';

    renderProductFilterList();
    updateProductFilterToggleLabel();
}

function renderProductFilterList() {
    const list = document.getElementById('productFilterList');
    const allCheckbox = document.getElementById('productFilterAll');
    if (!list) return;

    const term = productFilterSearchTerm.trim().toLowerCase();
    // Filtering only changes which checkboxes render - selectedProducts is
    // never touched here, so a checked product stays checked/counted even
    // while scrolled out of view by the search term.
    const visibleOptions = term
        ? currentProductOptions.filter(name => name.toLowerCase().includes(term))
        : currentProductOptions;

    if (currentProductOptions.length === 0) {
        list.innerHTML = '<div class="checkbox-dropdown-empty">No products in this category.</div>';
    } else if (visibleOptions.length === 0) {
        list.innerHTML = '<div class="checkbox-dropdown-empty">No products match your search.</div>';
    } else {
        list.innerHTML = visibleOptions
            .map(name => `
                <label class="checkbox-dropdown-item">
                    <input type="checkbox" class="product-filter-checkbox" value="${escapeHtml(name)}" ${selectedProducts.includes(name) ? 'checked' : ''}>
                    <span>${escapeHtml(name)}</span>
                </label>
            `)
            .join('');
    }

    if (allCheckbox) allCheckbox.checked = selectedProducts.length === 0;

    list.querySelectorAll('.product-filter-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', function() {
            const name = this.value;
            if (this.checked) {
                if (!selectedProducts.includes(name)) selectedProducts.push(name);
            } else {
                selectedProducts = selectedProducts.filter(selected => selected !== name);
            }
            if (allCheckbox) allCheckbox.checked = selectedProducts.length === 0;
            updateProductFilterToggleLabel();
            loadDashboardResults();
        });
    });
}

function updateProductFilterToggleLabel() {
    const label = document.getElementById('productFilterToggleLabel');
    if (!label) return;

    if (selectedProducts.length === 0) {
        label.textContent = 'All Products';
    } else if (selectedProducts.length === 1) {
        label.textContent = selectedProducts[0];
    } else {
        label.textContent = `${selectedProducts.length} products selected`;
    }
}

async function loadDashboardResults() {
    const startInput = document.getElementById('startDateFilter');
    const endInput = document.getElementById('endDateFilter');

    const params = new URLSearchParams();
    if (startInput && startInput.value) params.set('start_date', startInput.value);
    if (endInput && endInput.value) params.set('end_date', endInput.value);
    selectedCategories.forEach(name => params.append('category', name));
    selectedProducts.forEach(name => params.append('product', name));
    const query = params.toString();
    const filterLines = buildDashboardReportFilterLines();

    // Disabled while the request is in flight, so a click can't print the
    // previous filters' numbers while the screen is about to change.
    setPrintButtonState(document.getElementById('printReportBtn'), false, 'Loading dashboard data...');

    let results = null;
    try {
        const response = await fetch(`/api/results${query ? '?' + query : ''}`);
        if (response.ok) {
            const payload = await response.json();
            if (!payload.empty) results = payload;
        }
    } catch (error) {
        console.warn('Unable to load uploaded results.', error);
    }

    // Every filter-driven refresh resets the products chart back to its
    // descending default, per requirement 5.
    topProductsSortDirection = 'desc';
    const sortToggle = document.getElementById('topProductsSortToggle');
    if (sortToggle) sortToggle.textContent = 'Descending';

    lastDashboardFilterLines = filterLines;
    initializeDashboardCharts(results);
}

function initializeDashboardCharts(results) {
    lastDashboardResults = results;
    setPrintButtonState(
        document.getElementById('printReportBtn'),
        Boolean(results && results.dashboard),
        'No data to print. Upload a file or adjust the filters.'
    );

    updateDashboardStats(results);

    const dashboard = results && results.dashboard;

    initializeOrderSummaryChart(dashboard && dashboard.orderSummary);
    initializeBestSellingChart(dashboard && dashboard.bestSelling);
    initializeTransactionVolumeChart(dashboard && dashboard.transactionVolume);
    initializeRevenueByCategoryChart(dashboard && dashboard.revenueByCategory);
    initializeMonthlySalesTrendChart(dashboard && dashboard.monthlySalesTrend);
    initializeTopProductsMonthlyChart(dashboard && dashboard.topProductsMonthly);
    initializeTransactionsByDayChart(dashboard && dashboard.transactionsByDayOfWeek);
    initializeTransactionsByHourChart(dashboard && dashboard.transactionsByHour);
}

// yyyy-mm-dd -> "Month D, YYYY". Split/parsed manually (not `new Date(iso)`)
// so the displayed date can't drift a day off from what's actually stored,
// which parsing an ISO date string as UTC and then formatting in a
// negative-UTC-offset local timezone would otherwise risk.
function formatDisplayDate(isoValue) {
    if (!isoValue) return '';
    const [year, month, day] = isoValue.split('-').map(Number);
    if (!year || !month || !day) return '';
    return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

// Friendly phrasing for whichever quick-filter range the current dates
// happen to match - reuses computeQuickRange() (the same source of truth
// syncQuickFilterHighlight() checks against) rather than tracking a
// separate "which button is active" flag.
const QUICK_FILTER_SUBTEXT_LABELS = {
    today: 'today',
    week: 'this week',
    year: 'this year'
};

// Describes the Start/End Date filter currently in effect, for the stat
// cards' subtext. No filter at all -> "All time"; a range matching one of
// the quick filters -> its friendly label ("today"/"this week"/"this
// year"), whether it got there via the button or a hand-typed match;
// anything else (a genuine custom range) -> the explicit date-to-date text.
function buildDateRangeSubtext() {
    const startInput = document.getElementById('startDateFilter');
    const endInput = document.getElementById('endDateFilter');
    const start = startInput ? startInput.value : '';
    const end = endInput ? endInput.value : '';

    if (!start && !end) return 'All time';

    if (start && end) {
        const matchedRange = ['today', 'week', 'year'].find(range => {
            const computed = computeQuickRange(range);
            return computed && computed.start === start && computed.end === end;
        });
        if (matchedRange) return `As of ${QUICK_FILTER_SUBTEXT_LABELS[matchedRange]}`;
        // A single-day range (start and end are the same date, picked by
        // hand rather than via the Today button) reads as one date, not a
        // "day to itself" range.
        if (start === end) return `As of ${formatDisplayDate(start)}`;
        return `As of ${formatDisplayDate(start)} to ${formatDisplayDate(end)}`;
    }
    if (start) return `As of ${formatDisplayDate(start)} onward`;
    return `Through ${formatDisplayDate(end)}`;
}

function updateDashboardStats(results) {
    const revenueEl = document.getElementById('statTotalRevenue');
    const transactionsEl = document.getElementById('statTotalTransactions');
    const salesPerTransactionEl = document.getElementById('statAverageSalesPerTransaction');
    const productsPerTransactionEl = document.getElementById('statAverageProductsPerTransaction');
    const tooltipTextEl = document.getElementById('avgProductsTooltipText');

    // Independent of whether there's any data to show - the subtext
    // describes what date range was REQUESTED, not what was found.
    const dateRangeText = buildDateRangeSubtext();
    document.querySelectorAll('.stat-card-date-range').forEach(el => {
        el.textContent = dateRangeText;
    });

    if (!results) {
        if (revenueEl) revenueEl.textContent = '—';
        if (transactionsEl) transactionsEl.textContent = '—';
        if (salesPerTransactionEl) salesPerTransactionEl.textContent = '—';
        if (productsPerTransactionEl) productsPerTransactionEl.textContent = '—';
        if (tooltipTextEl) tooltipTextEl.textContent = buildAverageProductsTooltip(null);
        return;
    }

    const dashboard = results.dashboard;
    if (revenueEl) revenueEl.textContent = formatCurrency(dashboard.totalRevenue);
    if (transactionsEl) transactionsEl.textContent = formatNumber(dashboard.totalTransactions);
    if (salesPerTransactionEl) salesPerTransactionEl.textContent = formatCurrency(dashboard.averageSalesPerTransaction);
    // The card shows a bucketed range (e.g. "2-3") rather than the raw
    // decimal - display-only, the API value stays precise (see
    // formatAverageProductsRange) since buildAverageProductsTooltip below
    // still needs to compare the exact number against the 2-3 reference
    // range.
    if (productsPerTransactionEl) productsPerTransactionEl.textContent = formatAverageProductsRange(dashboard.averageProductsPerTransaction);
    if (tooltipTextEl) tooltipTextEl.textContent = buildAverageProductsTooltip(dashboard.averageProductsPerTransaction);
}

// Buckets the precise average into a "low-high" display range, e.g. 2.71 ->
// "2-3". Boundary decision (documented since it's a judgment call, not an
// obvious one): an exact integer average buckets into the range it's the
// FLOOR of, so exactly 3.0 displays "3-4", not "2-3" - consistent with
// every other value in [3, 4) also showing "3-4".
function formatAverageProductsRange(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    const low = Math.floor(value);
    const high = low + 1;
    return `${low}-${high}`;
}

// "Most cafés see 2-3 items per transaction" (see the stat card's own
// label) is the reference range this message is built against: below it,
// within it, or above it changes the message so the tooltip reacts to the
// actual computed average instead of always showing the same static line.
function buildAverageProductsTooltip(value) {
    if (value === null || value === undefined || isNaN(value)) {
        return 'Customers purchase 2–3 different items per transaction on average at most cafés. Track this to see if upsells or combos are landing.';
    }

    const formatted = formatNumber(value);
    if (value < 2) {
        return `Customers are purchasing an average of ${formatted} item(s) per transaction. This is below the typical 2–3 range. Consider promoting combos or upsells to grow basket size.`;
    }
    if (value <= 3) {
        return `Customers are purchasing an average of ${formatted} items per transaction. This is right in the typical 2–3 range. Upsells and combos appear to be landing well.`;
    }
    return `Customers are purchasing an average of ${formatted} items per transaction. This is above the typical 2–3 range. Upsells and combos are clearly landing.`;
}

// ====================================
// PRINT REPORT
// ====================================

/* Built from the same payload.dashboard object the on-screen charts were
   drawn from (lastDashboardResults), so the report carries the same numbers.
   Its charts are redrawn as inline SVG (see "Printed-report charts" below)
   rather than copied from the canvases. Shared building blocks (header,
   table, print/cleanup) live in script.js. */

function printDashboardReport() {
    if (!lastDashboardResults || !lastDashboardResults.dashboard) return;
    printReportHtml(buildDashboardReportHtml(lastDashboardResults.dashboard, lastDashboardFilterLines));
}

// Same wording as the stat cards' date subtext (buildDateRangeSubtext), but a
// relative phrase like "As of this week" gets its actual dates appended, since
// a printout is read later, when "this week" means something else.
function buildDashboardReportFilterLines() {
    const startInput = document.getElementById('startDateFilter');
    const endInput = document.getElementById('endDateFilter');
    const start = startInput ? startInput.value : '';
    const end = endInput ? endInput.value : '';

    let dateRange = buildDateRangeSubtext();
    if (start && end) {
        const explicit = start === end
            ? formatDisplayDate(start)
            : `${formatDisplayDate(start)} to ${formatDisplayDate(end)}`;
        if (!dateRange.includes(explicit)) dateRange = `${dateRange} (${explicit})`;
    }

    return [
        { label: 'Date range', value: dateRange },
        { label: 'Categories', value: selectedCategories.length ? summarizeReportList(selectedCategories) : 'All categories' },
        { label: 'Products', value: selectedProducts.length ? summarizeReportList(selectedProducts) : 'All products' }
    ];
}

function summarizeReportList(names) {
    if (names.length <= REPORT_FILTER_LIST_LIMIT) return names.join(', ');
    const shown = names.slice(0, REPORT_FILTER_LIST_LIMIT).join(', ');
    return `${shown} +${names.length - REPORT_FILTER_LIST_LIMIT} more`;
}

// ====================================
// EMPTY STATE HELPERS
// ====================================

function showChartEmptyState(canvas, message) {
    canvas.style.display = 'none';
    const wrapper = canvas.closest('.chart-wrapper');
    if (!wrapper) return;
    let emptyEl = wrapper.querySelector('.chart-empty-state');
    if (!emptyEl) {
        emptyEl = document.createElement('div');
        emptyEl.className = 'chart-empty-state';
        wrapper.appendChild(emptyEl);
    }
    emptyEl.textContent = message;
}

function hideChartEmptyState(canvas) {
    canvas.style.display = '';
    const wrapper = canvas.closest('.chart-wrapper');
    if (!wrapper) return;
    const emptyEl = wrapper.querySelector('.chart-empty-state');
    if (emptyEl) emptyEl.remove();
}

function colorizeDatasets(datasets, palette) {
    const activePalette = palette || CHART_PALETTE;
    return datasets.map((dataset, index) => ({
        ...dataset,
        backgroundColor: activePalette[index % activePalette.length],
        borderColor: activePalette[index % activePalette.length],
        borderWidth: 1
    }));
}

// ====================================
// CHART 4 — Transaction Volume per Month (line, order count)
// ====================================

function initializeOrderSummaryChart(realData) {
    const ctx = document.getElementById('orderSummaryChart');
    if (!ctx) return;

    if (orderSummaryChart) {
        orderSummaryChart.destroy();
        orderSummaryChart = null;
    }

    if (!realData || !realData.labels || realData.labels.length === 0) {
        showChartEmptyState(ctx, NO_DATA_MESSAGE);
        return;
    }
    hideChartEmptyState(ctx);

    orderSummaryChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: realData.labels,
            datasets: [{
                label: 'Order Count',
                data: realData.data,
                borderColor: '#5D4E37',
                backgroundColor: 'rgba(93, 78, 55, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#5D4E37',
                pointBorderColor: '#FFFFFF',
                pointBorderWidth: 2,
                pointRadius: 5,
                pointHoverRadius: 7
            }]
        },
        plugins: [orderSummaryValueLabels],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        color: '#E8E4DB',
                        drawBorder: false
                    }
                },
                x: {
                    ticks: {
                        color: '#666',
                        font: { size: 12 }
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ====================================
// CHART 2 — Top 10 Best-Selling Menu Items by Sales Volume (vertical column)
// ====================================

function initializeBestSellingChart(realData) {
    const ctx = document.getElementById('bestSellingChart');
    if (!ctx) return;

    if (bestSellingChart) {
        bestSellingChart.destroy();
        bestSellingChart = null;
    }

    if (!realData || !realData.labels || realData.labels.length === 0) {
        showChartEmptyState(ctx, NO_DATA_MESSAGE);
        return;
    }
    hideChartEmptyState(ctx);

    bestSellingChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: realData.labels,
            datasets: [{
                label: 'Sales Volume',
                data: realData.data,
                backgroundColor: '#5D4E37',
                borderColor: '#5D4E37',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        color: '#E8E4DB'
                    }
                },
                x: {
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ====================================
// CHART 5 — Transaction Volume of each Category per Month (clustered column)
// ====================================

function initializeTransactionVolumeChart(realData) {
    const ctx = document.getElementById('transactionVolumeChart');
    if (!ctx) return;

    if (transactionVolumeChart) {
        transactionVolumeChart.destroy();
        transactionVolumeChart = null;
    }

    if (!realData || !realData.labels || realData.labels.length === 0 || !realData.datasets || realData.datasets.length === 0) {
        showChartEmptyState(ctx, NO_DATA_MESSAGE);
        return;
    }
    hideChartEmptyState(ctx);

    transactionVolumeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: realData.labels,
            datasets: colorizeDatasets(realData.datasets)
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: '#666',
                        font: { size: 12 }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    stacked: false,
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        color: '#E8E4DB'
                    }
                },
                x: {
                    stacked: false,
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ====================================
// CHART 1 — Distribution of Café Revenue Across Product Categories (vertical column)
// ====================================

function initializeRevenueByCategoryChart(realData) {
    const ctx = document.getElementById('revenueByCategoryChart');
    if (!ctx) return;

    if (revenueByCategoryChart) {
        revenueByCategoryChart.destroy();
        revenueByCategoryChart = null;
    }

    if (!realData || !realData.labels || realData.labels.length === 0) {
        showChartEmptyState(ctx, NO_DATA_MESSAGE);
        return;
    }
    hideChartEmptyState(ctx);

    revenueByCategoryChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: realData.labels,
            datasets: [{
                label: 'Revenue',
                data: realData.data,
                backgroundColor: '#5D4E37',
                borderColor: '#5D4E37',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: context => formatCurrency(context.parsed.y)
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#666',
                        callback: value => formatCurrency(value)
                    },
                    grid: {
                        color: '#E8E4DB'
                    }
                },
                x: {
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ====================================
// CHART 3 — Trajectory of Monthly Sales (line, revenue)
// ====================================

function initializeMonthlySalesTrendChart(realData) {
    const ctx = document.getElementById('monthlySalesTrendChart');
    if (!ctx) return;

    if (monthlySalesTrendChart) {
        monthlySalesTrendChart.destroy();
        monthlySalesTrendChart = null;
    }

    if (!realData || !realData.labels || realData.labels.length === 0) {
        showChartEmptyState(ctx, NO_DATA_MESSAGE);
        return;
    }
    hideChartEmptyState(ctx);

    monthlySalesTrendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: realData.labels,
            datasets: [{
                label: 'Monthly Sales',
                data: realData.data,
                borderColor: '#5D4E37',
                backgroundColor: 'rgba(93, 78, 55, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#5D4E37',
                pointBorderColor: '#FFFFFF',
                pointBorderWidth: 2,
                pointRadius: 5,
                pointHoverRadius: 7
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: context => formatCurrency(context.parsed.y)
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#666',
                        callback: value => formatCurrency(value)
                    },
                    grid: {
                        color: '#E8E4DB',
                        drawBorder: false
                    }
                },
                x: {
                    ticks: {
                        color: '#666',
                        font: { size: 12 }
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ====================================
// CHART 6 — Transaction Volume for the Top 10 Products per Month (clustered column)
// ====================================

function initializeTopProductsMonthlyChart(realData) {
    lastTopProductsMonthlyData = realData;
    ensureTopProductsSortToggleWired();
    renderTopProductsMonthlyChart();
}

function ensureTopProductsSortToggleWired() {
    const sortToggle = document.getElementById('topProductsSortToggle');
    if (!sortToggle || sortToggle.dataset.wired) return;
    sortToggle.dataset.wired = 'true';
    sortToggle.addEventListener('click', function() {
        topProductsSortDirection = topProductsSortDirection === 'desc' ? 'asc' : 'desc';
        sortToggle.textContent = topProductsSortDirection === 'desc' ? 'Descending' : 'Ascending';
        renderTopProductsMonthlyChart();
    });
}

// Reorders which product-series (dataset) appears first, by each product's
// total volume across all months - the clustered chart has one series per
// product rather than a single value axis, so "sorting" means reordering
// datasets rather than reordering points along an axis.
function sortProductDatasets(datasets, direction) {
    const withTotals = datasets.map(dataset => ({
        dataset,
        total: (dataset.data || []).reduce((sum, value) => sum + (Number(value) || 0), 0)
    }));
    withTotals.sort((a, b) => (direction === 'asc' ? a.total - b.total : b.total - a.total));
    return withTotals.map(entry => entry.dataset);
}

function renderTopProductsMonthlyChart() {
    const ctx = document.getElementById('topProductsMonthlyChart');
    if (!ctx) return;

    if (topProductsMonthlyChart) {
        topProductsMonthlyChart.destroy();
        topProductsMonthlyChart = null;
    }

    const realData = lastTopProductsMonthlyData;
    if (!realData || !realData.labels || realData.labels.length === 0 || !realData.datasets || realData.datasets.length === 0) {
        showChartEmptyState(ctx, NO_DATA_MESSAGE);
        return;
    }
    hideChartEmptyState(ctx);

    const sortedDatasets = sortProductDatasets(realData.datasets, topProductsSortDirection);

    topProductsMonthlyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: realData.labels,
            datasets: colorizeDatasets(sortedDatasets, TOP_PRODUCTS_PALETTE)
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: '#666',
                        font: { size: 12 }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    stacked: false,
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        color: '#E8E4DB'
                    }
                },
                x: {
                    stacked: false,
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ====================================
// CHART 7 — Distribution of Total Customer Transactions by Day of the Week (area)
// ====================================

function initializeTransactionsByDayChart(realData) {
    const ctx = document.getElementById('transactionsByDayChart');
    if (!ctx) return;

    if (transactionsByDayChart) {
        transactionsByDayChart.destroy();
        transactionsByDayChart = null;
    }

    if (!realData || !realData.labels || realData.labels.length === 0) {
        showChartEmptyState(ctx, NO_DATA_MESSAGE);
        return;
    }
    hideChartEmptyState(ctx);

    transactionsByDayChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: realData.labels,
            datasets: [{
                label: 'Transactions',
                data: realData.data,
                borderColor: '#5D4E37',
                backgroundColor: 'rgba(93, 78, 55, 0.25)',
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                pointBackgroundColor: '#5D4E37',
                pointBorderColor: '#FFFFFF',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        color: '#E8E4DB',
                        drawBorder: false
                    }
                },
                x: {
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ====================================
// CHART 8 — Distribution of Customer Transactions by Hour of the Day (line)
// ====================================

function initializeTransactionsByHourChart(realData) {
    const ctx = document.getElementById('transactionsByHourChart');
    if (!ctx) return;

    if (transactionsByHourChart) {
        transactionsByHourChart.destroy();
        transactionsByHourChart = null;
    }

    if (!realData || !realData.labels || realData.labels.length === 0) {
        showChartEmptyState(ctx, NO_DATA_MESSAGE);
        return;
    }

    if (!realData.hasTimeData) {
        showChartEmptyState(ctx, 'No time-of-day data available in this file.');
        return;
    }
    hideChartEmptyState(ctx);

    transactionsByHourChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: realData.labels,
            datasets: [{
                label: 'Transactions',
                data: realData.data,
                borderColor: '#5D4E37',
                backgroundColor: 'rgba(93, 78, 55, 0.1)',
                borderWidth: 2,
                fill: false,
                tension: 0.3,
                pointBackgroundColor: '#5D4E37',
                pointBorderColor: '#FFFFFF',
                pointBorderWidth: 2,
                pointRadius: 3,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#666'
                    },
                    grid: {
                        color: '#E8E4DB',
                        drawBorder: false
                    }
                },
                x: {
                    ticks: {
                        color: '#666',
                        maxRotation: 0,
                        autoSkip: true
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// Handle window resize to redraw charts
window.addEventListener('resize', function() {
    // Charts should automatically resize with Chart.js responsive option
    // but we can force a redraw if needed
});
