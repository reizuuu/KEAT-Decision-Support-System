/* ====================================
   KEAT DECISION SUPPORT SYSTEM
   Products JavaScript
   ==================================== */

let currentEditingProductId = null;
let currentSearchTerm = '';
let currentCategoryFilter = 'all';

const NEW_CATEGORY_SENTINEL = '__new__';

document.addEventListener('DOMContentLoaded', function() {
    initializeProductsPage();
});

function initializeProductsPage() {
    initializeProductTable();
    initializeProductModal();
    initializeProductSearch();
    initializeCategoryFilter();
}

async function initializeProductTable() {
    await loadAllCategoriesForFilter();
    await loadProductsFromServer();
    updateProductCount();
    renderProductTable();
}

async function loadAllCategoriesForFilter() {
    try {
        const response = await fetch('/api/categories');
        if (response.ok) {
            const payload = await response.json();
            const categories = payload.categories || [];
            populateCategoryFilterOptions(categories);
            populateProductCategoryOptions(categories);
        }
    } catch (error) {
        console.warn('Unable to load categories.', error);
    }
}

async function loadProductsFromServer() {
    // Category filtering is server-side (?category=), so the list this page
    // holds is already scoped to the selected category; text search is then
    // applied on top of that, client-side, in getVisibleProducts().
    const params = currentCategoryFilter !== 'all' ? `?category=${encodeURIComponent(currentCategoryFilter)}` : '';
    try {
        const response = await fetch(`/api/products${params}`);
        if (response.ok) {
            const payload = await response.json();
            window.mockData.products = payload.products || [];
            updateProductCount();
            return;
        }
    } catch (error) {
        console.warn('Unable to load products.', error);
    }
    window.mockData.products = [];
    updateProductCount();
}

function updateProductCount() {
    const productCount = document.getElementById('productCount');
    if (productCount) {
        productCount.textContent = window.mockData.products.length;
    }
}

