import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .service import (
    get_available_models,
    generate_answer
)


router = APIRouter()
logger = logging.getLogger(__name__)


# =====================================
# MESSAGE STRUCTURE
# =====================================

class ChatMessage(BaseModel):

    role: Literal["user", "assistant"]

    content: str = Field(
        min_length=1,
        max_length=20000
    )


# =====================================
# CHAT REQUEST
# =====================================

class ChatRequest(BaseModel):

    model: str = Field(
        min_length=1
    )

    messages: list[ChatMessage] = Field(
        min_length=1,
        max_length=40
    )


# =====================================
# GET AVAILABLE MODELS
# =====================================

@router.get("/models")
def models():

    try:
        return get_available_models()

    except Exception:

        logger.exception("Model retrieval failed")

        raise HTTPException(
            status_code=502,
            detail="Could not retrieve available models."
        )


# =====================================
# SEND CHAT MESSAGE
# =====================================

@router.post("/chat")
def chat(request: ChatRequest):

    if request.messages[-1].role != "user":

        raise HTTPException(
            status_code=400,
            detail="The last message must be from the user."
        )

    messages = [
        {
            "role": message.role,
            "content": message.content
        }
        for message in request.messages
    ]

    try:

        result = generate_answer(
            messages=messages,
            model=request.model
        )

        return {
            "answer": result["answer"],
            "model": request.model,
            "sources": result.get("sources", [])
        }

    except ValueError as error:

        raise HTTPException(
            status_code=400,
            detail=str(error)
        )

    except Exception:

        logger.exception("Chat generation failed")

        raise HTTPException(
            status_code=502,
            detail="The AI could not generate a response."
        )
