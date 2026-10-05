/* ====================================
   KEAT DECISION SUPPORT SYSTEM
   Global JavaScript Functions
   ==================================== */

// ====================================
// LOGIN FUNCTIONALITY
// ====================================

document.addEventListener('DOMContentLoaded', function() {
    // Check if on login page
    if (document.getElementById('loginForm')) {
        handleLoginPage();
    } else {
        // The server already redirects anonymous visitors away from
        // protected pages (see services/auth.enforce_login); the two guards
        // below cover a page that's already open when the session ends.
        initializeCommonFunctionality();
    }
});

// ====================================
// SESSION GUARDS
// ====================================

// Any API call answered with 401 means the session has ended (signed out in
// another tab, server restarted, account removed) - send the user back to
// the login page instead of leaving a page that silently fails to load.
// The login request itself is exempt: a 401 there is just a wrong password.
(function guardApiSessions() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
        const response = await nativeFetch(input, init);
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (response.status === 401 && !url.includes('/api/login') && !document.getElementById('loginForm')) {
            window.location.replace('/');
        }
        return response;
    };
})();

// A page restored from the browser's back/forward cache skips the server's
// login check - reload it so the server decides whether it's still allowed.
window.addEventListener('pageshow', function(event) {
    if (event.persisted && !document.getElementById('loginForm')) {
        window.location.reload();
    }
});

function handleLoginPage() {
    const loginForm = document.getElementById('loginForm');
    // The form's field is labeled/id "email", but the account schema is
    // username-based (single-admin app) - its value is sent as the
    // username, which in practice will usually look like an email address.
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const rememberMe = document.getElementById('rememberMe');
    const errorMessage = document.getElementById('errorMessage');

    wirePasswordToggle(passwordInput, document.getElementById('passwordToggle'));

    // Pre-fill if remembered
    if (localStorage.getItem('rememberEmail')) {
        emailInput.value = localStorage.getItem('rememberEmail');
        rememberMe.checked = true;
    }

    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();

        const username = emailInput.value.trim();
        const password = passwordInput.value;

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const payload = await response.json();

            if (!response.ok) {
                errorMessage.textContent = payload.error || 'Invalid username or password.';
                errorMessage.classList.add('show');
                return;
            }

            errorMessage.classList.remove('show');

            // Save remember me preference
            if (rememberMe.checked) {
                localStorage.setItem('rememberEmail', username);
            } else {
                localStorage.removeItem('rememberEmail');
            }

            window.location.href = '/dashboard';
        } catch (error) {
            errorMessage.textContent = 'Unable to reach the server. Please try again.';
            errorMessage.classList.add('show');
        }
    });
}

// Eye button inside the password box: switches it between hidden and
// visible text. Always switched back to hidden before the form submits, so
// the browser never saves or autofills it as a plain text field.
function wirePasswordToggle(input, button) {
    if (!input || !button) return;
    const icon = button.querySelector('i');

    function setVisible(visible) {
        input.type = visible ? 'text' : 'password';
        const label = visible ? 'Hide password' : 'Show password';
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(visible));
        button.title = label;
        if (icon) {
            icon.classList.toggle('fa-eye', !visible);
            icon.classList.toggle('fa-eye-slash', visible);
        }
    }

    button.addEventListener('click', function() {
        setVisible(input.type === 'password');
        input.focus();
    });
    if (input.form) input.form.addEventListener('submit', () => setVisible(false));
}

// ====================================
// COMMON FUNCTIONALITY FOR ALL PAGES
// ====================================

function initializeCommonFunctionality() {
    initializeNavigation();
    initializeHamburger();
    initializeSignOut();
    initializeHelpModal();
    initializeUserHeader();
    initializeInfoTooltips();
}

// ====================================
// INFO TOOLTIPS (ⓘ icons - dashboard stat cards, analytics stat boxes, etc.)
// ====================================

// Clicking a ⓘ icon opens a shared popup modal with its explanation,
// instead of a hover bubble - works identically on desktop and touch, and
// isn't at risk of being clipped near the edge of a scrollable page.
// Shared here (not page-specific JS) since .info-tooltip is used on more
// than one page.
function initializeInfoTooltips() {
    document.querySelectorAll('.info-tooltip').forEach(tooltip => {
        tooltip.addEventListener('click', function(event) {
            event.stopPropagation();
            openInfoPopup(this);
        });
    });
}

let infoPopupModalReady = false;

