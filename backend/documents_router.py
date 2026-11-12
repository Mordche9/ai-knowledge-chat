from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import hashlib
import logging
import re
import shutil
import sqlite3
import uuid

import chromadb

from fastapi import (
    APIRouter,
    HTTPException,
    Query,
    UploadFile,
    File,
    Form,
)

from pydantic import BaseModel, Field
from pypdf import PdfReader
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P


router = APIRouter()
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
DOCUMENTS_DIR = BASE_DIR / "documents"
CHROMA_DIR = BASE_DIR / "chroma_data"
METADATA_DB = BASE_DIR / "document_metadata.db"

DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
CHROMA_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt"}

MAX_FILE_SIZE = 25 * 1024 * 1024
MAX_PREVIEW_CHARACTERS = 200_000

EMBEDDING_MODEL = "text-embedding-3-small"
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
EMBEDDING_BATCH_SIZE = 100

WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


# =====================================
# DATABASE INITIALIZATION
# =====================================

def get_metadata_connection():
    connection = sqlite3.connect(
        METADATA_DB,
        timeout=30
    )
    connection.row_factory = sqlite3.Row
    return connection


def initialize_metadata_db():
    with get_metadata_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS document_status (
                path TEXT PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'not_embedded',
                file_hash TEXT,
                chunk_count INTEGER DEFAULT 0,
                error TEXT,
                updated_at TEXT
            )
        """)


initialize_metadata_db()


# =====================================
# CHROMADB
# =====================================

chroma_client = chromadb.PersistentClient(
    path=str(CHROMA_DIR)
)

collection = chroma_client.get_or_create_collection(
    name="knowledge_chunks",
    metadata={"hnsw:space": "cosine"}
)


# =====================================
# PATH AND NAME VALIDATION
# =====================================

def validate_item_name(name: str):
    if not isinstance(name, str):
        raise HTTPException(
            status_code=400,
            detail="Invalid item name."
        )

    if not name or name in (".", ".."):
        raise HTTPException(
            status_code=400,
            detail="Invalid item name."
        )

    if name != name.strip():
        raise HTTPException(
            status_code=400,
            detail="Names cannot start or end with spaces."
        )

    if name.endswith("."):
        raise HTTPException(
            status_code=400,
            detail="Names cannot end with a period."
        )

    if any(
        character in name
        for character in '<>:"/\\|?*\x00'
    ):
        raise HTTPException(
            status_code=400,
            detail="The name contains invalid characters."
        )

    if any(ord(character) < 32 for character in name):
        raise HTTPException(
            status_code=400,
            detail="The name contains invalid characters."
        )

    device_name = name.split(".")[0].upper()

    if device_name in WINDOWS_RESERVED_NAMES:
        raise HTTPException(
            status_code=400,
            detail="This name is reserved by Windows."
        )

    return name


def get_safe_path(relative_path: str = ""):
    if not isinstance(relative_path, str):
        raise HTTPException(
            status_code=400,
            detail="Invalid path."
        )

    if "\\" in relative_path or "\x00" in relative_path:
        raise HTTPException(
            status_code=400,
            detail="Invalid path."
        )

    parts = relative_path.split("/") if relative_path else []

    for part in parts:
        if part in ("", ".", ".."):
            raise HTTPException(
                status_code=400,
                detail="Invalid path."
            )

        validate_item_name(part)

    base = DOCUMENTS_DIR.resolve()
    candidate = base

    for part in parts:
        candidate = candidate / part

        if candidate.is_symlink():
            raise HTTPException(
                status_code=400,
                detail="Symbolic links are not supported."
            )

    target = candidate.resolve()

    if not target.is_relative_to(base):
        raise HTTPException(
            status_code=400,
            detail="Invalid path."
        )

    return target


def get_relative_path(file_path: Path):
    return file_path.relative_to(
        DOCUMENTS_DIR.resolve()
    ).as_posix()


def validate_no_symlinks(path: Path):
    try:
        if path.is_symlink():
            raise HTTPException(
                status_code=400,
                detail="Symbolic links are not supported."
            )

        if path.is_dir():
            for item in path.iterdir():
                validate_no_symlinks(item)

    except HTTPException:
        raise

    except OSError:
        logger.exception(
            "Could not inspect filesystem path: %s",
            path
        )
        raise HTTPException(
            status_code=400,
            detail="Could not safely inspect this item."
        )


def validate_document(path: Path):
    if not path.exists() or not path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Document not found."
        )

    if path.is_symlink():
        raise HTTPException(
            status_code=400,
            detail="Invalid document."
        )

    if path.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported document format."
        )


def is_within(parent: Path, child: Path):
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def reject_overlapping_paths(paths):
    resolved = [
        get_safe_path(path)
        for path in paths
    ]

    for index, current in enumerate(resolved):
        for other_index, other in enumerate(resolved):
            if index == other_index:
                continue

            if is_within(current, other):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "A selection cannot contain both a folder "
                        "and one of its descendants."
                    )
                )

    return resolved


# =====================================
# REQUEST MODELS
# =====================================

class CreateFolderRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_path: str = ""


class DocumentRequest(BaseModel):
    path: str


class CopyMoveRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=100)
    destination_path: str = ""


class DeleteItemsRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=100)


# =====================================
# DOCUMENT HEADING DETECTION
# =====================================

def is_heading(text: str) -> bool:
    text = text.strip()

    if not text or len(text) > 120:
        return False

    if text.endswith((".", ",", ";")):
        return False

    if re.match(
        r"^\d+(\.\d+)*[\.\s]+[A-Z]",
        text
    ):
        return True

    if re.match(
        r"^(chapter|section|part)\s+\w+",
        text,
        re.IGNORECASE
    ):
        return True

    letters = [
        character
        for character in text
        if character.isalpha()
    ]

    if letters and all(
        character.isupper()
        for character in letters
    ):
        return True

    return False


# =====================================
# DOCX BLOCK ITERATION
# =====================================

def iter_docx_blocks(document):
    """
    Return DOCX paragraphs and tables in document order.
    """
    body = document.element.body

    for child in body.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, document)

        elif isinstance(child, CT_Tbl):
            yield Table(child, document)


# =====================================
# STRUCTURED DOCUMENT EXTRACTION
# =====================================

def extract_document_units(file_path: Path):
    extension = file_path.suffix.lower()
    units = []
    current_section = "Document"

    try:
        # ---------------------------------
        # PDF
        # ---------------------------------

        if extension == ".pdf":
            reader = PdfReader(str(file_path))

            if reader.is_encrypted:
                raise ValueError(
                    "This PDF is password-protected."
                )

            for page_number, page in enumerate(
                reader.pages,
                start=1
            ):
                page_text = page.extract_text() or ""

                if not page_text.strip():
                    continue

                current_lines = []

                for line in page_text.splitlines():
                    cleaned = line.strip()

                    if not cleaned:
                        continue

                    if is_heading(cleaned):
                        if current_lines:
                            units.append({
                                "text": "\n".join(current_lines),
                                "page_number": page_number,
                                "section_title": current_section,
                                "line_start": None,
                                "line_end": None
                            })
                            current_lines = []

                        current_section = cleaned

                    else:
                        current_lines.append(cleaned)

                if current_lines:
                    units.append({
                        "text": "\n".join(current_lines),
                        "page_number": page_number,
                        "section_title": current_section,
                        "line_start": None,
                        "line_end": None
                    })

            return units

        # ---------------------------------
        # DOCX
        # ---------------------------------

        if extension == ".docx":
            document = Document(str(file_path))
            current_lines = []

            for block in iter_docx_blocks(document):
                if isinstance(block, Paragraph):
                    text = block.text.strip()

                    if not text:
                        continue

                    style_name = (
                        block.style.name.lower()
                        if block.style else ""
                    )

                    is_docx_heading = (
                        style_name.startswith("heading")
                        or style_name == "title"
                    )

                    if is_docx_heading:
                        if current_lines:
                            units.append({
                                "text": "\n".join(current_lines),
                                "page_number": None,
                                "section_title": current_section,
                                "line_start": None,
                                "line_end": None
                            })
                            current_lines = []

                        current_section = text

                    else:
                        current_lines.append(text)

                elif isinstance(block, Table):
                    for row in block.rows:
                        cells = [
                            cell.text.strip()
                            for cell in row.cells
                        ]

                        row_text = " | ".join(
                            cell
                            for cell in cells
                            if cell
                        )

                        if row_text:
                            current_lines.append(row_text)

            if current_lines:
                units.append({
                    "text": "\n".join(current_lines),
                    "page_number": None,
                    "section_title": current_section,
                    "line_start": None,
                    "line_end": None
                })

            return units

        # ---------------------------------
        # TXT
        # ---------------------------------

        if extension == ".txt":
            raw = file_path.read_bytes()
            decoded_text = None

            for encoding in (
                "utf-8-sig",
                "utf-16",
                "cp1252"
            ):
                try:
                    decoded_text = raw.decode(encoding)
                    break
                except UnicodeDecodeError:
                    continue

            if decoded_text is None:
                raise ValueError(
                    "Could not decode this text file."
                )

            current_lines = []
            section_start = None
            all_lines = decoded_text.splitlines()

            for line_number, line in enumerate(
                all_lines,
                start=1
            ):
                cleaned = line.strip()

                if not cleaned:
                    continue

                if is_heading(cleaned):
                    if current_lines:
                        units.append({
                            "text": "\n".join(current_lines),
                            "page_number": None,
                            "section_title": current_section,
                            "line_start": section_start,
                            "line_end": line_number - 1
                        })

                        current_lines = []
                        section_start = None

                    current_section = cleaned

                else:
                    if section_start is None:
                        section_start = line_number

                    current_lines.append(cleaned)

            if current_lines:
                units.append({
                    "text": "\n".join(current_lines),
                    "page_number": None,
                    "section_title": current_section,
                    "line_start": section_start,
                    "line_end": len(all_lines)
                })

            return units

        raise ValueError(
            "Unsupported document format."
        )

    except HTTPException:
        raise

    except Exception as error:
        logger.exception(
            "Document extraction failed: %s",
            file_path
        )

        raise HTTPException(
            status_code=422,
            detail=f"Could not read this document: {error}"
        )


# =====================================
# DOCUMENT TEXT EXTRACTION
# =====================================

def extract_document_text(file_path: Path):
    units = extract_document_units(file_path)
    output = []

    for unit in units:
        if unit["page_number"] is not None:
            output.append(
                f"--- Page {unit['page_number']} ---"
            )

        if unit["section_title"]:
            output.append(
                f"--- Section: {unit['section_title']} ---"
            )

        if unit["line_start"] is not None:
            output.append(
                f"--- Lines {unit['line_start']}-{unit['line_end']} ---"
            )

        output.append(unit["text"])

    return "\n\n".join(output)


# =====================================
# STRUCTURE-AWARE TEXT CHUNKING
# =====================================

def split_text_into_chunks(units):
    chunks = []

    for unit in units:
        text = unit["text"].strip()

        if not text:
            continue

        start = 0

        while start < len(text):
            end = min(
                start + CHUNK_SIZE,
                len(text)
            )

            if end < len(text):
                boundary = text.rfind(
                    " ",
                    start,
                    end
                )

                if boundary > start:
                    end = boundary

            chunk_text = text[start:end].strip()

            if chunk_text:
                line_start = unit["line_start"]
                line_end = unit["line_end"]

                if line_start is not None:
                    lines_before = text[:start].count("\n")
                    lines_in_chunk = chunk_text.count("\n")

                    line_start = line_start + lines_before
                    line_end = line_start + lines_in_chunk

                chunks.append({
                    "text": chunk_text,
                    "page_number": unit["page_number"],
                    "section_title": unit["section_title"],
                    "line_start": line_start,
                    "line_end": line_end
                })

            if end >= len(text):
                break

            start = max(
                0,
                end - CHUNK_OVERLAP
            )

    return chunks


# =====================================
# FILE HASH
# =====================================

def calculate_file_hash(file_path: Path):
    digest = hashlib.sha256()

    with file_path.open("rb") as file:
        while True:
            data = file.read(1024 * 1024)

            if not data:
                break

            digest.update(data)

    return digest.hexdigest()


# =====================================
# EMBEDDING STATUS
# =====================================

def get_document_status(relative_path: str):
    with get_metadata_connection() as connection:
        row = connection.execute(
            """
            SELECT *
            FROM document_status
            WHERE path = ?
            """,
            (relative_path,)
        ).fetchone()

    if row is None:
        return {
            "status": "not_embedded",
            "chunk_count": 0,
            "error": None
        }

    return {
        "status": row["status"],
        "chunk_count": row["chunk_count"],
        "error": row["error"]
    }


def get_all_document_statuses():
    with get_metadata_connection() as connection:
        rows = connection.execute(
            """
            SELECT path, status, chunk_count, error, updated_at
            FROM document_status
            """
        ).fetchall()

    return {
        row["path"]: {
            "status": row["status"],
            "chunk_count": row["chunk_count"],
            "error": row["error"],
            "updated_at": row["updated_at"]
        }
        for row in rows
    }


def save_document_status(
    relative_path,
    status,
    file_hash=None,
    chunk_count=0,
    error=None
):
    with get_metadata_connection() as connection:
        connection.execute(
            """
            INSERT INTO document_status (
                path,
                status,
                file_hash,
                chunk_count,
                error,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)

            ON CONFLICT(path)
            DO UPDATE SET
                status = excluded.status,
                file_hash = excluded.file_hash,
                chunk_count = excluded.chunk_count,
                error = excluded.error,
                updated_at = excluded.updated_at
            """,
            (
                relative_path,
                status,
                file_hash,
                chunk_count,
                error,
                datetime.now(timezone.utc).isoformat()
            )
        )


def remove_document_status(relative_path: str):
    with get_metadata_connection() as connection:
        connection.execute(
            """
            DELETE FROM document_status
            WHERE path = ?
            """,
            (relative_path,)
        )


# =====================================
# REMOVE DOCUMENT VECTORS
# =====================================

def remove_document_vectors(relative_path: str):
    collection.delete(
        where={"document_path": relative_path}
    )


# =====================================
# EMBED DOCUMENT
# =====================================

def embed_document(relative_path: str):
    file_path = get_safe_path(relative_path)
    validate_document(file_path)

    if file_path.stat().st_size > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Document is too large."
        )

    save_document_status(
        relative_path,
        "processing"
    )

    new_document_ids = []

    try:
        file_hash = calculate_file_hash(file_path)

        units = extract_document_units(file_path)

        if not units:
            raise ValueError(
                "No readable text was found in this document."
            )

        chunks = split_text_into_chunks(units)

        if not chunks:
            raise ValueError(
                "No text chunks could be created."
            )

        from chat.service import get_openai_client

        client = get_openai_client()

        chunk_texts = [
            chunk["text"]
            for chunk in chunks
        ]

        embeddings = []

        for index in range(
            0,
            len(chunk_texts),
            EMBEDDING_BATCH_SIZE
        ):
            batch = chunk_texts[
                index:index + EMBEDDING_BATCH_SIZE
            ]

            response = client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=batch
            )

            batch_embeddings = [
                item.embedding
                for item in response.data
            ]

            if len(batch_embeddings) != len(batch):
                raise ValueError(
                    "The embedding service returned an unexpected number of embeddings."
                )

            embeddings.extend(batch_embeddings)

        new_document_ids = [
            str(uuid.uuid4())
            for _ in chunks
        ]

        metadatas = []

        for index, chunk in enumerate(chunks):
            metadatas.append({
                "document_path": relative_path,
                "document_name": file_path.name,
                "chunk_index": index,
                "file_hash": file_hash,
                "section_title": (
                    chunk["section_title"] or "Document"
                ),
                "page_number": (
                    chunk["page_number"]
                    if chunk["page_number"] is not None
                    else -1
                ),
                "line_start": (
                    chunk["line_start"]
                    if chunk["line_start"] is not None
                    else -1
                ),
                "line_end": (
                    chunk["line_end"]
                    if chunk["line_end"] is not None
                    else -1
                )
            })

        # Keep the previous vectors until the new vectors
        # have been successfully inserted.

        collection.add(
            ids=new_document_ids,
            documents=chunk_texts,
            embeddings=embeddings,
            metadatas=metadatas
        )

        old_records = collection.get(
            where={
                "document_path": relative_path
            },
            include=[]
        )

        old_ids = [
            item_id
            for item_id in old_records["ids"]
            if item_id not in new_document_ids
        ]

        if old_ids:
            collection.delete(ids=old_ids)

        save_document_status(
            relative_path,
            "embedded",
            file_hash,
            len(chunks)
        )

        return {
            "message": "Document embedded successfully.",
            "path": relative_path,
            "status": "embedded",
            "chunk_count": len(chunks)
        }

    except HTTPException as error:
        if new_document_ids:
            try:
                collection.delete(ids=new_document_ids)
            except Exception:
                logger.exception(
                    "Could not clean up new vectors for %s",
                    relative_path
                )

        save_document_status(
            relative_path,
            "failed",
            error=str(error.detail)
        )
        raise

    except Exception:
        if new_document_ids:
            try:
                collection.delete(ids=new_document_ids)
            except Exception:
                logger.exception(
                    "Could not clean up new vectors for %s",
                    relative_path
                )

        logger.exception(
            "Embedding failed for document: %s",
            relative_path
        )

        save_document_status(
            relative_path,
            "failed",
            error="Embedding failed. Check backend logs."
        )

        raise HTTPException(
            status_code=500,
            detail="Embedding failed. Check the backend logs."
        )


# =====================================
# LIST FILES AND FOLDERS
# =====================================

@router.get("/documents")
def list_documents(path: str = Query(default="")):
    current_folder = get_safe_path(path)

    if (
        not current_folder.exists()
        or not current_folder.is_dir()
    ):
        raise HTTPException(
            status_code=404,
            detail="Folder not found."
        )

    statuses = get_all_document_statuses()
    items = []

    try:
        folder_items = list(current_folder.iterdir())
    except OSError:
        logger.exception(
            "Could not list folder: %s",
            current_folder
        )
        raise HTTPException(
            status_code=500,
            detail="Could not list this folder."
        )

    for item in folder_items:
        if item.is_symlink():
            continue

        if not item.is_dir() and not item.is_file():
            continue

        try:
            stat = item.stat()
        except OSError:
            logger.warning(
                "Could not inspect item: %s",
                item
            )
            continue

        modified = datetime.fromtimestamp(
            stat.st_mtime,
            tz=timezone.utc
        )

        relative_path = get_relative_path(item)

        if item.is_dir():
            items.append({
                "name": item.name,
                "type": "folder",
                "path": relative_path,
                "modified": modified.isoformat()
            })

        elif item.suffix.lower() in ALLOWED_EXTENSIONS:
            status = statuses.get(
                relative_path,
                {
                    "status": "not_embedded",
                    "chunk_count": 0
                }
            )

            items.append({
                "name": item.name,
                "type": "file",
                "extension": item.suffix.lower(),
                "path": relative_path,
                "size": stat.st_size,
                "modified": modified.isoformat(),
                "embedding_status": status["status"],
                "chunk_count": status["chunk_count"]
            })

    items.sort(
        key=lambda item: (
            0 if item["type"] == "folder" else 1,
            item["name"].lower()
        )
    )

    return {
        "current_path": path,
        "items": items
    }


# =====================================
# CREATE FOLDER
# =====================================

@router.post("/documents/folders")
def create_folder(request: CreateFolderRequest):
    name = validate_item_name(
        request.name.strip()
    )

    if len(name) > 100:
        raise HTTPException(
            status_code=400,
            detail="Folder name is too long."
        )

    parent = get_safe_path(
        request.parent_path
    )

    if not parent.exists() or not parent.is_dir():
        raise HTTPException(
            status_code=404,
            detail="Parent folder not found."
        )

    new_folder = parent / name

    try:
        new_folder.mkdir()
    except FileExistsError:
        raise HTTPException(
            status_code=409,
            detail="An item with this name already exists."
        )
    except OSError:
        logger.exception(
            "Could not create folder: %s",
            new_folder
        )
        raise HTTPException(
            status_code=500,
            detail="Could not create the folder."
        )

    return {
        "message": "Folder created successfully.",
        "name": name,
        "path": get_relative_path(new_folder),
        "type": "folder"
    }


# =====================================
# DELETE EMPTY FOLDER
# =====================================

@router.delete("/documents/folders")
def delete_folder(path: str = Query(...)):
    if not path:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete the root folder."
        )

    folder = get_safe_path(path)

    if not folder.exists() or not folder.is_dir():
        raise HTTPException(
            status_code=404,
            detail="Folder not found."
        )

    validate_no_symlinks(folder)

    if any(folder.iterdir()):
        raise HTTPException(
            status_code=409,
            detail="This folder is not empty. Delete its contents first."
        )

    folder.rmdir()

    return {
        "message": "Folder deleted successfully.",
        "path": path
    }


# =====================================
# UPLOAD DOCUMENT
# =====================================

@router.post("/documents/upload")
async def upload_document(
    file: UploadFile = File(...),
    path: str = Form(default="")
):
    destination_folder = get_safe_path(path)

    if (
        not destination_folder.exists()
        or not destination_folder.is_dir()
    ):
        raise HTTPException(
            status_code=404,
            detail="Destination folder not found."
        )

    original_name = file.filename or ""

    if (
        not original_name
        or "/" in original_name
        or "\\" in original_name
        or "\x00" in original_name
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid filename."
        )

    filename = Path(original_name).name
    validate_item_name(filename)

    if len(filename) > 255:
        raise HTTPException(
            status_code=400,
            detail="Filename is too long."
        )

    extension = Path(filename).suffix.lower()

    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Only PDF, DOCX and TXT files are supported."
        )

    destination = destination_folder / filename

    if destination.exists():
        raise HTTPException(
            status_code=409,
            detail=f'"{filename}" already exists in this folder.'
        )

    total_size = 0
    created_file = False

    try:
        with destination.open("xb") as output:
            created_file = True

            while True:
                chunk = await file.read(1024 * 1024)

                if not chunk:
                    break

                total_size += len(chunk)

                if total_size > MAX_FILE_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail="Maximum file size is 25 MB."
                    )

                output.write(chunk)

        if total_size == 0:
            raise HTTPException(
                status_code=400,
                detail="The uploaded file is empty."
            )

        relative_path = get_relative_path(destination)

        save_document_status(
            relative_path,
            "not_embedded"
        )

    except Exception:
        if created_file:
            destination.unlink(missing_ok=True)
        raise

    finally:
        await file.close()

    return {
        "message": "File uploaded successfully.",
        "name": filename,
        "type": "file",
        "path": relative_path,
        "size": total_size,
        "embedding_status": "not_embedded",
        "embed_available": True
    }


# =====================================
# EMBED DOCUMENT ENDPOINT
# =====================================

@router.post("/documents/embed")
def embed_endpoint(request: DocumentRequest):
    return embed_document(request.path)


# =====================================
# RETRY EMBEDDING ENDPOINT
# =====================================

@router.post("/documents/retry")
def retry_embedding(request: DocumentRequest):
    return embed_document(request.path)


# =====================================
# GET ALL EMBEDDING STATUSES
# =====================================

@router.get("/documents/status")
def get_all_embedding_statuses():
    with get_metadata_connection() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM document_status
            """
        ).fetchall()

    return {
        "items": [
            {
                "path": row["path"],
                "status": row["status"],
                "chunk_count": row["chunk_count"],
                "error": row["error"],
                "updated_at": row["updated_at"]
            }
            for row in rows
        ]
    }


