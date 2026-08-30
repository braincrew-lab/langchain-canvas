"""Reference FastAPI app exposing a canvas agent.

Run it:  uvicorn app.main:app --env-file .env --port 8005
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langgraph.checkpoint.memory import InMemorySaver

from .agent import render
from .agent.agent import create_canvas_server_agent
from .agent.configuration import config
from .routes import canvas, chat

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Build the compiled agent for the process's lifetime; release
    render's cached Chromium browser on shutdown.

    One agent per process; per-request state is keyed by ``thread_id``
    (see `app.state.agent` and `Depends(get_agent)` in `routes/chat.py`).
    """
    logging.basicConfig(level=logging.INFO)
    config.log_banner()
    app.state.agent = create_canvas_server_agent(checkpointer=InMemorySaver())
    yield
    try:
        render.shutdown_browser()
    except Exception:
        logger.warning("main: error shutting down cached browser", exc_info=True)


app = FastAPI(title="langchain-canvas server", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(canvas.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
