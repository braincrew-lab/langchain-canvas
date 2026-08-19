"""Canvas persistence endpoints — hydrate on load, save human edits, uploads.

- ``GET /api/canvas/{thread_id}``: replay the stored history as wire events so
  a reloading client rebuilds the canvas (artifacts, snapshots, described
  versions) exactly as it was.
- ``POST /api/canvas/{thread_id}/save``: persist a hand edit as a described
  commit. ``base_revision`` makes a stale save a 409 instead of an overwrite.
- ``POST /api/canvas/{thread_id}/upload``: land a user file in the store under
  ``sources/`` so the agent can read it.
- ``GET /api/canvas/{thread_id}/files``: the store's file listing.
- ``GET /api/canvas/{thread_id}/file``: one file's bytes, as a download.
"""

from __future__ import annotations

import json
import mimetypes
from pathlib import PurePosixPath
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from langchain_canvas import encode_artifact, hydrate_events
from langchain_canvas.replay import SOURCES_PREFIX
from langchain_canvas.store import (
    CanvasFileNotFoundError,
    CanvasStoreError,
    RevisionMismatchError,
)

from ..agent.store import MANIFEST_PATH, PAGE_PATH, SLIDE_META, STORE

_TEXT_UPLOAD_SUFFIXES = (".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm")

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
    """One hand edit: raw ``html`` for a page, ``text`` for a document/source
    file, or a structured ``artifact`` envelope (table / chart / slides)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    html: str | None = None
    text: str | None = None
    artifact: dict | None = None
    base_revision: str | None = None
    description: str = "Manual edit"
    path: str = PAGE_PATH


def save_content(request: SaveRequest) -> str:
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
    try:
        return encode_artifact(request.artifact or {}, request.path)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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


@router.post("/api/canvas/{thread_id}/upload")
async def upload(thread_id: str, file: UploadFile) -> dict:
    """Land one user file in the store under ``sources/``.

    Text formats are stored as text (so agents read them directly and
    reloads can preview them); everything else is stored as raw bytes for
    the format converters. Authorization and size limits are the adopter's
    boundary, same as the save endpoint.
    """
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
        commit = STORE.write(thread_id, path, text, description, actor="human")
    else:
        commit = STORE.write_bytes(thread_id, path, data, description, actor="human")
    return {"path": path, "revision": commit.revision}


@router.get("/api/canvas/{thread_id}/files")
def files(thread_id: str) -> dict:
    """The canvas's current files (path + size), sources included."""
    return {"files": [info.model_dump() for info in STORE.list_files(thread_id)]}


@router.get("/api/canvas/{thread_id}/file")
def file_download(thread_id: str, path: str) -> Response:
    """One stored file's raw bytes (downloads, and the asset display endpoint).

    Traversal safety lives in the store contract (`validate_relpath`, pinned by
    the contract tests) — a hostile ``path`` surfaces here as a clean 400, not
    file contents.
    """
    try:
        got = STORE.read_bytes(thread_id, path)
    except CanvasFileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except CanvasStoreError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    name = PurePosixPath(path).name
    ascii_name = name.encode("ascii", "ignore").decode() or "download"
    return Response(
        content=got.data,
        media_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(name)}'
            )
        },
    )