# =====================================
# DELETE FILES AND FOLDERS
# =====================================

@router.delete("/documents/items")
def delete_items(request: DeleteItemsRequest):
    paths = request.paths

    if any(not path for path in paths):
        raise HTTPException(
            status_code=400,
            detail="Cannot delete the root folder."
        )

    if len(set(paths)) != len(paths):
        raise HTTPException(
            status_code=400,
            detail="Duplicate paths were supplied."
        )

    resolved_targets = reject_overlapping_paths(paths)
    targets = []

    # Validate every selected item before deleting anything.

    for relative_path, target in zip(
        paths,
        resolved_targets
    ):
        if not target.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Item not found: {relative_path}"
            )

        validate_no_symlinks(target)
        targets.append((relative_path, target))

    # Delete each selected item once. Nested selections have
    # already been rejected by reject_overlapping_paths().

    for relative_path, target in targets:
        if target.is_file():
            if target.suffix.lower() in ALLOWED_EXTENSIONS:
                remove_document_vectors(relative_path)
                remove_document_status(relative_path)

            target.unlink()

        else:
            document_paths = []

            for child in target.rglob("*"):
                if (
                    child.is_file()
                    and child.suffix.lower() in ALLOWED_EXTENSIONS
                ):
                    document_paths.append(
                        get_relative_path(child)
                    )

            for child_path in document_paths:
                remove_document_vectors(child_path)
                remove_document_status(child_path)

            shutil.rmtree(target)

    return {
        "message": "Selected items deleted successfully."
    }