function getVisibleProducts() {
    // Category filtering already happened server-side (see
    // loadProductsFromServer) - only the text search applies here, on top
    // of whatever category-scoped list is currently loaded.
    const searchLower = currentSearchTerm.toLowerCase();
    return window.mockData.products
        .filter(product => {
            return (
                !searchLower ||
                product.name.toLowerCase().includes(searchLower) ||
                product.category.toLowerCase().includes(searchLower) ||
                (product.alias || '').toLowerCase().includes(searchLower)
            );
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

function renderProductTable() {
    const tableBody = document.getElementById('productsTableBody');
    if (!tableBody) return;

    // Alphabetical order holds here regardless of API ordering or future
    // client-side edits/additions, and both the text search and category
    // filter compose together via getVisibleProducts().
    const products = getVisibleProducts();

    if (products.length === 0) {
        const message = window.mockData.products.length === 0
            ? 'No products yet. Upload a file to get started.'
            : 'No products match your search.';
        tableBody.innerHTML = `<tr><td colspan="4" class="table-empty-message">${message}</td></tr>`;
        return;
    }

    tableBody.innerHTML = products.map(product => `
        <tr>
            <td>
                <div class="product-name-cell">${escapeHtml(product.name)}</div>
                ${product.alias ? `<div class="product-alias-cell">(${escapeHtml(product.alias)})</div>` : ''}
            </td>
            <td>${escapeHtml(product.category)}</td>
            <td>₱${product.price.toFixed(2)}</td>
            <td>
                <div class="action-icons">
                    <a href="#" class="edit-product" data-id="${product.id}">
                        <i class="fas fa-edit"></i>
                    </a>
                    <a href="#" class="delete-product" data-id="${product.id}">
                        <i class="fas fa-trash"></i>
                    </a>
                </div>
            </td>
        </tr>
    `).join('');

    initializeProductActions();
}

function initializeProductModal() {
    const addProductBtn = document.getElementById('addProductBtn');
    const productForm = document.getElementById('productForm');
    const productCategory = document.getElementById('productCategory');

    if (addProductBtn) {
        addProductBtn.addEventListener('click', function() {
            openAddProductModal();
        });
    }

    if (productForm) {
        productForm.addEventListener('submit', function(e) {
            e.preventDefault();
        });
    }

    if (productCategory) {
        productCategory.addEventListener('change', function() {
            if (this.value === NEW_CATEGORY_SENTINEL) {
                showNewCategoryInput();
            } else {
                hideNewCategoryInput();
            }
        });
    }
}

function showNewCategoryInput() {
    const group = document.getElementById('newCategoryGroup');
    const input = document.getElementById('newCategoryName');
    if (group) group.hidden = false;
    if (input) input.focus();
}

function hideNewCategoryInput() {
    const group = document.getElementById('newCategoryGroup');
    const input = document.getElementById('newCategoryName');
    if (group) group.hidden = true;
    if (input) input.value = '';
}

// Re-fetches categories fresh (rather than relying on the dropdown built
// once at page load) so a category created since this page loaded - e.g.
// via an upload in another tab, or another admin - is available before the
// modal opens. Fixes the "blank category on edit" bug: a native <select>
// silently leaves .value unset if the target string isn't already an
// <option>, which happened whenever the cached dropdown was stale.
async function refreshProductCategoryOptions() {
    try {
        const response = await fetch('/api/categories');
        if (response.ok) {
            const payload = await response.json();
            const categories = payload.categories || [];
            populateCategoryFilterOptions(categories);
            populateProductCategoryOptions(categories);
            return categories;
        }
    } catch (error) {
        console.warn('Unable to refresh categories.', error);
    }
    return [];
}

function setProductCategorySelectValue(categoryName) {
    const select = document.getElementById('productCategory');
    if (!select) return;

    select.value = categoryName;
    if (select.value === categoryName) return;

    // Category was renamed/removed elsewhere since the refresh above - don't
    // fail quietly a second time; insert a temporary option for the
    // product's current value instead of leaving the dropdown blank.
    const option = document.createElement('option');
    option.value = categoryName;
    option.textContent = categoryName;
    const sentinel = select.querySelector(`option[value="${NEW_CATEGORY_SENTINEL}"]`);
    if (sentinel) {
        select.insertBefore(option, sentinel);
    } else {
        select.appendChild(option);
    }
    select.value = categoryName;
}

async function openAddProductModal() {
    currentEditingProductId = null;
    const modalTitle = document.getElementById('productModalTitle');
    const productForm = document.getElementById('productForm');
    const saveBtn = document.querySelector('.modal-footer .btn-primary');

    if (modalTitle) modalTitle.textContent = 'Add Product';
    if (saveBtn) saveBtn.textContent = 'Add Product';

    if (productForm) {
        productForm.reset();
        document.getElementById('productId').value = '';
    }

    await refreshProductCategoryOptions();
    document.getElementById('productCategory').value = '';
    hideNewCategoryInput();

    openModal('productModal');
}

function initializeProductSearch() {
    const productSearch = document.getElementById('productSearch');

    if (productSearch) {
        productSearch.addEventListener('input', function() {
            currentSearchTerm = this.value;
            renderProductTable();
        });
    }
}

function populateCategoryFilterOptions(categories) {
    const categoryFilter = document.getElementById('categoryFilter');
    if (!categoryFilter) return;

    const previousValue = categoryFilter.value || 'all';

    categoryFilter.innerHTML = '<option value="all">All Categories</option>' +
        categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');

    categoryFilter.value = categories.includes(previousValue) ? previousValue : 'all';
    currentCategoryFilter = categoryFilter.value;
}

function populateProductCategoryOptions(categories) {
    const productCategory = document.getElementById('productCategory');
    if (!productCategory) return;

    const previousValue = productCategory.value;

    productCategory.innerHTML = '<option value="">Select category</option>' +
        categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('') +
        `<option value="${NEW_CATEGORY_SENTINEL}">+ Add New Category</option>`;

    if (categories.includes(previousValue)) productCategory.value = previousValue;
}

function initializeCategoryFilter() {
    const categoryFilter = document.getElementById('categoryFilter');
    if (!categoryFilter) return;

    categoryFilter.addEventListener('change', async function() {
        currentCategoryFilter = this.value;
        await loadProductsFromServer();
        renderProductTable();
    });
}

function initializeProductActions() {
    const editButtons = document.querySelectorAll('.edit-product');
    editButtons.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            const productId = parseInt(this.getAttribute('data-id'));
            openEditProductModal(productId);
        });
    });

    const deleteButtons = document.querySelectorAll('.delete-product');
    deleteButtons.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            const productId = parseInt(this.getAttribute('data-id'));
            openDeleteConfirm(productId);
        });
    });
}