function ensureInfoPopupModal() {
    if (infoPopupModalReady) return;
    infoPopupModalReady = true;

    const modalHtml = `
        <div class="modal-overlay" id="infoPopupModal">
            <div class="modal">
                <div class="modal-header" id="infoPopupTitle">What does this mean?</div>
                <div class="modal-body">
                    <p id="infoPopupText"></p>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="closeModal('infoPopupModal')">Close</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function openInfoPopup(tooltipEl) {
    ensureInfoPopupModal();

    const bubble = tooltipEl.querySelector('.info-tooltip-bubble');
    const text = bubble ? bubble.textContent.trim() : '';

    // Derives the popup's title from the label the icon sits inside (e.g.
    // "Average Number of Products per Transaction", "Product Combos
    // Found") rather than hardcoding one per icon.
    const labelContainer = tooltipEl.closest('.stat-card-title, .stat-box-label, label');
    let title = 'What does this mean?';
    if (labelContainer) {
        const clone = labelContainer.cloneNode(true);
        const tooltipClone = clone.querySelector('.info-tooltip');
        if (tooltipClone) tooltipClone.remove();
        const cloneText = clone.textContent.replace(/\s+/g, ' ').trim();
        if (cloneText) title = cloneText;
    }

    const titleEl = document.getElementById('infoPopupTitle');
    const textEl = document.getElementById('infoPopupText');
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = text;

    openModal('infoPopupModal');
}

function initializeNavigation() {
    // Set active nav based on current page
    const currentPage = getCurrentPage();
    const navLinks = document.querySelectorAll('.sidebar-nav a');

    navLinks.forEach(link => {
        link.classList.remove('active');
        const href = link.getAttribute('href');
        if (href === currentPage || new URL(link.href).pathname === currentPage) {
            link.classList.add('active');
        }
    });
}

function getCurrentPage() {
    const path = window.location.pathname;
    if (path.includes('/dashboard')) {
        return '/dashboard';
    } else if (path.includes('/analytics')) {
        return '/analytics';
    } else if (path.includes('/products')) {
        return '/products';
    } else if (path.includes('/upload')) {
        return '/upload';
    }
    return '/dashboard';
}

function initializeHamburger() {
    const hamburger = document.getElementById('hamburger');
    if (!hamburger) return;

    const sidebar = document.getElementById('sidebar');

    hamburger.addEventListener('click', function() {
        sidebar.classList.toggle('active');
    });

    // Close sidebar when clicking outside
    document.addEventListener('click', function(event) {
        if (!event.target.closest('.sidebar') && !event.target.closest('.hamburger')) {
            sidebar.classList.remove('active');
        }
    });
}

function initializeSignOut() {
    const signOutBtns = document.querySelectorAll('#signOutBtn');

    signOutBtns.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            openModal('signOutConfirmModal');
        });
    });
}

function closeSignOutConfirm() {
    closeModal('signOutConfirmModal');
}

async function confirmSignOut() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } finally {
        window.location.href = '/';
    }
}

function initializeHelpModal() {
    const helpBtns = document.querySelectorAll('#helpBtn');
    const helpModal = document.getElementById('helpModal');

    if (!helpModal) return;

    helpBtns.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            helpModal.classList.add('active');
        });
    });
}

function closeHelpModal() {
    const helpModal = document.getElementById('helpModal');
    if (helpModal) {
        helpModal.classList.remove('active');
    }
}

// ====================================
// USER HEADER (session info + account settings gear)
// ====================================

// Cached from the last /api/session load, so opening the settings modal can
// pre-fill the username field without a second round trip.
let currentSessionUsername = '';

async function initializeUserHeader() {
    try {
        const response = await fetch('/api/session');
        if (!response.ok) return;
        const session = await response.json();
        currentSessionUsername = session.username || '';
        renderUserHeader(session);
        // Every authenticated session can manage its own credentials now -
        // there's no separate "manage any account" tier anymore.
        showSettingsGear();
    } catch (error) {
        console.warn('Unable to load session info.', error);
    }
}

function renderUserHeader(session) {
    const avatar = document.getElementById('userAvatar');
    const nameEl = document.getElementById('userName');
    const roleEl = document.getElementById('userRole');

    const username = session.username || '';
    const role = session.role || '';

    if (avatar) avatar.textContent = username ? username.charAt(0).toUpperCase() : '?';
    if (nameEl) nameEl.textContent = username;
    if (roleEl) roleEl.textContent = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
}

function showSettingsGear() {
    const gearBtn = document.getElementById('settingsGearBtn');
    if (!gearBtn) return;

    gearBtn.hidden = false;
    gearBtn.addEventListener('click', function(e) {
        e.preventDefault();
        openSettingsModal();
    });
}

let settingsModalReady = false;

function ensureSettingsModal() {
    if (settingsModalReady) return;
    settingsModalReady = true;

    const modalHtml = `
        <div class="modal-overlay" id="settingsModal">
            <div class="modal">
                <div class="modal-header">Account Settings</div>
                <div class="modal-body">
                    <form id="settingsForm">
                        <div class="form-group">
                            <label for="settingsUsername">Username</label>
                            <input type="text" id="settingsUsername" placeholder="Username">
                        </div>
                        <div class="form-group">
                            <label for="settingsPassword">Password</label>
                            <input type="password" id="settingsPassword" placeholder="New password">
                            <div class="form-note">Note: Leave blank to keep current password</div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="closeSettingsModal()">Cancel</button>
                    <button class="btn-primary" onclick="saveSettingsAccount()">Save</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const form = document.getElementById('settingsForm');
    if (form) {
        form.addEventListener('submit', function(e) {
            e.preventDefault();
        });
    }
}