# =====================================
# COPY VALIDATION
# =====================================

def prepare_copy_move_items(request, operation):
    if len(set(request.paths)) != len(request.paths):
        raise HTTPException(
            status_code=400,
            detail="Duplicate paths were supplied."
        )

    if any(not path for path in request.paths):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot {operation} the root folder."
        )

    destination_folder = get_safe_path(
        request.destination_path
    )

    if (
        not destination_folder.exists()
        or not destination_folder.is_dir()
    ):
        raise HTTPException(
            status_code=404,
            detail="Destination folder not found."
        )

    resolved_sources = reject_overlapping_paths(
        request.paths
    )

    items = []

    for relative_path, source in zip(
        request.paths,
        resolved_sources
    ):
        if not source.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Source not found: {relative_path}"
            )

        validate_no_symlinks(source)

        if source.is_dir():
            if (
                destination_folder == source
                or is_within(source, destination_folder)
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Cannot {operation} a folder into itself "
                        "or one of its descendants."
                    )
                )

        destination = destination_folder / source.name

        if destination.exists():
            raise HTTPException(
                status_code=409,
                detail=(
                    f'"{source.name}" already exists '
                    "in the destination."
                )
            )

        items.append({
            "relative_path": relative_path,
            "source": source,
            "destination": destination
        })

    destination_paths = [
        item["destination"]
        for item in items
    ]

    if len(set(destination_paths)) != len(destination_paths):
        raise HTTPException(
            status_code=400,
            detail="Multiple selected items have conflicting names."
        )

    return destination_folder, items


