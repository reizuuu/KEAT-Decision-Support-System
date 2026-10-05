// Upload page

let selectedFile = null;

document.addEventListener('DOMContentLoaded', function() {
    initializeUploadPage();
});

function initializeUploadPage() {
    initializeDragDrop();
    initializeBrowseButton();
    initializeUploadButton();
}

// --- drag and drop ---

function initializeDragDrop() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    if (!dropZone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, highlight, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, unhighlight, false);
    });

    function highlight(e) {
        dropZone.style.backgroundColor = '#F0EAE0';
        dropZone.style.borderColor = '#8B7355';
    }

    function unhighlight(e) {
        dropZone.style.backgroundColor = '';
        dropZone.style.borderColor = '';
    }

    dropZone.addEventListener('drop', handleDrop, false);

    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;

        handleFiles(files);
    }
}

function handleFiles(files) {
    const fileList = Array.from(files);

    if (fileList.length === 0) return;

    const file = fileList[0];

    if (!isValidFileType(file)) {
        showNotification('Invalid file type. Please upload CSV or XLSX file.', 'error');
        return;
    }

    const maxSize = 50 * 1024 * 1024; // 50 MB
    if (file.size > maxSize) {
        showNotification('File size exceeds 50 MB limit.', 'error');
        return;
    }

    selectedFile = file;
    updateFileSelected();
}

function isValidFileType(file) {
    const validTypes = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    const validExtensions = ['.csv', '.xlsx'];

    if (validTypes.includes(file.type)) {
        return true;
    }

    const fileName = file.name.toLowerCase();
    return validExtensions.some(ext => fileName.endsWith(ext));
}

function updateFileSelected() {
    const fileSelected = document.getElementById('fileSelected');
    if (fileSelected && selectedFile) {
        const sizeMB = (selectedFile.size / (1024 * 1024)).toFixed(2);
        fileSelected.textContent = `Selected: ${selectedFile.name} (${sizeMB} MB)`;
        fileSelected.style.color = '#2e7d32';
    }
}


function initializeBrowseButton() {
    const browseBtn = document.getElementById('browseBtn');
    const fileInput = document.getElementById('fileInput');

    if (browseBtn && fileInput) {
        browseBtn.addEventListener('click', function() {
            fileInput.click();
        });

        fileInput.addEventListener('change', function() {
            if (this.files.length > 0) {
                handleFiles(this.files);
            }
        });
    }
}

// --- upload ---

function initializeUploadButton() {
    const uploadBtn = document.getElementById('uploadBtn');

    if (uploadBtn) {
        uploadBtn.addEventListener('click', function() {
            performUpload();
        });
    }
}

function performUpload() {
    if (!selectedFile) {
        showNotification('Please select a file to upload', 'error');
        return;
    }

    openModal('uploadProgressModal');

    uploadFile();
}

async function uploadFile() {
    const progressBar = document.getElementById('progressBar');
    const uploadProgress = document.getElementById('uploadProgress');

    if (progressBar) progressBar.style.width = '50%';
    if (uploadProgress) uploadProgress.textContent = 'Processing...';

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const payload = await response.json();

        if (!response.ok) {
            throw new Error(payload.error || 'The file could not be processed.');
        }

        sessionStorage.setItem('keatResults', JSON.stringify(payload));
        if (progressBar) progressBar.style.width = '100%';
        if (uploadProgress) uploadProgress.textContent = '100%';
        closeModal('uploadProgressModal');
        showUploadSuccess(payload);
    } catch (error) {
        closeModal('uploadProgressModal');
        showNotification(error.message, 'error');
    }
}

function showUploadSuccess(payload) {
    const successMessage = document.getElementById('uploadSuccessMessage');
    if (successMessage) {
        successMessage.innerHTML = buildUploadSuccessMessage(payload);
    }

    openModal('uploadSuccessModal');

    selectedFile = null;
    const fileSelected = document.getElementById('fileSelected');
    if (fileSelected) {
        fileSelected.textContent = '';
    }
}

function buildUploadSuccessMessage(payload) {
    const fileName = selectedFile ? selectedFile.name : '';
    const rowsProcessed = (payload && payload.rowsProcessed) || 0;
    const duplicateRowsDropped = (payload && payload.duplicateRowsDropped) || 0;
    const invalidRowsDropped = (payload && payload.invalidRowsDropped) || 0;
    const skippedUnmatchedRows = (payload && payload.skippedUnmatchedRows) || 0;
    const unmatchedProductNames = (payload && payload.unmatchedProductNames) || [];
    const skippedUnpricedRows = (payload && payload.skippedUnpricedRows) || 0;
    const unpricedProductNames = (payload && payload.unpricedProductNames) || [];

    let message = `File "<strong>${escapeHtml(fileName)}</strong>" was processed successfully. ${formatNumber(rowsProcessed)} row(s) were added to your data. Market insights are updating in the background...`;

    if (duplicateRowsDropped > 0) {
        message += `<p>${formatNumber(duplicateRowsDropped)} duplicate row(s) were already in the database and were not added again.</p>`;
    }
    if (invalidRowsDropped > 0) {
        message += `<p>${formatNumber(invalidRowsDropped)} invalid row(s) were skipped because they were missing or malformed data.</p>`;
    }
    if (skippedUnmatchedRows > 0) {
        const namesList = unmatchedProductNames.map(name => `<li>${escapeHtml(name)}</li>`).join('');
        message += `
            <p>${formatNumber(skippedUnmatchedRows)} row(s) were skipped because their product isn't in the catalog:</p>
            <ul>${namesList}</ul>
            <div class="form-note-warning">NOTE: Please add these to the Products page and reupload the missing data in order to keep the system accurate.</div>
        `;
    }
    if (skippedUnpricedRows > 0) {
        const namesList = unpricedProductNames.map(name => `<li>${escapeHtml(name)}</li>`).join('');
        message += `
            <p>${formatNumber(skippedUnpricedRows)} row(s) were skipped because no price could be determined for their product:</p>
            <ul>${namesList}</ul>
            <div class="form-note-warning">NOTE: Set a price for these on the Products page and reupload the missing data in order to keep the system accurate.</div>
        `;
    }

    return message;
}

function closeUploadSuccess() {
    closeModal('uploadSuccessModal');

    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('uploadProgress').textContent = '0%';

    showNotification('Upload processed successfully.');
}
