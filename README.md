# AI Knowledge Chat

An AI-powered document assistant that allows users to upload documents, manage files, and ask questions using natural language.

The application uses **Retrieval-Augmented Generation (RAG)** to retrieve relevant information from uploaded documents and generate context-aware answers.

---

## Features

### AI Chat

- Conversational AI interface powered by OpenAI.
- Supports available GPT models.
- Maintains conversation context.
- Retrieves relevant document information when answering questions.

### Document Management

- Upload PDF, DOCX, and TXT documents.
- Create and delete folders.
- Copy, move, and delete files.
- Search and preview documents.
- Monitor document embedding status.
- Embed, re-embed, and retry document processing.

### Retrieval-Augmented Generation (RAG)

- Extracts text from uploaded documents.
- Splits documents into searchable chunks.
- Generates embeddings for semantic search.
- Stores and retrieves document vectors using ChromaDB.
- Uses retrieved context to generate relevant answers.
- Provides source references for answers.

---

## Technologies

| Area | Technologies |
|---|---|
| Backend | Python, FastAPI |
| Frontend | HTML, CSS, JavaScript |
| AI | OpenAI API |
| Vector Database | ChromaDB |
| Database | SQLite |
| Document Processing | PyPDF, python-docx |

---

## Project Structure

```text
ai-knowledge-chat/
├── backend/
│   ├── chat/
│   │   ├── __init__.py
│   │   ├── router.py
│   │   └── service.py
│   ├── .env.example
│   ├── documents_router.py
│   ├── main.py
│   └── requirements.txt
│
├── frontend/
│   ├── css/
│   │   ├── documents.css
│   │   └── style.css
│   ├── js/
│   │   ├── api.js
│   │   ├── chat.js
│   │   └── documents.js
│   ├── documents.html
│   └── index.html
│
├── .gitignore
└── README.md
```

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/Mordche9/ai-knowledge-chat.git
cd ai-knowledge-chat
```

### 2. Create a virtual environment

```bash
python -m venv .venv
```

Activate it on Windows:

```powershell
.venv\Scripts\Activate.ps1
```

### 3. Install dependencies

```bash
python -m pip install -r backend/requirements.txt
```

### 4. Configure environment variables

Create a `.env` file inside the `backend` directory.

Add your OpenAI API key:

```env
OPENAI_API_KEY=your_openai_api_key_here
```

### 5. Start the application

```bash
cd backend
python main.py
```

Open the application in your browser:

**http://127.0.0.1:8000**

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Application health check |
| `/api/models` | GET | Retrieve available AI models |
| `/api/chat` | POST | Send chat messages |
| `/api/documents` | GET | Retrieve documents |

Additional document-management endpoints support uploading, previewing, embedding, copying, moving, and deleting files and folders.

---

## Data Storage

The application uses:

- **Local storage** for uploaded documents.
- **SQLite** for document metadata.
- **ChromaDB** for vector embeddings.

Runtime data and environment files are excluded from version control.

---

## Security Considerations

- API keys are stored in environment variables.
- Uploaded files are handled by the backend.
- Document-management operations include input validation and path handling.
- Retrieved document content is treated as untrusted input.

This project is intended as a local development and portfolio application, not a production-ready deployment.

---

## Future Improvements

- User authentication and account management.
- Improved document retrieval and ranking.
- Display recent conversations and recent uploads.

---

## Author

**Mordche**

GitHub: [@Mordche9](https://github.com/Mordche9)

Project Repository: [AI Knowledge Chat](https://github.com/Mordche9/ai-knowledge-chat)