# =====================================
# COPY FILES AND FOLDERS
# =====================================

@router.post("/documents/copy")
def copy_items(request: CopyMoveRequest):
    _, items = prepare_copy_move_items(
        request,
        "copy"
    )

    copied = []

    try:
        for item in items:
            source = item["source"]
            destination = item["destination"]

            if source.is_dir():
                shutil.copytree(
                    source,
                    destination
                )
            else:
                shutil.copy2(
                    source,
                    destination
                )

            copied.append(destination)

    except Exception:
        logger.exception(
            "Copy operation failed."
        )

        # Remove items created by this operation.

        for destination in reversed(copied):
            try:
                if destination.is_dir():
                    shutil.rmtree(destination)
                elif destination.exists():
                    destination.unlink()
            except OSError:
                logger.exception(
                    "Could not clean up copied item: %s",
                    destination
                )

        raise HTTPException(
            status_code=500,
            detail="Copy failed. The operation was rolled back where possible."
        )

    return {
        "message": "Items copied successfully.",
        "copied": [
            get_relative_path(path)
            for path in copied
        ]
    }


# =====================================
# MOVE FILES AND FOLDERS
# =====================================

def get_document_paths_inside(source: Path):
    if source.is_file():
        if source.suffix.lower() in ALLOWED_EXTENSIONS:
            return [source]

        return []

    return [
        child
        for child in source.rglob("*")
        if (
            child.is_file()
            and child.suffix.lower() in ALLOWED_EXTENSIONS
        )
    ]


