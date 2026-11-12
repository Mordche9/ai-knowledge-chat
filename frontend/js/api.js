
const API_BASE_URL = "";

const REQUEST_TIMEOUT = 60000;


// =====================================
// HANDLE BACKEND RESPONSES
// =====================================

async function handleResponse(response) {

    const responseText = await response.text();

    let data = {};

    if (responseText) {

        try {

            data = JSON.parse(responseText);

        } catch {

            if (!response.ok) {

                throw new Error(
                    `Backend error: HTTP ${response.status}`
                );

            }

            throw new Error(
                "Invalid response from backend."
            );

        }

    }

    if (!response.ok) {

        let errorMessage = "Something went wrong.";

        if (typeof data.detail === "string") {

            errorMessage = data.detail;

        } else if (typeof data.message === "string") {

            errorMessage = data.message;

        } else if (Array.isArray(data.detail)) {

            errorMessage = data.detail
                .map(error => error.msg || "Invalid input")
                .join(", ");

        }

        throw new Error(errorMessage);

    }

    return data;
}


// =====================================
// API REQUEST HANDLER
// =====================================

async function apiRequest(url, options = {}) {

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT);

    try {

        const response = await fetch(url, {

            ...options,

            signal: controller.signal

        });

        return await handleResponse(response);

    } catch (error) {

        if (controller.signal.aborted) {

            throw new Error(
                "The backend request timed out. Please try again."
            );

        }

        if (error instanceof TypeError) {

            throw new Error(
                "Cannot connect to the backend. Check your connection."
            );

        }

        throw error;

    } finally {

        clearTimeout(timeout);

    }

}


// =====================================
// API
// =====================================

const API = {


    // =================================
    // GET MODELS
    // =================================

    async getModels() {

        return apiRequest(
            `${API_BASE_URL}/api/models`
        );

    },


    // =================================
    // SEND CHAT
    // =================================

    async sendMessage(messages, model) {

        return apiRequest(

            `${API_BASE_URL}/api/chat`,

            {

                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({

                    messages: messages,

                    model: model

                })

            }

        );

    },


    // =================================
    // CHECK CONNECTION
    // =================================

    async checkConnection() {

        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, 10000);

        try {

            const response = await fetch(
                `${API_BASE_URL}/health`,
                {
                    signal: controller.signal
                }
            );

            return response.ok;

        } catch {

            return false;

        } finally {

            clearTimeout(timeout);

        }

    }

};