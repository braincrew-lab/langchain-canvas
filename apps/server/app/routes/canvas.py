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
- ``POST /api/canvas/{thread_id}/export``: convert one canvas file into an
  office format (deck → ``.pptx``, table → ``.xlsx``) through the same
  exporters the agent's ``export_canvas`` tool uses.
"""

from __future__ import annotations

import mimetypes
from pathlib import PurePosixPath
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response
from langchain_canvas import (
    encode_artifact,
    hydrate_events,
    source_preview_events,
    workbook_working_copy,
)
from langchain_canvas.assets import inline_canvas_assets
from langchain_canvas.exporters import (
    MissingExporterDependencyError,
    exporter_for,
)
from langchain_canvas.replay import SOURCES_PREFIX
from langchain_canvas.store import (
    CanvasFileNotFoundError,
    CanvasStoreError,
    RevisionMismatchError,
)
from langchain_canvas.tools import inline_deck_skin
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from ..agent.exports import app_exporters
from ..agent.store import PAGE_PATH, STORE

_TEXT_UPLOAD_SUFFIXES = (".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm")

router = APIRouter()


@router.get("/api/canvas/{thread_id}")
def hydrate(thread_id: str) -> list[dict]:
    """Wire events reconstructing the thread's canvas, oldest commit first."""
    return hydrate_events(STORE, thread_id)


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

    The response carries the wire ``events`` that show the upload on the
    canvas right away — built by the same function replay uses, so what the
    uploader sees now and what a reload rebuilds can never disagree.
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
    existed = any(info.path == path for info in STORE.list_files(thread_id))
    description = f"Upload {name}"
    if text is not None:
        commit = STORE.write(thread_id, path, text, description, actor="human")
    else:
        commit = STORE.write_bytes(thread_id, path, data, description, actor="human")
    # A workbook gets its editable copy right away; with the copy on the
    # canvas the upload itself shows as a card (see workbook_working_copy).
    copy_events: list[dict] = []
    if name.lower().endswith(".xlsx"):
        landed = workbook_working_copy(STORE, thread_id, path, actor="human")
        copy_events = landed[1] if landed else []
    events = source_preview_events(
        STORE,
        thread_id,
        path,
        is_new=not existed,
        revision=commit.revision,
        description=description,
    )
    return {"path": path, "revision": commit.revision, "events": [*events, *copy_events]}


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


class ExportRequest(BaseModel):
    """One office export: the canvas ``path`` routes to an exporter by suffix
    (``.slides.html`` → pptx, ``.table.json`` → xlsx); ``content`` carries the
    client's current copy so unsaved edits export too — omitted, the stored
    file is read instead."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    path: str
    target: str
    content: str | None = None
    title: str | None = None


@router.post("/api/canvas/{thread_id}/export")
def export(thread_id: str, request: ExportRequest) -> Response:
    """Convert one canvas file into a downloadable office format.

    The browser's export menu has no PPTX/XLSX writer of its own — decks and
    workbooks convert here, through the exact exporters the agent's
    ``export_canvas`` tool uses, so both doors produce the same file.
    """
    exporter = exporter_for(request.path, request.target, app_exporters())
    if exporter is None:
        raise HTTPException(
            status_code=422,
            detail=f"no exporter converts {request.path} to {request.target}",
        )
    content = request.content
    if content is None:
        try:
            content = STORE.read(thread_id, request.path).content
        except CanvasFileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except CanvasStoreError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        if request.path.lower().endswith(".slides.html"):
            content = inline_canvas_assets(content, STORE, thread_id)
            content = inline_deck_skin(content, STORE, thread_id)
        exported = exporter.export(content, path=request.path, title=request.title)
    except MissingExporterDependencyError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    ascii_name = exported.filename.encode("ascii", "ignore").decode() or "export"
    return Response(
        content=exported.data,
        media_type=exported.media_type,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(exported.filename)}"
            )
        },
    )
