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

// Four pages: summary + revenue pie; top 10 + monthly chart; category
// volume + day of week; hour of day (the page breaks are on the sections).
function buildDashboardReportHtml(dashboard, filterLines) {
    const categoryOrder = getReportCategoryOrder(dashboard);
    const categoryColors = new Map(
        categoryOrder.map((name, index) => [name, REPORT_CATEGORY_PALETTE[index % REPORT_CATEGORY_PALETTE.length]])
    );
    const months = (dashboard.orderSummary && dashboard.orderSummary.labels) || [];
    const totalItems = sumReportDatasets(dashboard.transactionVolume);

    return [
        buildReportHeader('Sales Dashboard Report', filterLines),
        buildReportSummarySection(dashboard),
        buildReportHighlightsSection(dashboard, months),
        buildReportRevenueByCategorySection(dashboard.revenueByCategory, categoryColors),
        buildReportBestSellingSection(dashboard.bestSelling, totalItems),
        buildReportMonthlySummarySection(dashboard.monthlySalesTrend, dashboard.orderSummary),
        buildReportCategoryPerMonthSection(dashboard.transactionVolume, categoryOrder, categoryColors),
        buildReportDayOfWeekSection(dashboard.transactionsByDayOfWeek),
        buildReportHourOfDaySection(dashboard.transactionsByHour, months)
    ].join('');
}

// The payload uses null for a NaN/infinite aggregate (see
// services/aggregation._number) - counted as 0 in report math.
function reportNumber(value) {
    return Number(value) || 0;
}

function formatReportPercent(value, total) {
    if (!total) return '—';
    return `${((value / total) * 100).toFixed(1)}%`;
}

function sumReportValues(values) {
    return (values || []).reduce((sum, value) => sum + reportNumber(value), 0);
}

function hasReportSeries(series) {
    return Boolean(series && series.labels && series.labels.length > 0);
}

// Largest value in a {labels, data} series, or null if nothing is above 0
// (so the matching "Key highlights" line is skipped rather than printing a
// meaningless "top" of all zeros). Ties go to the first label.
function findReportSeriesMax(series) {
    if (!hasReportSeries(series)) return null;
    let best = null;
    series.labels.forEach((label, index) => {
        const value = reportNumber(series.data[index]);
        if (value > 0 && (!best || value > best.value)) best = { label, value };
    });
    if (!best) return null;
    best.total = sumReportValues(series.data);
    return best;
}

