document.addEventListener("DOMContentLoaded", () => {

    // =====================================
    // ELEMENTS
    // =====================================

    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebarToggle");

    const newChatButton = document.getElementById("newChatButton");

    const messageInput = document.getElementById("messageInput");
    const sendButton = document.getElementById("sendButton");

    const modelSelector = document.getElementById("modelSelector");

    const chatArea = document.getElementById("chatArea");
    const messagesContainer = document.getElementById("messagesContainer");

    const welcomeScreen = document.getElementById("welcomeScreen");

    const connectionDot = document.getElementById("connectionDot");
    const connectionText = document.getElementById("connectionText");

    const uploadButton = document.getElementById("uploadButton");

    const sourceDocumentPanel =
        document.getElementById("sourceDocumentPanel");

    const sourceDocumentTitle =
        document.getElementById("sourceDocumentTitle");

    const sourceDocumentDetails =
        document.getElementById("sourceDocumentDetails");

    const sourceDocumentContent =
        document.getElementById("sourceDocumentContent");

    const closeSourceDocumentButton =
        document.getElementById("closeSourceDocumentButton");


    // =====================================
    // REQUIRED ELEMENT VALIDATION
    // =====================================

    const requiredElements = {
        messageInput,
        sendButton,
        modelSelector,
        chatArea,
        messagesContainer,
        welcomeScreen
    };

    const missingElements = Object.entries(requiredElements)
        .filter(([, element]) => !element)
        .map(([name]) => name);

    if (missingElements.length > 0) {

        console.error(
            "Chat initialization failed. Missing HTML elements:",
            missingElements
        );

        return;

    }


    // =====================================
    // APPLICATION STATE
    // =====================================

    let chatHistory = [];

    let defaultModel = "";

    let isSending = false;

    let sourceRequestNumber = 0;

    // Identifies the currently active conversation.
    let chatGeneration = 0;

    // Backend ChatRequest allows a maximum of 40 messages.
    const MAX_CHAT_MESSAGES = 40;


    // =====================================
    // SIDEBAR
    // =====================================

    sidebarToggle?.addEventListener("click", () => {

        sidebar?.classList.toggle("collapsed");

    });


    // =====================================
    // SCROLL CHAT
    // =====================================

    function scrollToBottom() {

        requestAnimationFrame(() => {

            if (!chatArea) return;

            chatArea.scrollTo({

                top: chatArea.scrollHeight,

                behavior: "smooth"

            });

        });

    }


    // =====================================
    // CONNECTION STATUS
    // =====================================

    async function checkConnection() {

        try {

            const connected = await API.checkConnection();

            if (connectionDot) {

                connectionDot.style.background =
                    connected ? "#22c55e" : "#ef4444";

            }

            if (connectionText) {

                connectionText.textContent =
                    connected ? "Connected" : "Disconnected";

            }

        } catch (error) {

            if (connectionDot) {
                connectionDot.style.background = "#ef4444";
            }

            if (connectionText) {
                connectionText.textContent = "Disconnected";
            }

            console.error(error);

        }

    }


    // =====================================
    // SEND BUTTON
    // =====================================

    function updateSendButton() {

        const hasMessage =
            messageInput.value.trim().length > 0;

        const hasModel =
            modelSelector.value.length > 0;

        sendButton.disabled =
            !hasMessage ||
            !hasModel ||
            isSending ||
            modelSelector.disabled;

    }


    // =====================================
    // LOAD MODELS
    // =====================================

    async function loadModels() {

        modelSelector.disabled = true;

        modelSelector.innerHTML = "";

        const loadingOption = document.createElement("option");

        loadingOption.value = "";

        loadingOption.textContent = "Loading models...";

        modelSelector.appendChild(loadingOption);

        updateSendButton();

        try {

            const data = await API.getModels();

            const models = Array.isArray(data.models)
                ? data.models
                : [];

            if (!models.length) {

                throw new Error("No available models.");

            }

            modelSelector.innerHTML = "";

            models.forEach(model => {

                if (
                    !model ||
                    typeof model.id !== "string" ||
                    !model.id.trim()
                ) {
                    return;
                }

                const option = document.createElement("option");

                option.value = model.id;

                option.textContent = model.name || model.id;

                modelSelector.appendChild(option);

            });

            if (!modelSelector.options.length) {

                throw new Error(
                    "No valid models were returned."
                );

            }

            const requestedDefault = data.default_model;

            const defaultExists = models.some(
                model =>
                    model &&
                    model.id === requestedDefault
            );

            defaultModel = defaultExists
                ? requestedDefault
                : modelSelector.options[0].value;

            modelSelector.value = defaultModel;

            modelSelector.disabled = false;

        } catch (error) {

            modelSelector.innerHTML = "";

            const option = document.createElement("option");

            option.value = "";

            option.textContent = "Models unavailable";

            modelSelector.appendChild(option);

            modelSelector.disabled = true;

            console.error(
                "Model loading failed:",
                error
            );

        }

        updateSendButton();

    }


    // =====================================
    // MODEL SELECTION
    // =====================================

    modelSelector.addEventListener(
        "change",
        updateSendButton
    );


    // =====================================
    // CLOSE DOCUMENT PREVIEW
    // =====================================

    function closeSourceDocument() {

        sourceRequestNumber++;

        if (sourceDocumentPanel) {
            sourceDocumentPanel.hidden = true;
        }

        if (sourceDocumentContent) {
            sourceDocumentContent.replaceChildren();
        }

        if (sourceDocumentTitle) {
            sourceDocumentTitle.textContent = "Document preview";
        }

        if (sourceDocumentDetails) {
            sourceDocumentDetails.textContent = "Source information";
        }

    }


    closeSourceDocumentButton?.addEventListener(
        "click",
        closeSourceDocument
    );


    // =====================================
    // OPEN DOCUMENT PREVIEW
    // =====================================

    async function openSourceDocument(source) {

        if (
            !sourceDocumentPanel ||
            !sourceDocumentContent
        ) {

            console.error(
                "Document preview elements are missing."
            );

            return;

        }

        if (!source || !source.document_path) {

            console.error(
                "Source document path is missing.",
                source
            );

            return;

        }

        const currentRequest = ++sourceRequestNumber;

        sourceDocumentPanel.hidden = false;

        if (sourceDocumentTitle) {

            sourceDocumentTitle.textContent =
                source.document_name || "Document preview";

        }

        const details = [];

        if (
            source.page_number !== null &&
            source.page_number !== undefined
        ) {

            details.push(`Page ${source.page_number}`);

        }

        if (source.section_title) {
            details.push(source.section_title);
        }

        if (sourceDocumentDetails) {

            sourceDocumentDetails.textContent =
                details.join(" · ") || "Document source";

        }

        sourceDocumentContent.replaceChildren();

        const loading = document.createElement("div");

        loading.className = "source-document-placeholder";

        loading.textContent = "Loading document source...";

        sourceDocumentContent.appendChild(loading);

        const params = new URLSearchParams();

        params.set("path", source.document_path);

        if (
            source.page_number !== null &&
            source.page_number !== undefined
        ) {

            params.set("page", source.page_number);

        }

        if (source.section_title) {

            params.set("section", source.section_title);

        }

        if (
            source.chunk_index !== null &&
            source.chunk_index !== undefined
        ) {

            params.set("chunk_index", source.chunk_index);

        }

        if (
            source.line_start !== null &&
            source.line_start !== undefined
        ) {

            params.set("line_start", source.line_start);

        }

        if (
            source.line_end !== null &&
            source.line_end !== undefined
        ) {

            params.set("line_end", source.line_end);

        }

        try {

            const response = await fetch(
                `/api/documents/source?${params.toString()}`
            );

            if (!response.ok) {

                const errorText = await response.text();

                throw new Error(
                    `Document request failed (${response.status}): ${errorText}`
                );

            }

            const data = await response.json();

            // Ignore an older request if another source was clicked.

            if (currentRequest !== sourceRequestNumber) {
                return;
            }

            renderSourceDocument(data, source);

        } catch (error) {

            if (currentRequest !== sourceRequestNumber) {
                return;
            }

            console.error(
                "Document preview error:",
                error
            );

            sourceDocumentContent.replaceChildren();

            const errorElement = document.createElement("div");

            errorElement.className = "source-document-placeholder";

            errorElement.textContent =
                `Could not load document: ${error.message}`;

            sourceDocumentContent.appendChild(errorElement);

        }

    }


    // =====================================
    // RENDER DOCUMENT CONTENT
    // =====================================

    function renderSourceDocument(data, source) {

        sourceDocumentContent.replaceChildren();

        const blocks =
            data.content_blocks ||
            data.blocks ||
            [];

        if (sourceDocumentTitle) {

            sourceDocumentTitle.textContent =
                data.document_name ||
                source.document_name ||
                "Document preview";

        }

        const details = [];

        const page =
            data.page_number ??
            source.page_number;

        const section =
            data.section_title ||
            source.section_title;

        if (page !== null && page !== undefined) {
            details.push(`Page ${page}`);
        }

        if (section) {
            details.push(section);
        }

        if (sourceDocumentDetails) {

            sourceDocumentDetails.textContent =
                details.join(" · ") || "Document source";

        }

        // Fallback when the API returns plain text.

        if (!Array.isArray(blocks) || blocks.length === 0) {

            const fallbackText =
                data.text ||
                data.content ||
                data.excerpt ||
                "";

            if (fallbackText) {

                const block = document.createElement("div");

                block.className = "source-preview-block";

                block.textContent = fallbackText;

                sourceDocumentContent.appendChild(block);

            } else {

                showDocumentNotice(
                    "The server did not return document content."
                );

            }

            return;

        }

        // The backend may provide the exact content block
        // that corresponds to the retrieved source chunk.

        const targetBlockIndex =
            data.source?.target_block_index;

        const hasTargetBlockIndex =
            Number.isInteger(targetBlockIndex) &&
            targetBlockIndex >= 0 &&
            targetBlockIndex < blocks.length;

        let highlightedBlock = null;

        blocks.forEach((block, index) => {

            // Ignore invalid block entries.

            if (
                block === null ||
                block === undefined
            ) {
                return;
            }

            const blockElement = document.createElement("div");

            blockElement.className = "source-preview-block";

            const text =
                typeof block === "string"
                    ? block
                    : (
                        block.text ||
                        block.content ||
                        block.excerpt ||
                        block.text_content ||
                        ""
                    );

            const matchesChunk =
                typeof block === "object" &&
                block.chunk_index !== undefined &&
                source.chunk_index !== undefined &&
                Number(block.chunk_index) ===
                Number(source.chunk_index);

            const matchesLine =
                typeof block === "object" &&
                block.line_start !== undefined &&
                source.line_start !== undefined &&
                Number(block.line_start) ===
                Number(source.line_start);

            const matchesSection =
                typeof block === "object" &&
                block.section_title &&
                source.section_title &&
                block.section_title === source.section_title;

            const matchesPage =
                typeof block === "object" &&
                block.page_number !== undefined &&
                source.page_number !== undefined &&
                Number(block.page_number) ===
                Number(source.page_number);

            let isMatch = false;

            if (hasTargetBlockIndex) {

                // Prefer the exact block identified by the backend.

                isMatch = index === targetBlockIndex;

            } else if (matchesChunk || matchesLine) {

                // Prefer chunk and line information over
                // broader section or page matching.

                isMatch = matchesChunk || matchesLine;

            } else if (matchesSection) {

                isMatch = true;

            } else if (matchesPage) {

                isMatch = true;

            }

            // Highlight only the first matching block.

            if (isMatch && !highlightedBlock) {

                blockElement.classList.add("source-highlight");

                highlightedBlock = blockElement;

            }

            if (typeof block === "object") {

                const sectionTitle =
                    block.section_title ||
                    block.heading ||
                    "";

                if (sectionTitle) {

                    const label = document.createElement("span");

                    label.className = "source-preview-label";

                    label.textContent = sectionTitle;

                    blockElement.appendChild(label);

                }

                if (
                    block.page_number !== null &&
                    block.page_number !== undefined
                ) {

                    const label = document.createElement("span");

                    label.className = "source-preview-label";

                    label.textContent =
                        `Page ${block.page_number}`;

                    blockElement.appendChild(label);

                }

            }

            const textElement = document.createElement("div");

            textElement.textContent = text;

            blockElement.appendChild(textElement);

            sourceDocumentContent.appendChild(blockElement);

        });

        // Scroll to the highlighted block when a match exists.

        if (highlightedBlock) {

            requestAnimationFrame(() => {

                highlightedBlock.scrollIntoView({

                    behavior: "smooth",

                    block: "center"

                });

            });

        }

    }


    // =====================================
    // DOCUMENT NOTICE
    // =====================================

    function showDocumentNotice(message) {

        const notice = document.createElement("div");

        notice.className = "source-document-placeholder";

        notice.textContent = message;

        sourceDocumentContent.appendChild(notice);

    }


    // =====================================
    // RENDER ANSWER
    // =====================================

    function renderMessageContent(messageElement, content) {

        const contentElement = document.createElement("div");

        contentElement.className = "message-content";

        // Display the answer as normal text.
        // No inline citation links.

        contentElement.textContent = content;

        messageElement.appendChild(contentElement);

    }


    // =====================================
    // RENDER SOURCE BUTTONS
    // =====================================

    function renderSources(messageElement, sources) {

        if (
            !Array.isArray(sources) ||
            sources.length === 0
        ) {
            return;
        }

        const sourcesContainer = document.createElement("div");

        sourcesContainer.className = "message-sources";

        sources.forEach(source => {

            if (!source || !source.document_path) {
                return;
            }

            const sourceButton = document.createElement("button");

            sourceButton.type = "button";

            sourceButton.className = "message-source-card";

            const buttonLabel = document.createElement("span");

            buttonLabel.className = "message-source-title";

            buttonLabel.textContent = "Review source";

            sourceButton.appendChild(buttonLabel);

            const details = [];

            if (source.document_name) {
                details.push(source.document_name);
            }

            if (
                source.page_number !== null &&
                source.page_number !== undefined
            ) {

                details.push(`Page ${source.page_number}`);

            }

            if (source.section_title) {
                details.push(source.section_title);
            }

            if (details.length > 0) {

                const detailsElement = document.createElement("span");

                detailsElement.className = "message-source-details";

                detailsElement.textContent =
                    details.join(" · ");

                sourceButton.appendChild(detailsElement);

            }

            sourceButton.addEventListener("click", () => {

                openSourceDocument(source);

            });

            sourcesContainer.appendChild(sourceButton);

        });

        if (sourcesContainer.children.length > 0) {

            messageElement.appendChild(sourcesContainer);

        }

    }


    // =====================================
    // DISPLAY MESSAGE
    // =====================================

    function addMessage(content, sender, sources = []) {

        const messageElement = document.createElement("div");

        messageElement.className = `message ${sender}`;

        if (sender === "assistant") {

            renderMessageContent(
                messageElement,
                content
            );

            renderSources(
                messageElement,
                sources
            );

        } else {

            messageElement.textContent = content;

        }

        messagesContainer.appendChild(messageElement);

        scrollToBottom();

        return messageElement;

    }


    // =====================================
    // SEND MESSAGE
    // =====================================

    async function sendMessage() {

        const message = messageInput.value.trim();

        const model = modelSelector.value;

        if (!message || !model || isSending) {
            return;
        }

        isSending = true;

        // Remember which conversation started this request.

        const currentGeneration = chatGeneration;

        updateSendButton();

        welcomeScreen.style.display = "none";

        addMessage(message, "user");

        messageInput.value = "";

        messageInput.style.height = "auto";

        const loadingMessage = addMessage(
            "Thinking...",
            "assistant"
        );

        // Keep the request within the backend's 40-message limit.
        // Reserve one additional slot for the assistant's response.

        const updatedHistory = [

            ...chatHistory.slice(
                -(MAX_CHAT_MESSAGES - 1)
            ),

            {
                role: "user",
                content: message
            }

        ];

        try {

            const result = await API.sendMessage(
                updatedHistory,
                model
            );

            // Ignore responses belonging to an older conversation.

            if (currentGeneration !== chatGeneration) {
                return;
            }

            loadingMessage.remove();

            if (
                !result ||
                typeof result.answer !== "string" ||
                !result.answer.trim()
            ) {

                throw new Error(
                    "The AI returned an empty response."
                );

            }

            const sources = Array.isArray(result.sources)
                ? result.sources
                : [];

            // Keep the stored history within the backend limit.

            chatHistory = [

                ...updatedHistory,

                {
                    role: "assistant",
                    content: result.answer
                }

            ].slice(-MAX_CHAT_MESSAGES);

            addMessage(
                result.answer,
                "assistant",
                sources
            );

        } catch (error) {

            if (currentGeneration !== chatGeneration) {
                return;
            }

            loadingMessage.remove();

            addMessage(
                `Error: ${error.message}`,
                "assistant"
            );

            console.error(
                "Chat error:",
                error
            );

        } finally {

            // An old request must not change the new chat's state.

            if (currentGeneration === chatGeneration) {

                isSending = false;

                updateSendButton();

                messageInput.focus();

                scrollToBottom();

            }

        }

    }


    // =====================================
    // SEND BUTTON
    // =====================================

    sendButton.addEventListener(
        "click",
        sendMessage
    );


    // =====================================
    // ENTER TO SEND
    // =====================================

    messageInput.addEventListener("keydown", event => {

        if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.isComposing
        ) {

            event.preventDefault();

            sendMessage();

        }

    });


    // =====================================
    // INPUT RESIZE
    // =====================================

    messageInput.addEventListener("input", () => {

        messageInput.style.height = "auto";

        messageInput.style.height =
            Math.min(messageInput.scrollHeight, 160) + "px";

        updateSendButton();

    });


    // =====================================
    // NEW CHAT
    // =====================================

    newChatButton?.addEventListener("click", () => {

        // Invalidate any request from the previous conversation.

        chatGeneration++;

        chatHistory = [];

        // Allow a new message even if the previous request
        // is still waiting for the backend.

        isSending = false;

        messagesContainer.innerHTML = "";

        messageInput.value = "";

        messageInput.style.height = "auto";

        welcomeScreen.style.display = "block";

        closeSourceDocument();

        if (defaultModel) {
            modelSelector.value = defaultModel;
        }

        updateSendButton();

        messageInput.focus();

    });


    // =====================================
    // DOCUMENT UPLOAD
    // =====================================

    if (uploadButton) {

        uploadButton.disabled = true;

        uploadButton.title =
            "Document management is available on the Documents page.";

    }


    // =====================================
    // INITIALIZE
    // =====================================

    checkConnection();

    loadModels();

    updateSendButton();

});