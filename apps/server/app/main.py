"""Reference FastAPI app exposing a canvas agent.

Run it:  uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

# Load apps/server/.env before anything reads ANTHROPIC_API_KEY / CORS_ORIGINS.
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes import canvas, chat

app = FastAPI(title="langchain-canvas server", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(canvas.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
