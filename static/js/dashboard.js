// Dashboard page

let orderSummaryChart = null;
let bestSellingChart = null;
let transactionVolumeChart = null;
let revenueByCategoryChart = null;
let monthlySalesTrendChart = null;
let topProductsMonthlyChart = null;
let transactionsByDayChart = null;
let transactionsByHourChart = null;

// top 10 products chart sort, reset to desc on every refresh
let topProductsSortDirection = 'desc';
let lastTopProductsMonthlyData = null;

let currentCategoryOptions = [];
let currentProductOptions = [];
// empty = all
let selectedCategories = [];
let selectedProducts = [];
let productFilterSearchTerm = '';

let startDatePicker = null;
let endDatePicker = null;

// what's on screen, so the printed report matches it
let lastDashboardResults = null;
let lastDashboardFilterLines = [];

const REPORT_FILTER_LIST_LIMIT = 10;

// neighbouring colors are different hues
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

// top 10 products chart, similar shades are 5 slots apart
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
    await Promise.all([loadCategoryOptions(), loadProductOptions(), loadDashboardResults()]);
}

// --- date filters ---

function wireTimePeriodControls() {
    const startInput = document.getElementById('startDateFilter');
    const endInput = document.getElementById('endDateFilter');
    const quickButtons = document.querySelectorAll('.quick-filter-btn');

    initDateFilterPickers();

    quickButtons.forEach(button => {
        button.addEventListener('click', function() {
            // clicking the active filter again clears it
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

// flatpickr for a fixed mm/dd/yyyy display, the inputs still hold yyyy-mm-dd
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

// set through flatpickr so the visible input updates too
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

// week starts Monday, year is Jan 1 - Dec 31
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

// --- category / product filters ---

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

    selectedProducts = selectedProducts.filter(name => currentProductOptions.includes(name));

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
    // search only hides rows, checked products stay selected
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

// parsed by hand, new Date(iso) can shift the day in some timezones
function formatDisplayDate(isoValue) {
    if (!isoValue) return '';
    const [year, month, day] = isoValue.split('-').map(Number);
    if (!year || !month || !day) return '';
    return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

const QUICK_FILTER_SUBTEXT_LABELS = {
    today: 'today',
    week: 'this week',
    year: 'this year'
};

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
    if (productsPerTransactionEl) productsPerTransactionEl.textContent = formatAverageProductsRange(dashboard.averageProductsPerTransaction);
    if (tooltipTextEl) tooltipTextEl.textContent = buildAverageProductsTooltip(dashboard.averageProductsPerTransaction);
}

// 2.71 -> "2-3", exactly 3 -> "3-4"
function formatAverageProductsRange(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    const low = Math.floor(value);
    const high = low + 1;
    return `${low}-${high}`;
}

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

// --- print report ---

function printDashboardReport() {
    if (!lastDashboardResults || !lastDashboardResults.dashboard) return;
    printReportHtml(buildDashboardReportHtml(lastDashboardResults.dashboard, lastDashboardFilterLines));
}

// relative ranges like "this week" get the real dates added
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

// --- charts ---

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

// orders per month

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

// top 10 best sellers

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

// category volume per month

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

// revenue by category

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

// monthly sales

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

// top 10 products per month

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

// transactions by day of week

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

// transactions by hour

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