// No "pick an account" step anymore - every session can only ever reach its
// own credentials (see PUT /api/users/me), so the form just pre-fills with
// the session's own username.
function openSettingsModal() {
    ensureSettingsModal();

    const usernameInput = document.getElementById('settingsUsername');
    const passwordInput = document.getElementById('settingsPassword');
    if (usernameInput) usernameInput.value = currentSessionUsername;
    if (passwordInput) passwordInput.value = '';

    openModal('settingsModal');
}

function closeSettingsModal() {
    closeModal('settingsModal');
}

async function saveSettingsAccount() {
    const usernameInput = document.getElementById('settingsUsername');
    const passwordInput = document.getElementById('settingsPassword');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!username) {
        showNotification('Username cannot be empty.', 'error');
        return;
    }

    const body = {};
    if (username && username !== currentSessionUsername) body.username = username;
    if (password) body.password = password;

    if (Object.keys(body).length === 0) {
        showNotification('Nothing to update.', 'error');
        return;
    }

    try {
        const response = await fetch('/api/users/me', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            showNotification(payload.error || 'Unable to update account.', 'error');
            return;
        }

        currentSessionUsername = payload.username || currentSessionUsername;
        renderUserHeader({ username: currentSessionUsername, role: payload.role });
        showNotification('Account updated successfully');
        closeSettingsModal();
    } catch (error) {
        showNotification('Unable to reach the server. Please try again.', 'error');
    }
}

// ====================================
// MODAL UTILITIES
// ====================================

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
    }
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
    }
}

// Close modal when clicking outside
document.addEventListener('click', function(event) {
    if (event.target.classList.contains('modal-overlay')) {
        event.target.classList.remove('active');
    }
});

// ====================================
// NAVIGATION HELPERS
// ====================================

