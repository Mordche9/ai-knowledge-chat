from pathlib import Path

import uvicorn

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from chat.router import router as chat_router
from documents_router import router as documents_router


# =====================================
# PROJECT DIRECTORIES
# =====================================

BASE_DIR = Path(__file__).resolve().parent

FRONTEND_DIR = BASE_DIR.parent / "frontend"
DOCUMENTS_DIR = BASE_DIR / "documents"

DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)


# =====================================
# FASTAPI APPLICATION
# =====================================

app = FastAPI(
    title="Knowledge AI",
    description="AI Chat Application",
    version="1.0.0"
)


# =====================================
# FRONTEND PAGES
# =====================================

# Default page: Chat

@app.get("/")
@app.get("/index.html")
@app.get("/chat")
def home():
    return FileResponse(
        FRONTEND_DIR / "index.html"
    )


# Documents page

@app.get("/documents.html")
@app.get("/documents")
def documents():
    return FileResponse(
        FRONTEND_DIR / "documents.html"
    )


# =====================================
# STATIC FILES
# =====================================

app.mount(
    "/css",
    StaticFiles(directory=FRONTEND_DIR / "css"),
    name="css"
)

app.mount(
    "/js",
    StaticFiles(directory=FRONTEND_DIR / "js"),
    name="js"
)


# =====================================
# HEALTH CHECK
# =====================================

@app.get("/health")
def health():
    return {
        "status": "online"
    }


# =====================================
# API ROUTERS
# =====================================

app.include_router(
    chat_router,
    prefix="/api"
)

app.include_router(
    documents_router,
    prefix="/api"
)


# =====================================
# START SERVER
# =====================================

if __name__ == "__main__":

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
        app_dir=str(BASE_DIR),
        reload_dirs=[str(BASE_DIR)]
    )
