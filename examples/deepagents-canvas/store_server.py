"""Store sidecar — the small server a direct LangGraph setup still needs.

Chat goes browser → LangGraph directly (the web app uses
``langgraphTransport``), so there is no translation middleman here. What
cannot move into the browser is access to the canvas store on disk:

- ``GET  /api/canvas/{thread_id}``       — replay stored history (reloads)
- ``POST /api/canvas/{thread_id}/save``  — persist a hand edit as a commit

Both are a few lines over the SDK (``hydrate_events`` + ``store.write``).
This is also where an adopter would enforce authorization and multi-tenancy —
the store contract deliberately has no user concept, so the boundary belongs
to the app, not the SDK.

Run it:  uv run uvicorn store_server:app --port 8000
(alongside `uv run langgraph dev` on :2024 and the web app on :3000)
"""

from __future__ import annotations

import json
import os
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from langchain_canvas import hydrate_events
from langchain_canvas.store import CanvasFileNotFoundError, RevisionMismatchError

from agent import DATA_DIR, STORE  # the same on-disk store langgraph dev writes

MANIFEST_PATH = "manifest.json"
SLIDE_META = {"kind": "slide", "ratio": "16:9"}

app = FastAPI(title="deepagents-canvas store sidecar", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _thread_uuid(thread_id: str) -> str:
    """Match the langgraphTransport mapping: LangGraph requires UUID thread
    ids, so non-UUID ids map deterministically (uuid5 over ``canvas-thread:``)
    and the store is keyed by the mapped UUID on both paths.
    """
    try:
        return str(UUID(thread_id))
    except ValueError:
        return str(uuid5(NAMESPACE_URL, f"canvas-thread:{thread_id}"))


def _slide_titles(canvas_id: str) -> dict[str, str]:
    try:
        manifest = json.loads(STORE.read(canvas_id, MANIFEST_PATH).content)
    except (CanvasFileNotFoundError, ValueError):
        return {}
    return {s["file"]: s.get("title", s["file"]) for s in manifest.get("slides", [])}


@app.get("/api/canvas/{thread_id}")
def hydrate(thread_id: str) -> list[dict]:
    canvas_id = _thread_uuid(thread_id)
    slides = _slide_titles(canvas_id)
    return hydrate_events(
        STORE,
        canvas_id,
        title_for=lambda path: slides.get(path, path),
        meta_for=lambda path: SLIDE_META if path in slides else None,
    )


class SaveRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    html: str
    base_revision: str | None = None
    description: str = "Manual edit"
    path: str


@app.post("/api/canvas/{thread_id}/save")
def save(thread_id: str, request: SaveRequest) -> dict:
    try:
        commit = STORE.write(
            _thread_uuid(thread_id),
            request.path,
            request.html,
            request.description,
            base_revision=request.base_revision,
            actor="human",
        )
    except RevisionMismatchError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"revision": commit.revision, "description": commit.description}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "store": str(DATA_DIR)}
