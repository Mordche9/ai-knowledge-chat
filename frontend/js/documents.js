document.addEventListener("DOMContentLoaded", () => {
    // =====================================
    // ELEMENTS
    // =====================================

    const documentGrid = document.getElementById("documentGrid");
    const breadcrumbs = document.getElementById("breadcrumbs");

    const newFolderButton = document.getElementById("newFolderButton");
    const copyButton = document.getElementById("copyButton");
    const pasteButton = document.getElementById("pasteButton");
    const moveButton = document.getElementById("moveButton");
    const deleteButton = document.getElementById("deleteButton");

    const documentSearch = document.getElementById("documentSearch");

    const fileUpload = document.getElementById("fileUpload");
    const uploadButton = document.getElementById("uploadButton");
    const pageUploadButton = document.getElementById("pageUploadButton");

    const connectionDot = document.getElementById("connectionDot");
    const connectionText = document.getElementById("connectionText");

    const sidebarToggle = document.getElementById("sidebarToggle");
    const sidebar = document.getElementById("sidebar");

    const recentUploads = document.getElementById("recentUploads");

    const previewPanel = document.getElementById("previewPanel");
    const previewTitle = document.getElementById("previewTitle");
    const previewSubtitle = document.getElementById("previewSubtitle");
    const previewContent = document.getElementById("previewContent");
    const closePreviewButton = document.getElementById("closePreviewButton");

    // =====================================
    // CONFIGURATION
    // =====================================

    const MAX_FILE_SIZE = 25 * 1024 * 1024;
    const REQUEST_TIMEOUT = 60000;

    const ALLOWED_EXTENSIONS = [
        ".pdf",
        ".docx",
        ".txt"
    ];

    // =====================================
    // STATE
    // =====================================

    let currentPath = "";
    let currentItems = [];

    let selectedItem = null;
    let selectedPaths = new Set();

    let clipboardPaths = [];

    let isUploading = false;

    let previewRequestNumber = 0;
    let folderRequestNumber = 0;

    let draggedPaths = [];

    const recentUploadNames = [];
    const embeddingInProgress = new Set();

    // =====================================
    // API REQUEST
    // =====================================

    async function apiRequest(url, options = {}) {
        const controller = new AbortController();

        const timeout = setTimeout(
            () => controller.abort(),
            REQUEST_TIMEOUT
        );

        const headers = {
            ...(options.headers || {})
        };

        if (
            options.body &&
            !(options.body instanceof FormData) &&
            !headers["Content-Type"]
        ) {
            headers["Content-Type"] = "application/json";
        }

        try {
            const response = await fetch(url, {
                ...options,
                headers,
                signal: controller.signal
            });

            const responseText = await response.text();

            let data = {};

            if (responseText) {
                try {
                    data = JSON.parse(responseText);
                } catch {
                    data = {
                        message: responseText
                    };
                }
            }

            if (!response.ok) {
                let message =
                    data.detail ||
                    data.message ||
                    `Request failed (${response.status}).`;

                if (typeof message !== "string") {
                    message = JSON.stringify(message);
                }

                throw new Error(message);
            }

            return data;

        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error(
                    "The request timed out. Please try again."
                );
            }

            throw error;

        } finally {
            clearTimeout(timeout);
        }
    }

    // =====================================
    // CONNECTION
    // =====================================

    async function checkConnection() {
        try {
            const response = await fetch("/health", {
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) {
                throw new Error("Backend unavailable.");
            }

            if (connectionDot) {
                connectionDot.classList.add("connected");
            }

            if (connectionText) {
                connectionText.textContent = "Connected";
            }

        } catch {
            if (connectionDot) {
                connectionDot.classList.remove("connected");
            }

            if (connectionText) {
                connectionText.textContent = "Disconnected";
            }
        }
    }

    // =====================================
    // LOAD FOLDER
    // =====================================

    async function loadFolder(path = currentPath, preserveState = false) {
        const requestNumber = ++folderRequestNumber;

        try {
            const query = new URLSearchParams({
                path
            });

            const data = await apiRequest(
                `/api/documents?${query.toString()}`
            );

            // Ignore an older request if the user navigated elsewhere.
            if (requestNumber !== folderRequestNumber) {
                return;
            }

            if (!Array.isArray(data.items)) {
                throw new Error(
                    "The server returned an invalid folder response."
                );
            }

            const pathChanged = currentPath !== data.current_path;

            currentPath = data.current_path;
            currentItems = data.items;

            if (!preserveState || pathChanged) {
                selectedItem = null;
                selectedPaths.clear();
                closePreview();
            }

            const availablePaths = new Set(
                currentItems.map(item => item.path)
            );

            selectedPaths = new Set(
                [...selectedPaths].filter(itemPath =>
                    availablePaths.has(itemPath)
                )
            );

            renderBreadcrumbs();
            renderItems();
            updateActionButtons();

        } catch (error) {
            if (requestNumber !== folderRequestNumber) {
                return;
            }

            alert(error.message);

            if (path !== "") {
                await loadFolder("", false);
            }
        }
    }

    // =====================================
    // BREADCRUMBS
    // =====================================

    function renderBreadcrumbs() {
        if (!breadcrumbs) return;

        breadcrumbs.replaceChildren();

        const rootButton = document.createElement("button");

        rootButton.type = "button";
        rootButton.className = "breadcrumb-button";
        rootButton.textContent = "My Documents";

        rootButton.addEventListener("click", () => {
            loadFolder("");
        });

        breadcrumbs.appendChild(rootButton);

        if (!currentPath) return;

        const parts = currentPath.split("/");
        let accumulatedPath = "";

        parts.forEach(part => {
            const separator = document.createElement("span");

            separator.textContent = "›";
            breadcrumbs.appendChild(separator);

            accumulatedPath = accumulatedPath
                ? `${accumulatedPath}/${part}`
                : part;

            const button = document.createElement("button");

            button.type = "button";
            button.className = "breadcrumb-button";
            button.textContent = part;

            const targetPath = accumulatedPath;

            button.addEventListener("click", () => {
                loadFolder(targetPath);
            });

            breadcrumbs.appendChild(button);
        });
    }

    // =====================================
    // FILE SIZE AND ICONS
    // =====================================

    function formatFileSize(bytes) {
        if (bytes < 1024) {
            return `${bytes} B`;
        }

        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }

        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function getFileIcon(item) {
        if (item.type === "folder") {
            return "📁";
        }

        if (item.extension === ".pdf") {
            return "📕";
        }

        if (item.extension === ".docx") {
            return "📘";
        }

        return "📄";
    }

    // =====================================
    // EMBEDDING STATUS
    // =====================================

    function getEmbeddingStatus(item) {
        if (item.type === "folder") {
            return null;
        }

        if (embeddingInProgress.has(item.path)) {
            return {
                label: "Embedding...",
                className: "status-processing"
            };
        }

        const status = item.embedding_status || "not_embedded";

        if (status === "embedded") {
            return {
                label: `Embedded (${item.chunk_count || 0})`,
                className: "status-embedded"
            };
        }

        if (status === "failed") {
            return {
                label: "Failed",
                className: "status-failed"
            };
        }

        return {
            label: "Not embedded",
            className: "status-not-embedded"
        };
    }

    // =====================================
    // RENDER EMPTY FOLDER
    // =====================================

    function renderEmptyFolder(searchTerm) {
        const empty = document.createElement("div");

        empty.className = "file-empty";

        const icon = document.createElement("div");
        icon.textContent = "📁";

        const heading = document.createElement("strong");

        heading.textContent = searchTerm
            ? "No matching items"
            : "This folder is empty";

        const description = document.createElement("p");

        description.textContent = searchTerm
            ? "Try another search."
            : "Create a folder or upload a document to get started.";

        empty.append(icon, heading, description);

        documentGrid.appendChild(empty);
    }

    // =====================================
    // RENDER ITEMS
    // =====================================

    function renderItems() {
        if (!documentGrid) return;

        documentGrid.replaceChildren();

        const searchTerm = documentSearch
            ? documentSearch.value.trim().toLowerCase()
            : "";

        const filteredItems = currentItems.filter(item =>
            item.name.toLowerCase().includes(searchTerm)
        );

        if (filteredItems.length === 0) {
            renderEmptyFolder(searchTerm);
            return;
        }

        filteredItems.forEach(item => {
            const row = document.createElement("div");

            row.className = "file-row";
            row.dataset.path = item.path;

            if (selectedItem?.path === item.path) {
                row.classList.add("selected");
            }

            if (selectedPaths.has(item.path)) {
                row.classList.add("multi-selected");
            }

            // =====================================
            // DRAG AND DROP
            // =====================================

            row.draggable = true;

            row.addEventListener("dragstart", event => {
                if (selectedPaths.has(item.path)) {
                    draggedPaths = [...selectedPaths];
                } else {
                    draggedPaths = [item.path];
                }

                event.dataTransfer.effectAllowed = "move";

                event.dataTransfer.setData(
                    "text/plain",
                    JSON.stringify(draggedPaths)
                );
            });

            row.addEventListener("dragover", event => {
                if (item.type !== "folder") {
                    return;
                }

                event.preventDefault();

                event.dataTransfer.dropEffect = "move";

                row.classList.add("drag-over");
            });

            row.addEventListener("dragleave", () => {
                row.classList.remove("drag-over");
            });

            row.addEventListener("drop", async event => {
                if (item.type !== "folder") {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();

                row.classList.remove("drag-over");

                let paths = draggedPaths;

                try {
                    const transferred = event.dataTransfer.getData(
                        "text/plain"
                    );

                    if (transferred) {
                        const parsed = JSON.parse(transferred);

                        if (Array.isArray(parsed)) {
                            paths = parsed;
                        }
                    }
                } catch {
                    // Keep the paths collected during dragstart.
                }

                if (!paths.length) return;

                const destinationPath = item.path;

                const invalidDrop = paths.some(sourcePath =>
                    sourcePath === destinationPath ||
                    destinationPath.startsWith(`${sourcePath}/`)
                );

                if (invalidDrop) {
                    alert(
                        "You cannot move a folder into itself or one of its subfolders."
                    );
                    return;
                }

                await moveItems(paths, destinationPath);
            });

            // =====================================
            // CHECKBOX
            // =====================================

            const checkbox = document.createElement("input");

            checkbox.type = "checkbox";
            checkbox.className = "file-checkbox";
            checkbox.checked = selectedPaths.has(item.path);

            checkbox.setAttribute(
                "aria-label",
                `Select ${item.name}`
            );

            checkbox.addEventListener("click", event => {
                event.stopPropagation();
            });

            checkbox.addEventListener("change", () => {
                if (checkbox.checked) {
                    selectedPaths.add(item.path);
                } else {
                    selectedPaths.delete(item.path);
                }

                renderItems();
                updateActionButtons();
            });

            // =====================================
            // NAME
            // =====================================

            const name = document.createElement("div");

            name.className = "file-name";

            const icon = document.createElement("span");

            icon.className = "file-icon";
            icon.textContent = getFileIcon(item);

            const nameText = document.createElement("span");

            nameText.className = "file-name-text";
            nameText.textContent = item.name;

            name.append(icon, nameText);

            // =====================================
            // MODIFIED DATE
            // =====================================

            const date = document.createElement("div");

            date.className = "file-date";

            date.textContent = item.modified
                ? new Date(item.modified).toLocaleString()
                : "—";

            // =====================================
            // TYPE AND SIZE
            // =====================================

            const type = document.createElement("div");

            type.className = "file-type";

            if (item.type === "folder") {
                type.textContent = "File folder";
            } else {
                const extension = (item.extension || "")
                    .toUpperCase()
                    .replace(".", "");

                type.textContent =
                    `${extension} · ${formatFileSize(item.size || 0)}`;
            }

            // =====================================
            // EMBEDDING STATUS
            // =====================================

            const statusContainer = document.createElement("div");

            statusContainer.className = "file-status";

            const status = getEmbeddingStatus(item);

            if (status) {
                const statusLabel = document.createElement("span");

                statusLabel.className =
                    `embedding-status ${status.className}`;

                statusLabel.textContent = status.label;

                statusContainer.appendChild(statusLabel);
            } else {
                statusContainer.textContent = "—";
            }

            // =====================================
            // ROW ACTIONS
            // =====================================

            const actions = document.createElement("div");

            actions.className = "file-row-actions";

            if (item.type === "file") {
                const statusValue =
                    item.embedding_status || "not_embedded";

                if (embeddingInProgress.has(item.path)) {
                    const processingLabel =
                        document.createElement("span");

                    processingLabel.className = "row-action-label";
                    processingLabel.textContent = "Please wait...";

                    actions.appendChild(processingLabel);

                } else {
                    const embedButton =
                        document.createElement("button");

                    embedButton.type = "button";
                    embedButton.className = "row-action-button";

                    if (statusValue === "embedded") {
                        embedButton.textContent = "Re-embed";
                    } else if (statusValue === "failed") {
                        embedButton.textContent = "Retry";
                    } else {
                        embedButton.textContent = "Embed";
                    }

                    embedButton.addEventListener("click", event => {
                        event.stopPropagation();

                        embedDocument(
                            item,
                            statusValue === "failed"
                        );
                    });

                    actions.appendChild(embedButton);
                }
            }

            row.append(
                checkbox,
                name,
                date,
                type,
                statusContainer,
                actions
            );

            // =====================================
            // SINGLE CLICK
            // =====================================

            row.addEventListener("click", event => {
                if (
                    event.target.closest("button") ||
                    event.target.closest("input")
                ) {
                    return;
                }

                if (event.ctrlKey || event.metaKey) {
                    if (selectedPaths.has(item.path)) {
                        selectedPaths.delete(item.path);
                    } else {
                        selectedPaths.add(item.path);
                    }
                } else {
                    selectedPaths.clear();
                    selectedPaths.add(item.path);
                }

                selectedItem = item;

                renderItems();
                updateActionButtons();

                if (item.type === "file") {
                    loadPreview(item);
                } else {
                    closePreview();
                }
            });

            // =====================================
            // DOUBLE CLICK
            // =====================================

            row.addEventListener("dblclick", event => {
                if (
                    event.target.closest("button") ||
                    event.target.closest("input")
                ) {
                    return;
                }

                if (item.type === "folder") {
                    loadFolder(item.path);
                }
            });

            documentGrid.appendChild(row);
        });
    }

    // =====================================
    // EMBED DOCUMENT
    // =====================================

    async function embedDocument(item, retry = false) {
        if (embeddingInProgress.has(item.path)) {
            return;
        }

        embeddingInProgress.add(item.path);

        renderItems();

        try {
            await apiRequest(
                retry
                    ? "/api/documents/retry"
                    : "/api/documents/embed",
                {
                    method: "POST",
                    body: JSON.stringify({
                        path: item.path
                    })
                }
            );

            alert(
                `"${item.name}" was successfully embedded.`
            );

        } catch (error) {
            alert(
                `Could not embed "${item.name}":\n${error.message}`
            );

        } finally {
            embeddingInProgress.delete(item.path);

            await loadFolder(currentPath, true);
        }
    }

    // =====================================
    // PREVIEW
    // =====================================

    async function loadPreview(item) {
        if (!previewPanel) return;

        const requestNumber = ++previewRequestNumber;

        previewPanel.classList.add("open");

        if (previewTitle) {
            previewTitle.textContent = item.name;
        }

        if (previewSubtitle) {
            previewSubtitle.textContent = "Loading document...";
        }

        if (previewContent) {
            previewContent.replaceChildren();

            const loading = document.createElement("div");

            loading.className = "preview-loading";
            loading.textContent = "Extracting document text...";

            previewContent.appendChild(loading);
        }

        try {
            const query = new URLSearchParams({
                path: item.path
            });

            const data = await apiRequest(
                `/api/documents/preview?${query.toString()}`
            );

            if (requestNumber !== previewRequestNumber) {
                return;
            }

            if (previewTitle) {
                previewTitle.textContent = data.name || item.name;
            }

            if (previewSubtitle) {
                const extension = (data.extension || "")
                    .toUpperCase()
                    .replace(".", "");

                const characterCount = Number(
                    data.character_count || 0
                );

                previewSubtitle.textContent =
                    `${extension} · ${characterCount.toLocaleString()} characters`;
            }

            if (previewContent) {
                previewContent.replaceChildren();

                const text = document.createElement("pre");

                text.className = "preview-text";
                text.textContent = data.text || "";

                previewContent.appendChild(text);

                if (data.truncated) {
                    const notice = document.createElement("p");

                    notice.className = "preview-loading";

                    notice.textContent =
                        "Preview shortened. The complete document remains stored.";

                    previewContent.appendChild(notice);
                }
            }

        } catch (error) {
            if (requestNumber !== previewRequestNumber) {
                return;
            }

            if (previewSubtitle) {
                previewSubtitle.textContent = "Preview unavailable";
            }

            if (previewContent) {
                previewContent.replaceChildren();

                const errorMessage = document.createElement("p");

                errorMessage.className = "preview-error";
                errorMessage.textContent = error.message;

                previewContent.appendChild(errorMessage);
            }
        }
    }

    // =====================================
    // DISPLAY SOURCE BLOCKS
    // =====================================

    function renderSourceBlocks(data, source) {
        if (!previewContent) return;

        previewContent.replaceChildren();

        const blocks =
            data.content_blocks ||
            data.blocks ||
            [];

        if (!Array.isArray(blocks) || blocks.length === 0) {
            const fallbackText =
                data.text ||
                data.content ||
                data.excerpt ||
                "";

            if (fallbackText) {
                const text = document.createElement("pre");

                text.className = "preview-text";
                text.textContent = fallbackText;

                previewContent.appendChild(text);
            } else {
                const message = document.createElement("p");

                message.className = "preview-loading";

                message.textContent =
                    "The source was found, but no preview blocks were returned.";

                previewContent.appendChild(message);
            }

            return;
        }

        let highlighted = false;

        // The backend can provide the exact block index.
        const targetBlockIndex =
            data.target_block_index ??
            data.source?.target_block_index ??
            null;

        blocks.forEach((block, index) => {
            const blockElement = document.createElement("div");

            blockElement.className = "source-preview-block";

            const blockText = typeof block === "string"
                ? block
                : (
                    block.text ||
                    block.content ||
                    block.excerpt ||
                    block.text_content ||
                    ""
                );

            const blockPage =
                block.page_number ?? block.page ?? null;

            const blockSection =
                block.section_title ?? block.section ?? null;

            const blockChunk =
                block.chunk_index ?? null;

            const blockLineStart =
                block.line_start ?? null;

            const matchesTargetIndex =
                targetBlockIndex !== null &&
                String(index) === String(targetBlockIndex);

            const matchesChunk =
                source.chunkIndex !== null &&
                source.chunkIndex !== "" &&
                blockChunk !== null &&
                String(blockChunk) === String(source.chunkIndex);

            const matchesPage =
                source.page !== null &&
                source.page !== "" &&
                blockPage !== null &&
                String(blockPage) === String(source.page);

            const matchesSection =
                source.section !== null &&
                source.section !== "" &&
                blockSection !== null &&
                String(blockSection) === String(source.section);

            const matchesLine =
                source.lineStart !== null &&
                source.lineStart !== "" &&
                blockLineStart !== null &&
                String(blockLineStart) === String(source.lineStart);

            const isMatch =
                !highlighted &&
                (
                    matchesTargetIndex ||
                    matchesChunk ||
                    matchesLine ||
                    (
                        !source.chunkIndex &&
                        !source.lineStart &&
                        (matchesPage || matchesSection)
                    )
                );

            if (isMatch) {
                blockElement.classList.add("source-highlight");
                highlighted = true;
            }

            if (typeof block === "object" && block !== null) {
                const metadata = [];

                if (blockPage !== null) {
                    metadata.push(`Page ${blockPage}`);
                }

                if (blockSection) {
                    metadata.push(blockSection);
                }

                if (metadata.length > 0) {
                    const label = document.createElement("div");

                    label.className = "source-preview-label";
                    label.textContent = metadata.join(" · ");

                    blockElement.appendChild(label);
                }
            }

            const textElement = document.createElement("pre");

            textElement.className = "preview-text";
            textElement.textContent = blockText;

            blockElement.appendChild(textElement);

            previewContent.appendChild(blockElement);
        });

        if (!highlighted) {
            const notice = document.createElement("p");

            notice.className = "preview-loading";

            notice.textContent =
                "The source document is open. The exact passage could not be highlighted.";

            previewContent.prepend(notice);

        } else {
            const highlightedBlock =
                previewContent.querySelector(".source-highlight");

            highlightedBlock?.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });
        }
    }

    // =====================================
    // OPEN CITED DOCUMENT SOURCE
    // =====================================

    async function openSourceFromUrl() {
        const params = new URLSearchParams(
            window.location.search
        );

        const sourcePath = params.get("sourcePath");

        if (!sourcePath) {
            return;
        }

        const source = {
            path: sourcePath,
            documentName: params.get("documentName"),
            page: params.get("page"),
            section: params.get("section"),
            chunkIndex: params.get("chunkIndex"),
            lineStart: params.get("lineStart"),
            lineEnd: params.get("lineEnd")
        };

        // Navigate to the folder containing the document.

        const lastSlash = sourcePath.lastIndexOf("/");

        const parentPath = lastSlash >= 0
            ? sourcePath.substring(0, lastSlash)
            : "";

        await loadFolder(parentPath, false);

        const item = currentItems.find(
            currentItem =>
                currentItem.path === source.path
        );

        if (item) {
            selectedItem = item;

            selectedPaths.clear();
            selectedPaths.add(item.path);

            renderItems();
            updateActionButtons();
        }

        if (!previewPanel) {
            return;
        }

        const requestNumber = ++previewRequestNumber;

        previewPanel.classList.add("open");

        if (previewTitle) {
            previewTitle.textContent =
                source.documentName ||
                item?.name ||
                "Document source";
        }

        if (previewSubtitle) {
            previewSubtitle.textContent = "Loading cited passage...";
        }

        if (previewContent) {
            previewContent.replaceChildren();

            const loading = document.createElement("div");

            loading.className = "preview-loading";
            loading.textContent = "Finding the cited passage...";

            previewContent.appendChild(loading);
        }

        try {
            const query = new URLSearchParams();

            query.set("path", source.path);

            if (source.page !== null) {
                query.set("page", source.page);
            }

            if (source.section !== null) {
                query.set("section", source.section);
            }

            if (source.chunkIndex !== null) {
                query.set("chunk_index", source.chunkIndex);
            }

            if (source.lineStart !== null) {
                query.set("line_start", source.lineStart);
            }

            if (source.lineEnd !== null) {
                query.set("line_end", source.lineEnd);
            }

            const data = await apiRequest(
                `/api/documents/source?${query.toString()}`
            );

            if (requestNumber !== previewRequestNumber) {
                return;
            }

            if (previewTitle) {
                previewTitle.textContent =
                    data.document_name ||
                    source.documentName ||
                    item?.name ||
                    "Document source";
            }

            const details = [];

            if (source.page) {
                details.push(`Page ${source.page}`);
            }

            if (source.section) {
                details.push(source.section);
            }

            if (source.lineStart) {
                details.push(
                    `Lines ${source.lineStart}-${source.lineEnd || source.lineStart}`
                );
            }

            if (previewSubtitle) {
                previewSubtitle.textContent =
                    details.length > 0
                        ? `Cited source · ${details.join(" · ")}`
                        : "Cited document source";
            }

            renderSourceBlocks(data, source);

        } catch (error) {
            if (requestNumber !== previewRequestNumber) {
                return;
            }

            if (previewSubtitle) {
                previewSubtitle.textContent =
                    "Could not load cited passage";
            }

            if (previewContent) {
                previewContent.replaceChildren();

                const errorMessage = document.createElement("p");

                errorMessage.className = "preview-error";

                errorMessage.textContent =
                    `Could not open the cited passage: ${error.message}`;

                previewContent.appendChild(errorMessage);
            }

            console.error("Source preview failed:", error);
        }
    }

    // =====================================
    // CLOSE PREVIEW
    // =====================================

    function closePreview() {
        previewRequestNumber++;

        if (previewPanel) {
            previewPanel.classList.remove("open");
        }

        if (previewTitle) {
            previewTitle.textContent = "Document preview";
        }

        if (previewSubtitle) {
            previewSubtitle.textContent =
                "Select a document to preview it";
        }

        if (previewContent) {
            previewContent.replaceChildren();

            const placeholder = document.createElement("div");

            placeholder.className = "preview-placeholder";

            const icon = document.createElement("div");
            icon.textContent = "📄";

            const message = document.createElement("p");

            message.textContent =
                "Select a document to see its contents.";

            placeholder.append(icon, message);

            previewContent.appendChild(placeholder);
        }
    }

    if (closePreviewButton) {
        closePreviewButton.addEventListener("click", () => {
            selectedItem = null;

            closePreview();
            renderItems();
            updateActionButtons();
        });
    }

    // =====================================
    // ACTION BUTTON STATES
    // =====================================

    function updateActionButtons() {
        const hasSelection = selectedPaths.size > 0;

        if (copyButton) {
            copyButton.disabled = !hasSelection;
        }

        if (moveButton) {
            moveButton.disabled = !hasSelection;
        }

        if (deleteButton) {
            deleteButton.disabled = !hasSelection;
        }

        if (pasteButton) {
            pasteButton.disabled = clipboardPaths.length === 0;
        }
    }

    // =====================================
    // CREATE FOLDER
    // =====================================

    async function createFolder() {
        const name = prompt("Enter the new folder name:");

        if (name === null) return;

        if (!name.trim()) {
            alert("Please enter a folder name.");
            return;
        }

        try {
            await apiRequest("/api/documents/folders", {
                method: "POST",
                body: JSON.stringify({
                    name: name.trim(),
                    parent_path: currentPath
                })
            });

            await loadFolder(currentPath, true);

        } catch (error) {
            alert(error.message);
        }
    }

    // =====================================
    // COPY
    // =====================================

    function copySelectedItems() {
        if (selectedPaths.size === 0) {
            return;
        }

        clipboardPaths = [...selectedPaths];

        updateActionButtons();

        alert(
            `${clipboardPaths.length} item(s) copied. ` +
            "Open the destination folder and click Paste."
        );
    }

    // =====================================
    // PASTE
    // =====================================

    async function pasteItems() {
        if (clipboardPaths.length === 0) {
            return;
        }

        try {
            const result = await apiRequest(
                "/api/documents/copy",
                {
                    method: "POST",
                    body: JSON.stringify({
                        paths: clipboardPaths,
                        destination_path: currentPath
                    })
                }
            );

            await loadFolder(currentPath, true);

            alert(
                result.message || "Items copied successfully."
            );

        } catch (error) {
            alert(error.message);
        }
    }

    // =====================================
    // MOVE
    // =====================================

    async function moveItems(paths, destinationPath) {
        if (!Array.isArray(paths) || paths.length === 0) {
            return;
        }

        try {
            const result = await apiRequest(
                "/api/documents/move",
                {
                    method: "POST",
                    body: JSON.stringify({
                        paths,
                        destination_path: destinationPath
                    })
                }
            );

            selectedPaths.clear();
            selectedItem = null;

            closePreview();

            await loadFolder(currentPath, false);

            alert(
                result.message || "Items moved successfully."
            );

        } catch (error) {
            alert(error.message);
        }
    }

    async function moveSelectedItems() {
        const paths = [...selectedPaths];

        if (paths.length === 0) {
            return;
        }

        const destination = prompt(
            "Enter the destination folder path.\n\n" +
            "Leave empty for My Documents.",
            currentPath
        );

        if (destination === null) {
            return;
        }

        await moveItems(
            paths,
            destination.trim()
        );
    }

    // =====================================
    // DELETE SELECTED ITEMS
    // =====================================

    async function deleteSelectedItems() {
        const paths = [...selectedPaths];

        if (paths.length === 0) {
            return;
        }

        const confirmed = confirm(
            `Are you sure you want to delete ${paths.length} selected item(s)?\n\n` +
            "Files and their embedded data will also be deleted."
        );

        if (!confirmed) {
            return;
        }

        try {
            const result = await apiRequest(
                "/api/documents/items",
                {
                    method: "DELETE",
                    body: JSON.stringify({
                        paths
                    })
                }
            );

            selectedPaths.clear();
            selectedItem = null;

            closePreview();

            await loadFolder(currentPath, false);

            alert(
                result.message || "Selected items deleted."
            );

        } catch (error) {
            alert(error.message);
        }
    }

    // =====================================
    // RECENT UPLOADS
    // =====================================

    function renderRecentUploads() {
        if (!recentUploads) {
            return;
        }

        recentUploads.replaceChildren();

        recentUploadNames.slice(0, 5).forEach(name => {
            const item = document.createElement("div");

            item.className = "sidebar-item";
            item.textContent = name;

            recentUploads.appendChild(item);
        });
    }

    // =====================================
    // OPEN FILE PICKER
    // =====================================

    function openFilePicker() {
        if (!isUploading && fileUpload) {
            fileUpload.click();
        }
    }

    // =====================================
    // UPLOAD DOCUMENTS
    // =====================================

    async function uploadDocuments() {
        if (!fileUpload || isUploading) {
            return;
        }

        const files = Array.from(fileUpload.files || []);

        if (files.length === 0) {
            return;
        }

        isUploading = true;

        if (uploadButton) {
            uploadButton.disabled = true;
        }

        if (pageUploadButton) {
            pageUploadButton.disabled = true;
        }

        let successful = 0;

        const failures = [];

        const destinationPath = currentPath;

        try {
            for (const file of files) {
                const lastDot = file.name.lastIndexOf(".");

                const extension = lastDot >= 0
                    ? file.name.slice(lastDot).toLowerCase()
                    : "";

                if (!ALLOWED_EXTENSIONS.includes(extension)) {
                    failures.push(
                        `${file.name}: Unsupported file type.`
                    );

                    continue;
                }

                if (file.size > MAX_FILE_SIZE) {
                    failures.push(
                        `${file.name}: Maximum size is 25 MB.`
                    );

                    continue;
                }

                const formData = new FormData();

                formData.append("file", file);
                formData.append("path", destinationPath);

                try {
                    const data = await apiRequest(
                        "/api/documents/upload",
                        {
                            method: "POST",
                            body: formData
                        }
                    );

                    successful++;

                    recentUploadNames.unshift(
                        data.name || file.name
                    );

                    renderRecentUploads();

                } catch (error) {
                    failures.push(
                        `${file.name}: ${error.message}`
                    );
                }
            }

        } finally {
            isUploading = false;

            if (uploadButton) {
                uploadButton.disabled = false;
            }

            if (pageUploadButton) {
                pageUploadButton.disabled = false;
            }

            fileUpload.value = "";
        }

        await loadFolder(destinationPath, true);

        let message =
            `${successful} of ${files.length} file(s) uploaded successfully.\n\n` +
            "New files are marked Not embedded. Select Embed next to a file " +
            "when you want to add it to the AI knowledge base.";

        if (failures.length > 0) {
            message += "\n\nProblems:\n" + failures.join("\n");
        }

        alert(message);
    }

    // =====================================
    // SEARCH
    // =====================================

    if (documentSearch) {
        documentSearch.addEventListener("input", renderItems);
    }

    // =====================================
    // EVENTS
    // =====================================

    if (newFolderButton) {
        newFolderButton.addEventListener("click", createFolder);
    }

    if (copyButton) {
        copyButton.addEventListener("click", copySelectedItems);
    }

    if (pasteButton) {
        pasteButton.addEventListener("click", pasteItems);
    }

    if (moveButton) {
        moveButton.addEventListener("click", moveSelectedItems);
    }

    if (deleteButton) {
        deleteButton.addEventListener("click", deleteSelectedItems);
    }

    if (uploadButton) {
        uploadButton.addEventListener("click", openFilePicker);
    }

    if (pageUploadButton) {
        pageUploadButton.addEventListener("click", openFilePicker);
    }

    if (fileUpload) {
        fileUpload.addEventListener("change", uploadDocuments);
    }

    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener("click", () => {
            sidebar.classList.toggle("collapsed");
        });
    }

    // =====================================
    // INITIALIZE
    // =====================================

    updateActionButtons();

    checkConnection();

    const urlParams = new URLSearchParams(
        window.location.search
    );

    if (urlParams.has("sourcePath")) {
        openSourceFromUrl();
    } else {
        loadFolder("");
    }
});