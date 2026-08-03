"""Canvas persistence endpoints — hydrate on load, save human edits.

- ``GET /api/canvas/{thread_id}``: replay the stored history as wire events so
  a reloading client rebuilds the canvas (artifacts, snapshots, described
  versions) exactly as it was.
- ``POST /api/canvas/{thread_id}/save``: persist a hand edit as a described
  commit. ``base_revision`` makes a stale save a 409 instead of an overwrite.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from langchain_canvas import encode_table, hydrate_events
from langchain_canvas.replay import TABLE_SUFFIX
from langchain_canvas.store import CanvasFileNotFoundError, RevisionMismatchError

from ..agent.store import MANIFEST_PATH, PAGE_PATH, SLIDE_META, STORE

router = APIRouter()


def _slide_titles(thread_id: str) -> dict[str, str]:
    """file → title for every slide in the deck manifest (empty if no deck)."""
    try:
        manifest = json.loads(STORE.read(thread_id, MANIFEST_PATH).content)
    except (CanvasFileNotFoundError, ValueError):
        return {}
    return {s["file"]: s.get("title", s["file"]) for s in manifest.get("slides", [])}


@router.get("/api/canvas/{thread_id}")
def hydrate(thread_id: str) -> list[dict]:
    """Wire events reconstructing the thread's canvas, oldest commit first."""
    slides = _slide_titles(thread_id)
    return hydrate_events(
        STORE,
        thread_id,
        title_for=lambda path: slides.get(path, path),
        # A slide file re-renders at its fixed 16:9 ratio.
        meta_for=lambda path: SLIDE_META if path in slides else None,
    )


class SaveRequest(BaseModel):
    """One hand edit: raw ``html`` for a page, or a table ``artifact`` envelope."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    html: str | None = None
    artifact: dict | None = None
    base_revision: str | None = None
    description: str = "Manual edit"
    path: str = PAGE_PATH


def save_content(request: SaveRequest) -> str:
    """Store file content for the request, or raise 422 with an honest reason."""
    if (request.html is None) == (request.artifact is None):
        raise HTTPException(status_code=422, detail="provide exactly one of html or artifact")
    if request.html is not None:
        return request.html
    artifact = request.artifact or {}
    if artifact.get("type") != "table" or not isinstance(artifact.get("data"), dict):
        raise HTTPException(
            status_code=422, detail="only table artifacts persist today (type + data required)"
        )
    if not request.path.endswith(TABLE_SUFFIX):
        raise HTTPException(status_code=422, detail=f"table path must end with {TABLE_SUFFIX}")
    title = artifact.get("title")
    return encode_table(title if isinstance(title, str) else request.path, artifact["data"])


@router.post("/api/canvas/{thread_id}/save")
def save(thread_id: str, request: SaveRequest) -> dict:
    content = save_content(request)
    # A save that changes nothing is not a version (editors may re-serialize
    # unchanged state on mount — that must not spam the history on reloads).
    try:
        current = STORE.read(thread_id, request.path)
        if current.content == content:
            return {"revision": current.revision, "description": "No change", "changed": False}
    except CanvasFileNotFoundError:
        pass
    try:
        commit = STORE.write(
            thread_id,
            request.path,
            content,
            request.description,
            base_revision=request.base_revision,
            actor="human",
        )
    except RevisionMismatchError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"revision": commit.revision, "description": commit.description, "changed": True}