def update_moved_document_metadata(path_pairs):
    """
    Update ChromaDB and SQLite paths for moved documents.

    Returns snapshots that can be used to restore ChromaDB
    metadata if a later operation fails.
    """
    snapshots = []

    with get_metadata_connection() as connection:
        for old_path, new_path in path_pairs:
            records = collection.get(
                where={
                    "document_path": old_path
                },
                include=["metadatas"]
            )

            record_ids = records.get("ids") or []
            record_metadatas = records.get("metadatas") or []

            if record_ids:
                snapshots.append({
                    "ids": list(record_ids),
                    "metadatas": [
                        dict(metadata)
                        for metadata in record_metadatas
                    ]
                })

                updated_metadatas = []

                for metadata in record_metadatas:
                    updated = dict(metadata)
                    updated["document_path"] = new_path
                    updated["document_name"] = Path(new_path).name
                    updated_metadatas.append(updated)

                collection.update(
                    ids=record_ids,
                    metadatas=updated_metadatas
                )

            connection.execute(
                """
                UPDATE document_status
                SET path = ?,
                    updated_at = ?
                WHERE path = ?
                """,
                (
                    new_path,
                    datetime.now(timezone.utc).isoformat(),
                    old_path
                )
            )

    return snapshots


def restore_chroma_metadata(snapshots):
    for snapshot in reversed(snapshots):
        try:
            collection.update(
                ids=snapshot["ids"],
                metadatas=snapshot["metadatas"]
            )
        except Exception:
            logger.exception(
                "Could not restore ChromaDB metadata."
            )