// 22 -> "10 PM"
function formatReportHour(hour) {
    return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

// (22, 59) -> "10:59 PM"
function formatReportClock(hour, minute) {
    return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

// "22:00" -> "10:00 PM – 10:59 PM" (one hour bucket, as the chart's x-axis labels mean).
function formatReportHourRange(label) {
    const hour = parseInt(label, 10);
    return `${formatReportClock(hour, 0)} – ${formatReportClock(hour, 59)}`;
}

// Chart point/caption amounts are rounded to whole pesos ("₱980,480") - the
// cents would only crowd the labels.
function formatReportPesoWhole(value) {
    return '₱' + Math.round(value).toLocaleString('en-US');
}

// Axis labels: "₱250K" once the scale reaches the tens of thousands.
function formatReportAxisPeso(value, axisMax) {
    if (axisMax >= 10000) return `₱${formatNumber(value / 1000)}K`;
    return `₱${formatNumber(value)}`;
}

function reportRound(value) {
    return Math.round(value * 10) / 10;
}

function reportStrong(text) {
    return `<strong>${escapeHtml(text)}</strong>`;
}

const REPORT_NO_DATA_TEXT = 'No data for the selected filters.';

/* ---------- Printed-report charts ----------
   The report draws its own charts as inline SVG rather than reusing the
   on-screen Chart.js canvases: SVG stays sharp on paper and is ready the
   moment the HTML is inserted, with no canvas re-render to wait for before
   window.print(). Text that needs to wrap or line up with HTML (legends,
   pie labels) is HTML positioned over the SVG. */

// Category colours for the report, assigned by revenue rank so the pie and
// the stacked bars always agree (the top-earning category is blue, the
// second orange, ...).
const REPORT_CATEGORY_PALETTE = [
    '#2a78d6', // blue
    '#eb6834', // orange
    '#1baf7a', // teal green
    '#4a3aa7', // purple
    '#eda100', // amber
    '#e87ba4', // pink
    '#008300', // dark green
    '#e34948', // red
    '#6b6b6b', // gray
    '#5D4E37'  // brown
];
const REPORT_REVENUE_LINE_COLOR = '#d9531e';
const REPORT_TRANSACTION_BAR_COLOR = '#85b4ee';

// Hour-of-day grid: Fewer -> More transactions.
const REPORT_HEAT_STOPS = [
    [0, '#eef0ec'],
    [0.3, '#bcd5f4'],
    [0.6, '#3b82dc'],
    [1, '#0d2e61']
];

// Opening hours the Hour of Day grid is laid out around (2 PM - 11:59 PM),
// split into three shifts. Hours outside them are folded into the nearest
// shift: from REPORT_EARLY_MORNING_END up to opening counts as "before
// opening", midnight up to REPORT_EARLY_MORNING_END as "after closing".
const REPORT_SHIFTS = [
    { name: 'Opening Hours', hours: [14, 15, 16], outside: 'before' },
    { name: 'Mid Shift', hours: [17, 18, 19, 20] },
    { name: 'Closing Hours', hours: [21, 22, 23], outside: 'after' }
];
const REPORT_OPENING_HOUR = 14;
const REPORT_LAST_OPEN_HOUR = 23;
const REPORT_EARLY_MORNING_END = 6;

// Words that describe a size or serving rather than a dish, skipped when
// looking for a common theme among the best sellers.
const REPORT_THEME_STOP_WORDS = new Set(['and', 'with', 'the', 'for', 'solo', 'sharing', 'set', 'meal', 'combo']);

// Rounds a rough axis step up to 1, 2, 2.5 or 5 x 10^n. `integer` skips the
// 2.5 step below 10, for axes that count whole transactions/items.
function niceReportStep(rough, integer) {
    if (!(rough > 0)) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const factors = integer && magnitude < 10 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
    const step = factors.find(factor => factor * magnitude >= rough) * magnitude;
    return integer ? Math.max(1, Math.round(step)) : step;
}

function reportSvgText(x, y, text, options) {
    const settings = options || {};
    return `<text x="${reportRound(x)}" y="${reportRound(y)}" font-size="${settings.size || 11}"`
        + `${settings.anchor ? ` text-anchor="${settings.anchor}"` : ''}`
        + `${settings.weight ? ` font-weight="${settings.weight}"` : ''}`
        + ` fill="${settings.fill || '#222'}">${escapeHtml(text)}</text>`;
}

// Month label "Aug 2025" drawn as a bold "Aug" over a lighter "2025".
function reportSvgMonthLabel(x, y, label, fontSize) {
    const [monthName, ...rest] = String(label).split(' ');
    return reportSvgText(x, y, monthName, { anchor: 'middle', size: fontSize, weight: 600, fill: '#222' })
        + (rest.length ? reportSvgText(x, y + fontSize + 2, rest.join(' '), { anchor: 'middle', size: fontSize - 1.5, fill: '#666' }) : '');
}

function hexToRgb(hex) {
    return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
}

function reportRelativeLuminance(hex) {
    const [r, g, b] = hexToRgb(hex).map(channel => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// White text on dark fills, near-black on light ones.
function reportTextColorOn(hex, threshold) {
    return reportRelativeLuminance(hex) < (threshold || 0.2) ? '#fff' : '#1a1a1a';
}

function reportHeatColor(t) {
    const clamped = Math.max(0, Math.min(1, t));
    for (let index = 1; index < REPORT_HEAT_STOPS.length; index++) {
        const [endAt, endColor] = REPORT_HEAT_STOPS[index];
        if (clamped <= endAt) {
            const [startAt, startColor] = REPORT_HEAT_STOPS[index - 1];
            const ratio = (clamped - startAt) / (endAt - startAt);
            const start = hexToRgb(startColor);
            const end = hexToRgb(endColor);
            return '#' + start
                .map((channel, i) => Math.round(channel + (end[i] - channel) * ratio).toString(16).padStart(2, '0'))
                .join('');
        }
    }
    return REPORT_HEAT_STOPS[REPORT_HEAT_STOPS.length - 1][1];
}

function renderReportChartCard(innerHtml) {
    return `<div class="report-chart-card">${innerHtml}</div>`;
}

// html must already be safe (built from escapeHtml/reportStrong).
function renderReportChartCaption(html) {
    return `<p class="report-chart-caption">${html}</p>`;
}

function renderReportSummaryCallout(html) {
    return `
        <div class="report-summary-callout">
            <div class="report-summary-callout-title">Summary Report</div>
            <p>${html}</p>
        </div>
    `;
}

// Categories ordered by revenue (highest first), then any category that
// only appears in the per-month volumes - the order colours are handed out in.
function getReportCategoryOrder(dashboard) {
    const revenue = dashboard.revenueByCategory;
    const ordered = hasReportSeries(revenue)
        ? revenue.labels
            .map((label, index) => ({ label, value: reportNumber(revenue.data[index]) }))
            .sort((a, b) => b.value - a.value)
            .map(entry => entry.label)
        : [];
    const volumeDatasets = (dashboard.transactionVolume && dashboard.transactionVolume.datasets) || [];
    const extra = volumeDatasets
        .map(dataset => dataset.label)
        .filter(label => !ordered.includes(label))
        .sort((a, b) => a.localeCompare(b));
    return ordered.concat(extra);
}

function sumReportDatasets(series) {
    return ((series && series.datasets) || []).reduce((sum, dataset) => sum + sumReportValues(dataset.data), 0);
}

function buildReportSummarySection(dashboard) {
    const table = renderReportTable({
        columns: ['Metric', 'Value'],
        align: ['left', 'right'],
        rows: [
            ['Total Revenue', formatCurrency(dashboard.totalRevenue)],
            ['Total Transactions', formatNumber(dashboard.totalTransactions)],
            ['Average Sales per Transaction', formatCurrency(dashboard.averageSalesPerTransaction)],
            ['Average Products per Transaction', formatAverageProductsRange(dashboard.averageProductsPerTransaction)]
        ],
        className: 'report-table-narrow'
    });
    return renderReportSection('Summary', table);
}

function buildReportHighlightsSection(dashboard, months) {
    const lines = [];

    const topCategory = findReportSeriesMax(dashboard.revenueByCategory);
    if (topCategory) {
        lines.push(`Top category by revenue: ${topCategory.label} – ${formatCurrency(topCategory.value)} (${formatReportPercent(topCategory.value, topCategory.total)} of revenue)`);
    }
    const bestSeller = findReportSeriesMax(dashboard.bestSelling);
    if (bestSeller) {
        lines.push(`Best-selling product: ${bestSeller.label} – ${formatNumber(bestSeller.value)} units sold`);
    }
    const bestMonth = findReportSeriesMax(dashboard.monthlySalesTrend);
    if (bestMonth) {
        lines.push(`Best month by revenue: ${bestMonth.label} – ${formatCurrency(bestMonth.value)}`);
    }
    const busiestDay = findReportSeriesMax(dashboard.transactionsByDayOfWeek);
    if (busiestDay) {
        lines.push(`Busiest day of the week: ${busiestDay.label} – ${formatNumber(busiestDay.value)} transactions`);
    }
    const hourSeries = dashboard.transactionsByHour;
    const peakHour = hourSeries && hourSeries.hasTimeData ? findReportSeriesMax(hourSeries) : null;
    if (peakHour) {
        const span = months.length > 1 ? ' (total over all months)' : '';
        lines.push(`Peak hour: ${formatReportHourRange(peakHour.label)} – ${formatNumber(peakHour.value)} transactions${span}`);
    }

    if (lines.length === 0) return '';
    const list = `<ul class="report-highlights">${lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
    return renderReportSection('Key Highlights', list);
}

// Moves label y-positions (sorted top to bottom) apart so each is at least
// `gap` below the one above, staying within [top, bottom].
function spreadReportLabels(items, top, bottom, gap) {
    items.forEach((item, index) => {
        const floor = index === 0 ? top : items[index - 1].y + gap;
        item.y = Math.max(item.y, floor);
    });
    for (let index = items.length - 1; index >= 0; index--) {
        const ceiling = index === items.length - 1 ? bottom : items[index + 1].y - gap;
        items[index].y = Math.min(items[index].y, ceiling);
    }
}

function buildReportRevenueByCategorySection(series, categoryColors) {
    const title = 'Revenue by Category';
    if (!hasReportSeries(series)) return renderReportSection(title, renderReportMessage(REPORT_NO_DATA_TEXT));

    const entries = series.labels
        .map((label, index) => ({ label, value: reportNumber(series.data[index]) }))
        .filter(entry => entry.value > 0)
        .sort((a, b) => b.value - a.value);
    const total = sumReportValues(entries.map(entry => entry.value));
    if (!total) return renderReportSection(title, renderReportMessage(REPORT_NO_DATA_TEXT));

    // Slices run clockwise from 12 o'clock, largest first.
    let angle = 0;
    const slices = entries.map(entry => {
        const sweep = (entry.value / total) * Math.PI * 2;
        const slice = {
            ...entry,
            color: categoryColors.get(entry.label) || '#999',
            start: angle,
            end: angle + sweep,
            mid: angle + sweep / 2
        };
        angle += sweep;
        return slice;
    });

    // Labels sit in a column on each side of the pie, level with their slice
    // and then spread apart so neighbours never overlap - the chart grows
    // taller when one side has more labels than fit.
    const width = 800;
    const radius = 100;
    const labelGap = 38;
    const labelOffset = radius + 72;
    const columns = { right: [], left: [] };
    slices.forEach(slice => columns[Math.sin(slice.mid) >= 0 ? 'right' : 'left'].push({ slice }));
    const busiestColumn = Math.max(columns.right.length, columns.left.length);
    const height = Math.max(300, busiestColumn * labelGap + 40);
    const cx = width / 2;
    const cy = height / 2;
    const pointAt = (at, distance) => [cx + distance * Math.sin(at), cy - distance * Math.cos(at)];

    const labels = [];
    Object.entries(columns).forEach(([side, column]) => {
        column.forEach(label => {
            label.side = side;
            label.y = pointAt(label.slice.mid, radius + 16)[1];
        });
        column.sort((a, b) => a.y - b.y);
        spreadReportLabels(column, 20, height - 20, labelGap);
        labels.push(...column);
    });

    const slicePaths = slices.length === 1
        ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${slices[0].color}"/>`
        : slices.map(slice => {
            const [x1, y1] = pointAt(slice.start, radius);
            const [x2, y2] = pointAt(slice.end, radius);
            const largeArc = slice.end - slice.start > Math.PI ? 1 : 0;
            return `<path d="M${cx},${cy} L${reportRound(x1)},${reportRound(y1)} A${radius},${radius} 0 ${largeArc} 1 ${reportRound(x2)},${reportRound(y2)} Z" fill="${slice.color}" stroke="#fff" stroke-width="1.5"/>`;
        }).join('');

    // Each line leaves its slice radially, then runs straight to its label -
    // a label that was spread up or down never pulls its line back across
    // the pie.
    const leaderLines = labels.map(label => {
        const direction = label.side === 'right' ? 1 : -1;
        const [startX, startY] = pointAt(label.slice.mid, radius);
        const [kneeX, kneeY] = pointAt(label.slice.mid, radius + 14);
        const endX = cx + direction * (labelOffset - 6);
        return `<polyline points="${reportRound(startX)},${reportRound(startY)} ${reportRound(kneeX)},${reportRound(kneeY)} ${reportRound(endX)},${reportRound(label.y)}" fill="none" stroke="#888" stroke-width="0.8"/>`;
    }).join('');

    const labelHtml = labels.map(label => {
        const anchorPercent = ((cx + (label.side === 'right' ? 1 : -1) * labelOffset) / width) * 100;
        const position = label.side === 'right'
            ? `left:${anchorPercent.toFixed(2)}%`
            : `right:${(100 - anchorPercent).toFixed(2)}%`;
        return `
            <div class="report-pie-label report-pie-label-${label.side}" style="${position};top:${((label.y / height) * 100).toFixed(2)}%">
                <div class="report-pie-label-name"><span class="report-swatch" style="background:${label.slice.color}"></span>${escapeHtml(label.slice.label)}</div>
                <div>${escapeHtml(formatCurrency(label.slice.value))} <span class="report-muted">· ${escapeHtml(formatReportPercent(label.slice.value, total))}</span></div>
            </div>
        `;
    }).join('');

    const chart = renderReportChartCard(`
        <div class="report-pie" style="padding-top:${((height / width) * 100).toFixed(2)}%">
            <svg class="report-pie-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">${slicePaths}${leaderLines}</svg>
            ${labelHtml}
        </div>
    `);
    const caption = escapeHtml(`Each slice is one menu category – the bigger the slice, the more money it earned. Every label shows the category, how much it earned (₱) and its share of the total ${formatCurrency(total)}.`);
    return renderReportSection(title, chart + renderReportChartCaption(caption));
}

// The most common dish word across the best sellers ("Tenders" in "Tenders
// Rice", "Tenders Solo", ...), if at least 3 of them share it. Ties go to
// the word that appears highest in the ranking.
function findReportNameTheme(names) {
    const counts = new Map();
    names.forEach(name => {
        const words = new Set(
            String(name).split(/[^A-Za-z]+/).filter(word => word.length >= 3 && !REPORT_THEME_STOP_WORDS.has(word.toLowerCase()))
        );
        words.forEach(word => {
            const key = word.toLowerCase();
            if (!counts.has(key)) counts.set(key, { word, count: 0 });
            counts.get(key).count += 1;
        });
    });
    let best = null;
    counts.forEach(entry => {
        if (!best || entry.count > best.count) best = entry;
    });
    return best && best.count >= 3 ? best : null;
}

function buildBestSellingNarrative(series, totalItems) {
    const items = series.labels
        .map((label, index) => ({ label, units: reportNumber(series.data[index]) }))
        .filter(item => item.units > 0);
    if (items.length === 0) return '';

    const [first, second] = items;
    const last = items[items.length - 1];
    const sentences = [];

    if (!second) {
        sentences.push(`${reportStrong(first.label)} is the best seller with ${escapeHtml(formatNumber(first.units))} units.`);
    } else if (first.units === second.units) {
        sentences.push(`${reportStrong(first.label)} and ${reportStrong(second.label)} share the top spot with ${escapeHtml(formatNumber(first.units))} units each.`);
    } else {
        const lead = first.units - second.units;
        const leadText = `${formatNumber(lead)} unit${lead === 1 ? '' : 's'}`;
        let sentence = lead / second.units >= 0.05
            ? `${reportStrong(first.label)} is the clear favorite with ${escapeHtml(formatNumber(first.units))} units, ahead of ${escapeHtml(second.label)} by ${escapeHtml(leadText)}`
            : `${reportStrong(first.label)} is the top seller with ${escapeHtml(formatNumber(first.units))} units, just ahead of ${escapeHtml(second.label)} by ${escapeHtml(leadText)}`;
        const ratio = first.units / last.units;
        if (items.length >= 3 && ratio >= 1.1) {
            sentence += ` and selling about ${ratio.toFixed(1)} times as much as number ${items.length} (${escapeHtml(last.label)}, ${escapeHtml(formatNumber(last.units))} units)`;
        }
        sentences.push(`${sentence}.`);
    }

    const theme = findReportNameTheme(items.map(item => item.label));
    if (theme) {
        sentences.push(`${escapeHtml(theme.word)} dishes take ${theme.count} of the ${items.length} spots, so they are a reliable crowd-pleaser.`);
    }

    const topUnits = sumReportValues(items.map(item => item.units));
    if (totalItems > topUnits) {
        const share = Math.round((topUnits / totalItems) * 100);
        const advice = share >= 30
            ? 'so keeping them well stocked protects a big part of sales.'
            : 'so sales are spread widely and the rest of the menu matters too.';
        sentences.push(`Together these ${items.length} items account for ${escapeHtml(formatNumber(topUnits))} units – about ${share}% of the ${escapeHtml(formatNumber(totalItems))} items sold – ${advice}`);
    }
    return sentences.join(' ');
}

function buildReportBestSellingSection(series, totalItems) {
    const title = 'Top 10 Best-Selling Items';
    if (!hasReportSeries(series)) {
        return renderReportSection(title, renderReportMessage(REPORT_NO_DATA_TEXT), 'report-section-break');
    }

    const table = renderReportTable({
        columns: ['Rank', 'Product', 'Units Sold'],
        align: ['center', 'left', 'right'],
        rows: series.labels.map((label, index) => [String(index + 1), label, formatNumber(reportNumber(series.data[index]))]),
        className: 'report-table-ranked'
    });
    const narrative = buildBestSellingNarrative(series, totalItems);
    return renderReportSection(
        title,
        table + (narrative ? renderReportSummaryCallout(narrative) : ''),
        'report-section-break'
    );
}

// Revenue (monthlySalesTrend) and transaction counts (orderSummary) are two
// series over the same month labels (both built from the same month list in
// services/aggregation), so they're combined by index into one chart: revenue
// as a line on the left axis, transactions as bars on the right.
function buildReportMonthlySummarySection(revenueSeries, orderSeries) {
    const title = 'Monthly Summary';
    if (!hasReportSeries(revenueSeries)) return renderReportSection(title, renderReportMessage(REPORT_NO_DATA_TEXT));

    const labels = revenueSeries.labels;
    const count = labels.length;
    const orderData = (orderSeries && orderSeries.data) || [];
    const revenue = labels.map((_, index) => reportNumber(revenueSeries.data[index]));
    const orders = labels.map((_, index) => reportNumber(orderData[index]));

    const width = 800;
    const height = 372;
    const plot = { left: 72, right: 728, top: 40, bottom: 286 };
    const plotHeight = plot.bottom - plot.top;
    const band = (plot.right - plot.left) / count;
    const centerX = index => plot.left + band * (index + 0.5);
    // Labels shrink as months are added, and are left off past 18 months
    // where they'd overlap.
    const valueFont = count <= 12 ? 11 : count <= 18 ? 8.5 : 0;
    const axisFont = count <= 12 ? 11 : 9;

    // The right axis is stretched to about twice the busiest month so the
    // bars stay in the lower half and the revenue line rides above them.
    const maxRevenue = Math.max(...revenue);
    const leftStep = niceReportStep(maxRevenue / 4);
    const tickCount = Math.max(1, Math.ceil(maxRevenue / leftStep));
    const leftMax = leftStep * tickCount;
    const rightStep = niceReportStep((Math.max(...orders) * 2.2) / tickCount, true);
    const rightMax = rightStep * tickCount;
    const yLeft = value => plot.bottom - (value / leftMax) * plotHeight;
    const yRight = value => plot.bottom - (value / rightMax) * plotHeight;

    const parts = [];
    for (let tick = 0; tick <= tickCount; tick++) {
        const y = plot.bottom - (tick / tickCount) * plotHeight;
        parts.push(`<line x1="${plot.left}" x2="${plot.right}" y1="${reportRound(y)}" y2="${reportRound(y)}" stroke="${tick === 0 ? '#c8c8c8' : '#ececec'}" stroke-width="1"/>`);
        parts.push(reportSvgText(plot.left - 8, y + 4, formatReportAxisPeso(tick * leftStep, leftMax), { anchor: 'end', fill: '#666' }));
        parts.push(reportSvgText(plot.right + 8, y + 4, formatNumber(tick * rightStep), { anchor: 'start', fill: '#666' }));
    }

    const barWidth = Math.min(band * 0.6, 48);
    const barLabelY = orders.map(value => yRight(value) - 6);
    orders.forEach((value, index) => {
        const y = yRight(value);
        parts.push(`<rect x="${reportRound(centerX(index) - barWidth / 2)}" y="${reportRound(y)}" width="${reportRound(barWidth)}" height="${reportRound(plot.bottom - y)}" rx="2" fill="${REPORT_TRANSACTION_BAR_COLOR}"/>`);
        if (valueFont) parts.push(reportSvgText(centerX(index), barLabelY[index], formatNumber(value), { anchor: 'middle', size: valueFont, weight: 600 }));
    });

    const points = revenue.map((value, index) => `${reportRound(centerX(index))},${reportRound(yLeft(value))}`).join(' ');
    parts.push(`<polyline points="${points}" fill="none" stroke="${REPORT_REVENUE_LINE_COLOR}" stroke-width="2.5" stroke-linejoin="round"/>`);
    revenue.forEach((value, index) => {
        const y = yLeft(value);
        parts.push(`<circle cx="${reportRound(centerX(index))}" cy="${reportRound(y)}" r="4" fill="${REPORT_REVENUE_LINE_COLOR}"/>`);
        if (!valueFont) return;
        // A revenue point sitting on its bar would put the two labels on top
        // of each other - lift the revenue label clear of the bar's.
        let labelY = y - 10;
        if (Math.abs(labelY - barLabelY[index]) < valueFont + 3) labelY = barLabelY[index] - (valueFont + 3);
        parts.push(reportSvgText(centerX(index), labelY, formatReportPesoWhole(value), { anchor: 'middle', size: valueFont, weight: 600 }));
    });

    labels.forEach((label, index) => parts.push(reportSvgMonthLabel(centerX(index), plot.bottom + 18, label, axisFont)));

    // Average amount per order, one figure under each month.
    if (valueFont) {
        const rowY = plot.bottom + 66;
        parts.push(`<line x1="${plot.left}" x2="${plot.right}" y1="${plot.bottom + 46}" y2="${plot.bottom + 46}" stroke="#ececec" stroke-width="1"/>`);
        parts.push(reportSvgText(plot.left - 8, rowY - 5, 'Avg ₱ /', { anchor: 'end', size: 9.5, fill: '#666' }));
        parts.push(reportSvgText(plot.left - 8, rowY + 6, 'txn', { anchor: 'end', size: 9.5, fill: '#666' }));
        revenue.forEach((value, index) => {
            const average = orders[index] ? formatCurrency(value / orders[index]) : '—';
            parts.push(reportSvgText(centerX(index), rowY, average, { anchor: 'middle', size: valueFont - 1, fill: '#555' }));
        });
    }

    const legend = `
        <div class="report-chart-legend report-chart-legend-split">
            <span class="report-legend-item">
                <svg class="report-legend-line" viewBox="0 0 24 10" aria-hidden="true">
                    <line x1="0" y1="5" x2="24" y2="5" stroke="${REPORT_REVENUE_LINE_COLOR}" stroke-width="2" stroke-dasharray="4 2"/>
                    <circle cx="12" cy="5" r="3.2" fill="${REPORT_REVENUE_LINE_COLOR}"/>
                </svg>
                Revenue (₱) – line, left scale
            </span>
            <span class="report-legend-item">
                <span class="report-swatch" style="background:${REPORT_TRANSACTION_BAR_COLOR}"></span>
                Transactions – bars, right scale
            </span>
        </div>
    `;
    const chart = renderReportChartCard(`${legend}<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${parts.join('')}</svg>`);

    let best = 0;
    let quietest = 0;
    revenue.forEach((value, index) => {
        if (value > revenue[best]) best = index;
        if (value < revenue[quietest]) quietest = index;
    });
    let caption = `The ${reportStrong('orange line')} is how much money came in each month – read it on the ₱ scale on the left. `
        + `The ${reportStrong('blue bars')} are how many orders were made – read them on the number scale on the right.`;
    if (valueFont) caption += ' The small row at the bottom is the average amount spent per order.';
    if (count > 1) {
        caption += ` Best month: ${reportStrong(labels[best])} (${escapeHtml(formatReportPesoWhole(revenue[best]))}); `
            + `quietest: ${reportStrong(labels[quietest])} (${escapeHtml(formatReportPesoWhole(revenue[quietest]))}).`;
    }
    return renderReportSection(title, chart + renderReportChartCaption(caption));
}

// Items sold per category per month (services/aggregation sums "Quantity"),
// as stacked bars in revenue order - the same order and colours as the pie.
function buildReportCategoryPerMonthSection(series, categoryOrder, categoryColors) {
    const title = 'Transaction Volume of Each Category per Month';
    const noData = () => renderReportSection(title, renderReportMessage(REPORT_NO_DATA_TEXT), 'report-section-break');
    if (!hasReportSeries(series) || !series.datasets || series.datasets.length === 0) return noData();

    const labels = series.labels;
    const count = labels.length;
    const rank = name => {
        const index = categoryOrder.indexOf(name);
        return index === -1 ? categoryOrder.length : index;
    };
    const datasets = series.datasets
        .map(dataset => ({
            label: dataset.label,
            color: categoryColors.get(dataset.label) || '#999',
            values: labels.map((_, index) => reportNumber((dataset.data || [])[index]))
        }))
        .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
    const monthTotals = labels.map((_, index) => datasets.reduce((sum, dataset) => sum + dataset.values[index], 0));
    const grandTotal = sumReportValues(monthTotals);
    if (!grandTotal) return noData();

    const width = 800;
    const height = 340;
    const plot = { left: 52, right: 790, top: 34, bottom: 290 };
    const plotHeight = plot.bottom - plot.top;
    const band = (plot.right - plot.left) / count;
    const centerX = index => plot.left + band * (index + 0.5);
    const barWidth = Math.min(band * 0.72, 64);
    const axisFont = count <= 12 ? 11 : 9;
    // Segment labels need room: a wide-enough bar and a tall-enough slice.
    const segmentFont = barWidth >= 26 ? 9.5 : 0;

    const maxTotal = Math.max(...monthTotals);
    const step = niceReportStep(maxTotal / 5, true);
    const tickCount = Math.max(1, Math.ceil(maxTotal / step));
    const yMax = step * tickCount;
    const scale = value => (value / yMax) * plotHeight;

    const parts = [reportSvgText(plot.left - 44, plot.top - 18, 'Items sold', { size: 10.5, fill: '#666' })];
    for (let tick = 0; tick <= tickCount; tick++) {
        const y = plot.bottom - (tick / tickCount) * plotHeight;
        parts.push(`<line x1="${plot.left}" x2="${plot.right}" y1="${reportRound(y)}" y2="${reportRound(y)}" stroke="${tick === 0 ? '#c8c8c8' : '#ececec'}" stroke-width="1"/>`);
        parts.push(reportSvgText(plot.left - 8, y + 4, formatNumber(tick * step), { anchor: 'end', fill: '#666' }));
    }

    labels.forEach((label, index) => {
        const x = centerX(index) - barWidth / 2;
        let base = plot.bottom;
        datasets.forEach(dataset => {
            const value = dataset.values[index];
            if (!value) return;
            const segmentHeight = scale(value);
            const top = base - segmentHeight;
            parts.push(`<rect x="${reportRound(x)}" y="${reportRound(top)}" width="${reportRound(barWidth)}" height="${reportRound(segmentHeight)}" fill="${dataset.color}" stroke="#fff" stroke-width="0.75"/>`);
            if (segmentFont && segmentHeight >= 11) {
                parts.push(reportSvgText(centerX(index), top + segmentHeight / 2 + 3.5, formatNumber(value), {
                    anchor: 'middle', size: segmentFont, weight: 600, fill: reportTextColorOn(dataset.color)
                }));
            }
            base = top;
        });
        parts.push(reportSvgText(centerX(index), base - 6, formatNumber(monthTotals[index]), { anchor: 'middle', size: axisFont, weight: 600 }));
        parts.push(reportSvgMonthLabel(centerX(index), plot.bottom + 18, label, axisFont));
    });

    // Legend reads top of the stack first, like the bars themselves.
    const legend = `<div class="report-chart-legend">${datasets.slice().reverse().map(dataset => `
        <span class="report-legend-item">
            <span class="report-swatch" style="background:${dataset.color}"></span>
            <strong>${escapeHtml(dataset.label)}</strong>&nbsp;<span class="report-muted">${escapeHtml(formatNumber(sumReportValues(dataset.values)))}</span>
        </span>
    `).join('')}</div>`;
    const chart = renderReportChartCard(`${legend}<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${parts.join('')}</svg>`);

    const topMonth = monthTotals.indexOf(maxTotal);
    let caption = 'Each bar is one month and each color is a menu category. The taller the bar, the more items were sold that month – the number on top is the month\'s total';
    caption += count > 1
        ? ` (${reportStrong(labels[topMonth])} was highest with ${escapeHtml(formatNumber(maxTotal))}).`
        : '.';
    caption += ' Numbers inside the colors show how many items that category sold; thin slices are left blank.';
    caption += ` The legend shows each category's total for ${count > 1 ? `all ${count} months` : 'the month'} (${escapeHtml(formatNumber(grandTotal))} items).`;
    return renderReportSection(title, chart + renderReportChartCaption(caption), 'report-section-break');
}

function buildDayOfWeekNarrative(series) {
    const days = series.labels.map((label, index) => ({ label, value: reportNumber(series.data[index]) }));
    const total = sumReportValues(days.map(day => day.value));
    if (!total) return '';

    const busiest = days.reduce((best, day) => (day.value > best.value ? day : best), days[0]);
    const quietest = days.reduce((low, day) => (day.value < low.value ? day : low), days[0]);
    const weekendNames = ['Friday', 'Saturday', 'Sunday'];
    const weekendShare = sumReportValues(days.filter(day => weekendNames.includes(day.label)).map(day => day.value)) / total;
    const weekdayValues = days.filter(day => !weekendNames.includes(day.label)).map(day => day.value);
    const weekdayLow = Math.min(...weekdayValues);
    const weekdayHigh = Math.max(...weekdayValues);

    const sentences = [];
    let opening = '';
    if (weekendShare >= 0.47) opening = 'Business picks up toward the weekend: ';
    else if (weekendShare <= 0.39) opening = 'Business leans toward weekdays: ';
    let first = `${opening}${reportStrong(busiest.label)} is the busiest day with ${escapeHtml(formatNumber(busiest.value))} transactions`;
    if (quietest.value > 0 && busiest.value > quietest.value) {
        const more = Math.round((busiest.value / quietest.value - 1) * 100);
        first += `, about ${more}% more than ${reportStrong(quietest.label)}, the quietest at ${escapeHtml(formatNumber(quietest.value))}`;
    }
    sentences.push(`${first}.`);

    let second = `Friday, Saturday and Sunday together bring in ${reportStrong(`${Math.round(weekendShare * 100)}%`)} of all transactions`;
    if (weekendShare >= 0.55) second += ' – more than half of the business in just three days –';
    else if (weekendShare >= 0.45) second += ' – about half of the business in just three days –';
    else second += ',';
    const steady = weekdayLow > 0 && (weekdayHigh - weekdayLow) / weekdayLow <= 0.15;
    second += steady
        ? ` while Monday to Thursday stay steady at ${escapeHtml(formatNumber(weekdayLow))}–${escapeHtml(formatNumber(weekdayHigh))} each.`
        : ` while Monday to Thursday range from ${escapeHtml(formatNumber(weekdayLow))} to ${escapeHtml(formatNumber(weekdayHigh))}.`;
    sentences.push(second);

    sentences.push(weekendShare >= 0.45
        ? 'That makes Friday to Sunday the most important days to plan staff and stock for.'
        : `Plan staff and stock around ${escapeHtml(busiest.label)}, the busiest day.`);
    return sentences.join(' ');
}

function buildReportDayOfWeekSection(series) {
    const title = 'Transactions by Day of Week';
    if (!hasReportSeries(series)) return renderReportSection(title, renderReportMessage(REPORT_NO_DATA_TEXT));

    // The payload's labels are already Monday -> Sunday.
    const total = sumReportValues(series.data);
    const table = renderReportTable({
        columns: ['Day', 'Transactions', '% of Total'],
        align: ['left', 'right', 'right'],
        rows: series.labels.map((label, index) => {
            const value = reportNumber(series.data[index]);
            return [label, formatNumber(value), formatReportPercent(value, total)];
        }),
        footerRow: ['Total', formatNumber(total), total ? '100.0%' : '—']
    });
    const narrative = buildDayOfWeekNarrative(series);
    return renderReportSection(title, table + (narrative ? renderReportSummaryCallout(narrative) : ''));
}

// One box per opening hour, grouped into the three REPORT_SHIFTS rows; the
// hours outside opening time are folded into a dashed box at each end.
function buildReportHourOfDaySection(series, months) {
    const title = 'Transactions by Hour of Day';
    const sectionClass = 'report-section-break';
    if (!hasReportSeries(series)) return renderReportSection(title, renderReportMessage(REPORT_NO_DATA_TEXT), sectionClass);
    if (!series.hasTimeData) {
        return renderReportSection(title, renderReportMessage('No time-of-day data in the uploaded file.'), sectionClass);
    }

    const byHour = Array.from({ length: 24 }, (_, hour) => reportNumber(series.data[hour]));
    const total = sumReportValues(byHour);
    if (!total) return renderReportSection(title, renderReportMessage(REPORT_NO_DATA_TEXT), sectionClass);

    const hoursBetween = (from, to) => Array.from({ length: to - from }, (_, index) => from + index);
    const afterClosingHours = hoursBetween(0, REPORT_EARLY_MORNING_END);
    const beforeOpeningHours = hoursBetween(REPORT_EARLY_MORNING_END, REPORT_OPENING_HOUR);
    const firstMorningHour = beforeOpeningHours.find(hour => byHour[hour] > 0) ?? REPORT_EARLY_MORNING_END;
    const lastLateHour = afterClosingHours.slice().reverse().find(hour => byHour[hour] > 0) ?? REPORT_EARLY_MORNING_END - 1;

    const hourBox = hour => ({
        title: formatReportHour(hour),
        value: byHour[hour],
        range: `${hour % 12 || 12}:00 – ${formatReportClock(hour, 59)}`,
        hour
    });
    const outsideBoxes = {
        before: {
            title: `Before ${formatReportHour(REPORT_OPENING_HOUR)}`,
            value: sumReportValues(beforeOpeningHours.map(hour => byHour[hour])),
            range: `${formatReportHour(firstMorningHour)} – ${formatReportClock(REPORT_OPENING_HOUR - 1, 59)}`,
            outside: 'before'
        },
        after: {
            title: `After ${formatReportHour(REPORT_LAST_OPEN_HOUR)}`,
            value: sumReportValues(afterClosingHours.map(hour => byHour[hour])),
            range: `${formatReportHour(0)} – ${formatReportClock(lastLateHour, 59)}`,
            outside: 'after'
        }
    };

    const shifts = REPORT_SHIFTS.map(shift => {
        const boxes = shift.hours.map(hourBox);
        if (shift.outside === 'before') boxes.unshift(outsideBoxes.before);
        if (shift.outside === 'after') boxes.push(outsideBoxes.after);
        const first = shift.hours[0];
        const last = shift.hours[shift.hours.length - 1];
        return {
            name: shift.name,
            range: `${formatReportClock(first, 0)} – ${formatReportClock(last, 59)}`,
            boxes,
            total: sumReportValues(boxes.map(box => box.value))
        };
    });

    const allBoxes = shifts.flatMap(shift => shift.boxes);
    const maxValue = Math.max(...allBoxes.map(box => box.value));
    const peak = allBoxes
        .filter(box => !box.outside && box.value > 0)
        .reduce((best, box) => (!best || box.value > best.value ? box : best), null);

    const renderBox = box => {
        const share = `${formatReportPercent(box.value, total)} of all`;
        let style = '';
        if (!box.outside) {
            const background = reportHeatColor(maxValue ? box.value / maxValue : 0);
            style = ` style="background:${background};color:${reportTextColorOn(background, 0.25)}"`;
        }
        return `
            <div class="report-hour-box${box.outside ? ' report-hour-box-outside' : ''}"${style}>
                ${box === peak ? '<span class="report-hour-badge">Peak hour</span>' : ''}
                <div class="report-hour-title">${escapeHtml(box.title)}</div>
                <div class="report-hour-value">${escapeHtml(formatNumber(box.value))}</div>
                <div class="report-hour-detail">${escapeHtml(share)}</div>
                <div class="report-hour-detail">${escapeHtml(box.range)}</div>
                ${box.outside ? `<span class="report-hour-tag">${box.outside === 'before' ? 'before opening' : 'after closing'}</span>` : ''}
            </div>
        `;
    };

    const grid = `<div class="report-hour-grid">${shifts.map(shift => `
        <div class="report-hour-shift">
            <div class="report-hour-shift-name">${escapeHtml(shift.name)}</div>
            <div>${escapeHtml(shift.range)}</div>
            <div class="report-hour-shift-strong">${escapeHtml(formatNumber(shift.total))} transactions</div>
            <div class="report-hour-shift-strong report-hour-shift-share">${escapeHtml(formatReportPercent(shift.total, total))} of all</div>
        </div>
        ${shift.boxes.map(renderBox).join('')}
    `).join('')}</div>`;

    const gradient = REPORT_HEAT_STOPS.map(([at, color]) => `${color} ${at * 100}%`).join(', ');
    const legend = `
        <div class="report-hour-legend">
            <div class="report-hour-legend-row">
                <span>Fewer transactions</span>
                <span class="report-hour-gradient" style="background:linear-gradient(to right, ${gradient})"></span>
                <span>More transactions</span>
            </div>
            <div class="report-hour-legend-row">
                <span class="report-hour-dashed-icon"></span>
                <span>Dashed box = hours outside the ${escapeHtml(formatReportHour(REPORT_OPENING_HOUR))} – ${escapeHtml(formatReportHour(REPORT_LAST_OPEN_HOUR))} opening hours, counted with the nearest shift.</span>
            </div>
        </div>
    `;

    const busiestShift = shifts.reduce((best, shift) => (shift.total > best.total ? shift : best), shifts[0]);
    let period = reportStrong('totals for the selected period');
    if (months.length > 1) {
        period = `${reportStrong(`totals for all ${months.length} months`)} (${escapeHtml(months[0])} – ${escapeHtml(months[months.length - 1])})`;
    } else if (months.length === 1) {
        period = reportStrong(`totals for ${months[0]}`);
    }
    let caption = `Each box is one hour of the day – the darker the box, the busier it was. The numbers are ${period}. `
        + `${reportStrong(busiestShift.name)} is the busiest (${escapeHtml(formatReportPercent(busiestShift.total, total))} of all transactions)`;
    if (peak) caption += ` and ${reportStrong(peak.title)} is the busiest hour (${escapeHtml(formatNumber(peak.value))})`;
    caption += '.';

    return renderReportSection(title, grid + legend + renderReportChartCaption(caption), sectionClass);
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
