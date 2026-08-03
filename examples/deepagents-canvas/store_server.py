"""Store sidecar — the small server a direct LangGraph setup still needs.

Chat goes browser → LangGraph directly (the web app uses
``langgraphTransport``), so there is no translation middleman here. What
cannot move into the browser is access to the canvas store on disk:

- ``GET  /api/canvas/{thread_id}``        — replay stored history (reloads)
- ``POST /api/canvas/{thread_id}/save``   — persist a hand edit as a commit
- ``POST /api/canvas/{thread_id}/upload`` — land a user file under ``sources/``
- ``GET  /api/canvas/{thread_id}/files``  — the store's file listing

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
from pathlib import PurePosixPath
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from langchain_canvas import encode_table, hydrate_events
from langchain_canvas.replay import SOURCES_PREFIX, TABLE_SUFFIX
from langchain_canvas.store import CanvasFileNotFoundError, RevisionMismatchError

_TEXT_UPLOAD_SUFFIXES = (".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm")

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
    """One hand edit: raw ``html`` for a page, or a table ``artifact`` envelope."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    html: str | None = None
    text: str | None = None
    artifact: dict | None = None
    base_revision: str | None = None
    description: str = "Manual edit"
    path: str


def _save_content(request: SaveRequest) -> str:
    """Store file content for the request, or raise 422 with an honest reason."""
    given = [v for v in (request.html, request.text, request.artifact) if v is not None]
    if len(given) != 1:
        raise HTTPException(
            status_code=422, detail="provide exactly one of html, text, or artifact"
        )
    if request.html is not None:
        return request.html
    if request.text is not None:
        return request.text
    artifact = request.artifact or {}
    if artifact.get("type") != "table" or not isinstance(artifact.get("data"), dict):
        raise HTTPException(
            status_code=422, detail="only table artifacts persist today (type + data required)"
        )
    if not request.path.endswith(TABLE_SUFFIX):
        raise HTTPException(status_code=422, detail=f"table path must end with {TABLE_SUFFIX}")
    title = artifact.get("title")
    return encode_table(title if isinstance(title, str) else request.path, artifact["data"])


@app.post("/api/canvas/{thread_id}/save")
def save(thread_id: str, request: SaveRequest) -> dict:
    canvas_id = _thread_uuid(thread_id)
    content = _save_content(request)
    # A save that changes nothing is not a version (editors may re-serialize
    # unchanged state on mount — that must not spam the history on reloads).
    try:
        current = STORE.read(canvas_id, request.path)
        if current.content == content:
            return {"revision": current.revision, "description": "No change", "changed": False}
    except CanvasFileNotFoundError:
        pass
    try:
        commit = STORE.write(
            canvas_id,
            request.path,
            content,
            request.description,
            base_revision=request.base_revision,
            actor="human",
        )
    except RevisionMismatchError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"revision": commit.revision, "description": commit.description, "changed": True}


@app.post("/api/canvas/{thread_id}/upload")
async def upload(thread_id: str, file: UploadFile) -> dict:
    """Land one user file in the store under ``sources/``.

    Text formats are stored as text (agents read them directly, reloads can
    preview them); everything else is stored as raw bytes for the format
    converters.
    """
    canvas_id = _thread_uuid(thread_id)
    name = PurePosixPath(file.filename or "upload").name
    path = f"{SOURCES_PREFIX}{name}"
    data = await file.read()
    text: str | None = None
    if name.lower().endswith(_TEXT_UPLOAD_SUFFIXES):
        for encoding in ("utf-8-sig", "cp949"):
            try:
                text = data.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
    description = f"Upload {name}"
    if text is not None:
        commit = STORE.write(canvas_id, path, text, description, actor="human")
    else:
        commit = STORE.write_bytes(canvas_id, path, data, description, actor="human")
    return {"path": path, "revision": commit.revision}


@app.get("/api/canvas/{thread_id}/files")
def files(thread_id: str) -> dict:
    """The canvas's current files (path + size), sources included."""
    return {"files": [info.model_dump() for info in STORE.list_files(_thread_uuid(thread_id))]}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "store": str(DATA_DIR)}