function showNotification(message, type = 'success') {
    // Remove existing notification
    const existingNotification = document.querySelector('.notification');
    if (existingNotification) {
        existingNotification.remove();
    }

    // Create notification
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    // Remove after 3 seconds
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// ====================================
// UTILITY FUNCTIONS
// ====================================

function formatCurrency(value) {
    return '₱' + parseFloat(value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatNumber(value) {
    return parseFloat(value).toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

// ====================================
// PRINT REPORTS (Dashboard + Analytics "Print Report" buttons)
// ====================================

/* Both report pages build their printable output as an HTML string into the
   hidden #printReport container and print that, instead of printing the live
   page: the live page is a fixed-height, overflow-hidden app shell full of
   canvases and controls, which doesn't paginate. The @media print rules in
   style.css only swap the app out for #printReport while <body> has the
   .printing-report class, so a plain Ctrl+P still behaves as it did before. */

// Cleanup for a report that's still on the page (its afterprint hasn't fired
// yet) - run first if another print starts, so the older report's afterprint
// listener can't wipe out the newer one.
let pendingReportCleanup = null;

// Deliberately NOT named escapeHtml: analytics.js/products.js/upload.js each
// declare their own global escapeHtml(), and a same-named declaration here
// would just be silently replaced by whichever page script loads last.
function escapeReportHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function formatReportTimestamp(date) {
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

// `filterLines` (and options.metaLines) are [{label, value}] pairs, rendered
// as "Label: value". options.note is an optional one-line remark under the
// filters. The logo URL comes from #printReport's data-logo-src (set with
// url_for() in the template) so this file doesn't hardcode the static path.
function buildReportHeader(title, filterLines, options) {
    const settings = options || {};
    const container = document.getElementById('printReport');
    const logoSrc = container ? container.getAttribute('data-logo-src') : '';
    const userNameEl = document.getElementById('userName');
    const userName = userNameEl ? userNameEl.textContent.trim() : '';
    const generatedBy = userName && userName !== '—' ? userName : 'Unknown user';
    const metaLines = settings.metaLines || [];
    const lines = filterLines || [];

    return `
        <header class="report-header">
            <div class="report-brand">
                ${logoSrc ? `<img class="report-logo" src="${escapeReportHtml(logoSrc)}" alt="Keat">` : ''}
                <div>
                    <h1 class="report-title">${escapeReportHtml(title)}</h1>
                    <div class="report-generated">
                        Generated: ${escapeReportHtml(formatReportTimestamp(new Date()))}
                        &nbsp;|&nbsp; Generated by: ${escapeReportHtml(generatedBy)}
                    </div>
                </div>
            </div>
            ${metaLines.length ? `<div class="report-meta">${renderReportLabelList(metaLines)}</div>` : ''}
            <div class="report-filters">
                <div class="report-filters-title">Filters applied</div>
                ${lines.length ? renderReportLabelList(lines) : '<div>None</div>'}
            </div>
            ${settings.note ? `<p class="report-note">${escapeReportHtml(settings.note)}</p>` : ''}
        </header>
    `;
}

function renderReportLabelList(lines) {
    return `<ul class="report-label-list">${lines
        .map(line => `<li><span class="report-label">${escapeReportHtml(line.label)}:</span> ${escapeReportHtml(line.value)}</li>`)
        .join('')}</ul>`;
}

// columns: header labels; rows: arrays of cell values (already formatted
// for display - every value is escaped here); align: per-column 'left'
// (default) / 'right' / 'center'; footerRow: an optional bold totals row.
// The totals row is rendered as the last <tbody> row, not a <tfoot>, because
// browsers repeat <tfoot> at the bottom of every printed page - a "Total"
// line under each page's partial rows would read as a subtotal.
function renderReportTable(config) {
    const columns = config.columns || [];
    const rows = config.rows || [];
    const align = config.align || [];

    const cellClass = index => {
        if (align[index] === 'right') return ' class="report-num"';
        if (align[index] === 'center') return ' class="report-center"';
        return '';
    };
    const renderCells = (cells, tag) => cells
        .map((cell, index) => `<${tag}${cellClass(index)}>${escapeReportHtml(cell)}</${tag}>`)
        .join('');

    const bodyRows = rows.map(row => `<tr>${renderCells(row, 'td')}</tr>`);
    if (config.footerRow) {
        bodyRows.push(`<tr class="report-total-row">${renderCells(config.footerRow, 'td')}</tr>`);
    }

    return `
        <table class="report-table${config.className ? ' ' + config.className : ''}">
            <thead><tr>${renderCells(columns, 'th')}</tr></thead>
            <tbody>${bodyRows.join('')}</tbody>
        </table>
    `;
}

// bodyHtml must already be safe HTML (built by renderReportTable/
// renderReportMessage or escaped by the caller).
function renderReportSection(title, bodyHtml, className) {
    return `
        <section class="report-section${className ? ' ' + className : ''}">
            <h2 class="report-section-title">${escapeReportHtml(title)}</h2>
            ${bodyHtml}
        </section>
    `;
}

function renderReportMessage(text, className) {
    return `<p class="${className || 'report-message'}">${escapeReportHtml(text)}</p>`;
}

// Enables/disables a Print Report button. The reason goes on the button's
// wrapper too, since some browsers don't show a disabled button's own
// tooltip (disabled elements don't receive hover events there).
function setPrintButtonState(button, enabled, disabledReason) {
    if (!button) return;
    const title = enabled ? 'Print this report' : (disabledReason || 'Nothing to print.');
    button.disabled = !enabled;
    button.title = title;
    if (button.parentElement) button.parentElement.title = title;
}

// Waits (briefly) for the report's images - the header logo - to load, so the
// print snapshot isn't taken with a blank logo on a cold cache.
function waitForReportImages(container, timeoutMs) {
    const pending = Array.from(container.querySelectorAll('img'))
        .filter(img => !img.complete)
        .map(img => new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
        }));
    if (pending.length === 0) return Promise.resolve();
    return Promise.race([
        Promise.all(pending),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
}

// options.landscape adds body.print-landscape, which switches #printReport
// onto the landscape named page (see the PRINT section of style.css). Both
// body classes and the report HTML are removed again on afterprint, so the
// on-screen page is left exactly as it was.
function printReportHtml(html, options) {
    const container = document.getElementById('printReport');
    if (!container) return;
    const settings = options || {};

    if (pendingReportCleanup) pendingReportCleanup();

    container.innerHTML = html;
    document.body.classList.add('printing-report');
    document.body.classList.toggle('print-landscape', Boolean(settings.landscape));

    function cleanUp() {
        window.removeEventListener('afterprint', cleanUp);
        if (pendingReportCleanup === cleanUp) pendingReportCleanup = null;
        container.innerHTML = '';
        document.body.classList.remove('printing-report', 'print-landscape');
    }
    pendingReportCleanup = cleanUp;
    window.addEventListener('afterprint', cleanUp);

    waitForReportImages(container, 2000).then(() => window.print());
}

// Populated from the database on each page's load (see products.js) -
// renders a blank/empty state until then.
window.mockData = {
    products: []
};