@router.post("/documents/move")
def move_items(request: CopyMoveRequest):
    _, items = prepare_copy_move_items(
        request,
        "move"
    )

    moved = []
    completed_metadata_snapshots = []

    try:
        for item in items:
            source = item["source"]
            destination = item["destination"]

            document_files = get_document_paths_inside(
                source
            )

            path_pairs = []

            for old_file in document_files:
                old_relative = get_relative_path(old_file)

                new_file = (
                    destination / old_file.relative_to(source)
                    if source.is_dir()
                    else destination
                )

                new_relative = get_relative_path(new_file)

                path_pairs.append((
                    old_relative,
                    new_relative
                ))

            shutil.move(
                str(source),
                str(destination)
            )

            moved.append({
                "source": source,
                "destination": destination
            })

            snapshots = update_moved_document_metadata(
                path_pairs
            )

            completed_metadata_snapshots.extend(
                snapshots
            )

    except Exception:
        logger.exception(
            "Move operation failed."
        )

        # Restore ChromaDB metadata before moving files back.

        restore_chroma_metadata(
            completed_metadata_snapshots
        )

        # Move completed items back to their original locations.

        for item in reversed(moved):
            try:
                original_parent = item["source"].parent
                original_parent.mkdir(
                    parents=True,
                    exist_ok=True
                )

                if item["destination"].exists():
                    shutil.move(
                        str(item["destination"]),
                        str(item["source"])
                    )

            except Exception:
                logger.exception(
                    "Could not roll back moved item: %s",
                    item["destination"]
                )

        raise HTTPException(
            status_code=500,
            detail=(
                "Move failed. Rollback was attempted. "
                "Check backend logs if metadata or files are inconsistent."
            )
        )

    return {
        "message": "Items moved successfully.",
        "moved": [
            get_relative_path(item["destination"])
            for item in moved
        ]
    }


