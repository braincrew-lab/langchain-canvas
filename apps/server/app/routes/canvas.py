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

from langchain_canvas import hydrate_events
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
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    html: str
    base_revision: str | None = None
    description: str = "Manual edit"
    path: str = PAGE_PATH


@router.post("/api/canvas/{thread_id}/save")
def save(thread_id: str, request: SaveRequest) -> dict:
    try:
        commit = STORE.write(
            thread_id,
            request.path,
            request.html,
            request.description,
            base_revision=request.base_revision,
            actor="human",
        )
    except RevisionMismatchError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"revision": commit.revision, "description": commit.description}