async function openEditProductModal(productId) {
    currentEditingProductId = productId;
    const product = window.mockData.products.find(p => p.id === productId);

    if (!product) return;

    const modalTitle = document.getElementById('productModalTitle');
    const productForm = document.getElementById('productForm');
    const saveBtn = document.querySelector('.modal-footer .btn-primary');

    if (modalTitle) modalTitle.textContent = 'Edit Product';
    if (saveBtn) saveBtn.textContent = 'Update Product';

    await refreshProductCategoryOptions();
    hideNewCategoryInput();

    if (productForm) {
        document.getElementById('productName').value = product.name;
        document.getElementById('productAlias').value = product.alias || '';
        setProductCategorySelectValue(product.category);
        document.getElementById('productPrice').value = product.price || '';
        document.getElementById('productId').value = product.id;
    }

    openModal('productModal');
}

async function saveProduct() {
    const productName = document.getElementById('productName').value.trim();
    const productAlias = document.getElementById('productAlias').value.trim();
    const categorySelectValue = document.getElementById('productCategory').value;
    const newCategoryName = document.getElementById('newCategoryName').value.trim();
    const productCategory = categorySelectValue === NEW_CATEGORY_SENTINEL ? newCategoryName : categorySelectValue;
    const productPrice = document.getElementById('productPrice').value.trim();
    const productId = document.getElementById('productId').value;

    if (!productName || !productCategory) {
        showNotification('Please fill in all fields correctly', 'error');
        return;
    }
    if (productPrice && (isNaN(productPrice) || parseFloat(productPrice) < 0)) {
        showNotification('Price must be a non-negative number', 'error');
        return;
    }

    const body = {
        product_name: productName,
        product_alias: productAlias,
        category: productCategory,
        // Blank stays unset server-side (falls back to the average sale
        // price) rather than being sent as 0, which would look like a
        // deliberate "free" price.
        price: productPrice ? parseFloat(productPrice) : null,
    };

    try {
        let response;
        if (currentEditingProductId) {
            response = await fetch(`/api/products/${currentEditingProductId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } else {
            response = await fetch('/api/products', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        }

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            showNotification(payload.error || 'Unable to save product.', 'error');
            return;
        }

        showNotification(
            currentEditingProductId
                ? 'Product updated successfully'
                : 'Product added successfully. Market insights are updating in the background...'
        );
        closeProductModal();
        await loadAllCategoriesForFilter();
        await loadProductsFromServer();
        renderProductTable();
    } catch (error) {
        showNotification('Unable to reach the server. Please try again.', 'error');
    }
}

function closeProductModal() {
    closeModal('productModal');
    currentEditingProductId = null;
    hideNewCategoryInput();
}

let deleteProductId = null;

function openDeleteConfirm(productId) {
    deleteProductId = productId;
    openModal('deleteConfirmModal');
}

function closeDeleteConfirm() {
    closeModal('deleteConfirmModal');
    deleteProductId = null;
}

async function confirmDelete() {
    if (!deleteProductId) return;

    try {
        const response = await fetch(`/api/products/${deleteProductId}`, { method: 'DELETE' });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            showNotification(payload.error || 'Unable to delete product.', 'error');
            closeDeleteConfirm();
            return;
        }

        showNotification('Product deleted successfully. Market insights are updating in the background...');
        closeDeleteConfirm();
        await loadAllCategoriesForFilter();
        await loadProductsFromServer();
        renderProductTable();
    } catch (error) {
        showNotification('Unable to reach the server. Please try again.', 'error');
        closeDeleteConfirm();
    }
}