# =====================================
# PREVIEW DOCUMENT
# =====================================

@router.get("/documents/preview")
def preview_document(path: str = Query(...)):
    file_path = get_safe_path(path)
    validate_document(file_path)

    if file_path.stat().st_size > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Document is too large."
        )

    extracted_text = extract_document_text(file_path)

    if not extracted_text.strip():
        raise HTTPException(
            status_code=422,
            detail=(
                "No readable text was found in this document. "
                "It may be scanned or image-based."
            )
        )

    truncated = (
        len(extracted_text) > MAX_PREVIEW_CHARACTERS
    )

    if truncated:
        extracted_text = extracted_text[
            :MAX_PREVIEW_CHARACTERS
        ]

    status = get_document_status(path)

    return {
        "name": file_path.name,
        "extension": file_path.suffix.lower(),
        "text": extracted_text,
        "truncated": truncated,
        "character_count": len(extracted_text),
        "embedding_status": status["status"]
    }


# =====================================
# SOURCE TEXT MATCHING HELPERS
# =====================================

def normalize_source_text(text: str):
    return re.sub(
        r"\s+",
        " ",
        text or ""
    ).strip()


def valid_source_position(value):
    if value is None:
        return None

    try:
        value = int(value)
    except (TypeError, ValueError):
        return None

    return value if value >= 0 else None


# =====================================
# OPEN DOCUMENT AT CITED SOURCE
# =====================================

