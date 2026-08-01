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

from langchain_canvas.protocol import (
    Artifact,
    CanvasCommit,
    CanvasCreate,
    CanvasPatch,
    CanvasStatus,
)
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
    commits = list(reversed(STORE.history(thread_id)))  # oldest first
    slides = _slide_titles(thread_id)
    events: list[dict] = []
    seen: set[str] = set()
    for commit in commits:
        for path in commit.paths:
            if not path.endswith(".html"):
                continue
            content = STORE.read(thread_id, path, revision=commit.revision).content
            if path not in seen:
                seen.add(path)
                events.append(
                    CanvasCreate(
                        artifact=Artifact(
                            id=path,
                            type="html",
                            title=slides.get(path, path),
                            data={"html": content},
                            # A slide file re-renders at its fixed 16:9 ratio.
                            meta=SLIDE_META if path in slides else None,
                        )
                    ).model_dump(by_alias=True, exclude_none=True)
                )
                events.append(
                    CanvasStatus(id=path, status="complete").model_dump(
                        by_alias=True, exclude_none=True
                    )
                )
            else:
                events.append(
                    CanvasPatch(id=path, patch={"html": content}).model_dump(
                        by_alias=True, exclude_none=True
                    )
                )
            events.append(
                CanvasCommit(
                    id=path, description=commit.description, revision=commit.revision
                ).model_dump(by_alias=True, exclude_none=True)
            )
    return events


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
        )
    except RevisionMismatchError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"revision": commit.revision, "description": commit.description}
