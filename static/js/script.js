// Shared across all pages

// --- login ---

document.addEventListener('DOMContentLoaded', function() {
    if (document.getElementById('loginForm')) {
        handleLoginPage();
    } else {
        initializeCommonFunctionality();
    }
});

// --- session ---

// any 401 (except the login call itself) sends the user back to the login page
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

// back/forward cache skips the server's login check, so reload
window.addEventListener('pageshow', function(event) {
    if (event.persisted && !document.getElementById('loginForm')) {
        window.location.reload();
    }
});

function handleLoginPage() {
    const loginForm = document.getElementById('loginForm');
    // the "email" field is really the username
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const rememberMe = document.getElementById('rememberMe');
    const errorMessage = document.getElementById('errorMessage');

    wirePasswordToggle(passwordInput, document.getElementById('passwordToggle'));

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

// set back to hidden before submit so the browser doesn't save it as plain text
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

// --- common ---

function initializeCommonFunctionality() {
    initializeNavigation();
    initializeHamburger();
    initializeSignOut();
    initializeHelpModal();
    initializeUserHeader();
    initializeInfoTooltips();
}

// --- info tooltips ---

// ⓘ icons open a popup instead of a hover bubble, works on touch too
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

    // title comes from the label the icon sits in
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

// --- user header / settings ---

let currentSessionUsername = '';

async function initializeUserHeader() {
    try {
        const response = await fetch('/api/session');
        if (!response.ok) return;
        const session = await response.json();
        currentSessionUsername = session.username || '';
        renderUserHeader(session);
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

// --- modals ---

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

document.addEventListener('click', function(event) {
    if (event.target.classList.contains('modal-overlay')) {
        event.target.classList.remove('active');
    }
});


function showNotification(message, type = 'success') {
    const existingNotification = document.querySelector('.notification');
    if (existingNotification) {
        existingNotification.remove();
    }

    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// --- formatting ---

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

// --- print reports ---

// reports render into the hidden #printReport and print that, the app shell doesn't paginate

// cleanup for a report whose afterprint hasn't fired yet
let pendingReportCleanup = null;

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function wirePrintReportButton(onClick) {
    const button = document.getElementById('printReportBtn');
    if (!button) return;
    button.addEventListener('click', onClick);
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

// filterLines / options.metaLines: [{label, value}]. logo url comes from #printReport's data-logo-src
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
                ${logoSrc ? `<img class="report-logo" src="${escapeHtml(logoSrc)}" alt="Keat">` : ''}
                <div>
                    <h1 class="report-title">${escapeHtml(title)}</h1>
                    <div class="report-generated">
                        Generated: ${escapeHtml(formatReportTimestamp(new Date()))}
                        &nbsp;|&nbsp; Generated by: ${escapeHtml(generatedBy)}
                    </div>
                </div>
            </div>
            ${metaLines.length ? `<div class="report-meta">${renderReportLabelList(metaLines)}</div>` : ''}
            <div class="report-filters">
                <div class="report-filters-title">Filters applied</div>
                ${lines.length ? renderReportLabelList(lines) : '<div>None</div>'}
            </div>
            ${settings.note ? `<p class="report-note">${escapeHtml(settings.note)}</p>` : ''}
        </header>
    `;
}

function renderReportLabelList(lines) {
    return `<ul class="report-label-list">${lines
        .map(line => `<li><span class="report-label">${escapeHtml(line.label)}:</span> ${escapeHtml(line.value)}</li>`)
        .join('')}</ul>`;
}

// totals go in the last tbody row, a tfoot would repeat on every printed page
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
        .map((cell, index) => `<${tag}${cellClass(index)}>${escapeHtml(cell)}</${tag}>`)
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

// bodyHtml must already be escaped
function renderReportSection(title, bodyHtml, className) {
    return `
        <section class="report-section${className ? ' ' + className : ''}">
            <h2 class="report-section-title">${escapeHtml(title)}</h2>
            ${bodyHtml}
        </section>
    `;
}

function renderReportMessage(text, className) {
    return `<p class="${className || 'report-message'}">${escapeHtml(text)}</p>`;
}

// reason also goes on the wrapper, some browsers don't show a disabled button's tooltip
function setPrintButtonState(button, enabled, disabledReason) {
    if (!button) return;
    const title = enabled ? 'Print this report' : (disabledReason || 'Nothing to print.');
    button.disabled = !enabled;
    button.title = title;
    if (button.parentElement) button.parentElement.title = title;
}

// wait briefly for the logo so it isn't blank in the print
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

window.mockData = {
    products: []
};