@router.get("/documents/source")
def get_document_source(
    path: str = Query(...),
    page: int | None = Query(default=None, ge=1),
    section: str | None = Query(default=None),
    chunk_index: int | None = Query(default=None, ge=0),
    line_start: int | None = Query(default=None, ge=1),
    line_end: int | None = Query(default=None, ge=1)
):
    file_path = get_safe_path(path)
    validate_document(file_path)

    if file_path.stat().st_size > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Document is too large."
        )

    current_hash = calculate_file_hash(file_path)
    units = extract_document_units(file_path)

    if not units:
        raise HTTPException(
            status_code=422,
            detail="No readable document content was found."
        )

    content_blocks = []

    for index, unit in enumerate(units):
        content_blocks.append({
            "block_index": index,
            "text": unit["text"],
            "page_number": unit["page_number"],
            "section_title": unit["section_title"],
            "line_start": unit["line_start"],
            "line_end": unit["line_end"],
            "is_source": False
        })

    source_chunk = None
    source_metadata = None

    try:
        records = collection.get(
            where={
                "document_path": path
            },
            include=[
                "documents",
                "metadatas"
            ]
        )

        record_metadatas = (
            records.get("metadatas") or []
        )
        record_documents = (
            records.get("documents") or []
        )

        for index, metadata in enumerate(
            record_metadatas
        ):
            if not metadata:
                continue

            # Ignore chunks from an older version of the file.

            if metadata.get("file_hash") != current_hash:
                continue

            matches = True

            if chunk_index is not None:
                matches = (
                    metadata.get("chunk_index") == chunk_index
                )

            elif page is not None:
                matches = (
                    metadata.get("page_number") == page
                )

            elif section is not None:
                matches = (
                    metadata.get("section_title") == section
                )

            elif line_start is not None:
                matches = (
                    metadata.get("line_start") == line_start
                )

            elif line_end is not None:
                matches = (
                    metadata.get("line_end") == line_end
                )

            if matches:
                source_metadata = metadata

                if index < len(record_documents):
                    source_chunk = record_documents[index]

                break

    except Exception:
        logger.exception(
            "Could not retrieve the cited document chunk: %s",
            path
        )

    # ---------------------------------
    # Find the corresponding content block
    # ---------------------------------

    target_block_index = None

    if source_chunk:
        normalized_chunk = normalize_source_text(
            source_chunk
        )

        if normalized_chunk:
            for block in content_blocks:
                normalized_block = normalize_source_text(
                    block["text"]
                )

                if normalized_chunk in normalized_block:
                    target_block_index = block["block_index"]
                    break

    # ---------------------------------
    # Metadata fallback
    # ---------------------------------

    if target_block_index is None and source_metadata:
        metadata_page = valid_source_position(
            source_metadata.get("page_number")
        )

        metadata_line_start = valid_source_position(
            source_metadata.get("line_start")
        )

        metadata_section = source_metadata.get(
            "section_title"
        )

        for block in content_blocks:
            if (
                metadata_page is not None
                and block["page_number"] == metadata_page
                and metadata_section
                and block["section_title"] == metadata_section
            ):
                target_block_index = block["block_index"]
                break

        if (
            target_block_index is None
            and metadata_line_start is not None
        ):
            for block in content_blocks:
                block_start = block["line_start"]
                block_end = block["line_end"]

                if (
                    block_start is not None
                    and block_end is not None
                    and block_start <= metadata_line_start <= block_end
                ):
                    target_block_index = block["block_index"]
                    break

        if target_block_index is None and metadata_section:
            for block in content_blocks:
                if block["section_title"] == metadata_section:
                    target_block_index = block["block_index"]
                    break

        if target_block_index is None and metadata_page is not None:
            for block in content_blocks:
                if block["page_number"] == metadata_page:
                    target_block_index = block["block_index"]
                    break

    # ---------------------------------
    # Request parameter fallback
    # ---------------------------------

    if target_block_index is None:
        for block in content_blocks:
            if (
                page is not None
                and block["page_number"] == page
            ):
                target_block_index = block["block_index"]
                break

            if (
                section
                and block["section_title"] == section
            ):
                target_block_index = block["block_index"]
                break

            if (
                line_start is not None
                and block["line_start"] is not None
                and block["line_start"] <= line_start
                and (
                    block["line_end"] is None
                    or block["line_end"] >= line_start
                )
            ):
                target_block_index = block["block_index"]
                break

    if target_block_index is not None:
        content_blocks[target_block_index]["is_source"] = True

    # ---------------------------------
    # Prepare source metadata
    # ---------------------------------

    if source_metadata:
        result_page = valid_source_position(
            source_metadata.get("page_number")
        )

        result_line_start = valid_source_position(
            source_metadata.get("line_start")
        )

        result_line_end = valid_source_position(
            source_metadata.get("line_end")
        )

        result_section = source_metadata.get(
            "section_title"
        )

        if result_section == "Document":
            result_section = None

        result_chunk_index = source_metadata.get(
            "chunk_index"
        )

    else:
        result_page = page
        result_line_start = line_start
        result_line_end = line_end
        result_section = section
        result_chunk_index = chunk_index

    return {
        "name": file_path.name,
        "document_name": file_path.name,
        "path": path,
        "extension": file_path.suffix.lower(),
        "content_blocks": content_blocks,
        "source": {
            "chunk_index": result_chunk_index,
            "chunk_text": source_chunk,
            "metadata": source_metadata,
            "page_number": result_page,
            "section_title": result_section,
            "line_start": result_line_start,
            "line_end": result_line_end,
            "target_block_index": target_block_index
        }
    }
