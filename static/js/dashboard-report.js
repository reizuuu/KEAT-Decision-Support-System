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
