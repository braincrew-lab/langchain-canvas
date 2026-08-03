"""Wire events for store commits — live emission and reload replay.

A store file maps to a wire artifact by its path suffix: ``.html`` files are
``html`` artifacts, ``.table.json`` files are ``table`` artifacts (a JSON
envelope of ``{"type": "table", "title": ..., "data": {columns, rows, sheet}}``,
written by the save endpoint and readable/editable by agents as plain JSON).
One commit maps to one small event sequence: a ``canvas.create``
(+ ``complete`` status) the first time the file appears, a ``canvas.patch``
on later changes, and always a ``canvas.commit``. :func:`events_for_commit`
builds that sequence; the standard tools emit it live during a run, and
:func:`hydrate_events` replays it from history when a client reloads — so
both paths draw the same canvas.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from .protocol import Artifact, CanvasCommit, CanvasCreate, CanvasPatch, CanvasStatus
from .store import CanvasStore

TABLE_SUFFIX = ".table.json"

ARTIFACT_SUFFIXES: tuple[str, ...] = (".html", TABLE_SUFFIX)
"""Store path suffixes that render as canvas artifacts (see module docstring)."""


def encode_table(title: str, data: dict[str, Any]) -> str:
    """The ``.table.json`` file content for one table artifact.

    ``data`` is the wire ``TableData`` shape (``columns`` / ``rows`` and the
    optional opaque ``sheet`` editor state). Pretty-printed so agents can read
    and target-edit the file like any other canvas file.
    """
    envelope = {"type": "table", "title": title, "data": data}
    return json.dumps(envelope, ensure_ascii=False, indent=2)


def _table_payload(content: str) -> tuple[str | None, dict[str, Any]] | None:
    """Parse a ``.table.json`` file into (title, data), or ``None`` if malformed.

    A hand- or agent-corrupted file must never break replay or broadcast; the
    caller skips the file until a later commit repairs it.
    """
    try:
        envelope = json.loads(content)
    except ValueError:
        return None
    if not isinstance(envelope, dict) or not isinstance(envelope.get("data"), dict):
        return None
    title = envelope.get("title")
    return (title if isinstance(title, str) else None, envelope["data"])


def events_for_commit(
    path: str,
    content: str,
    *,
    is_new: bool,
    revision: str,
    description: str,
    title: str | None = None,
    meta: dict[str, Any] | None = None,
) -> list[dict]:
    """The wire events one committed artifact-file change produces.

    First appearance (``is_new``): create + complete status; later changes:
    a whole-content patch. Both end with the described ``canvas.commit`` so
    the client records the version. Paths without an artifact mapping (see
    :data:`ARTIFACT_SUFFIXES`) — and malformed ``.table.json`` content —
    produce no events.
    """
    if path.endswith(TABLE_SUFFIX):
        payload = _table_payload(content)
        if payload is None:
            return []
        file_title, data = payload
        artifact_type = "table"
        artifact_data: dict[str, Any] = data
        # Patch every TableData key so a shrunk table doesn't keep stale state
        # (mergePatch on the client deletes keys patched with null).
        patch: dict[str, Any] = {key: data.get(key) for key in ("columns", "rows", "sheet")}
        # The file carries its own title (hosts' title_for conventions typically
        # fall back to the path, which must not shadow it).
        title = file_title or title
    elif path.endswith(".html"):
        artifact_type = "html"
        artifact_data = {"html": content}
        patch = {"html": content}
    else:
        return []

    events: list[dict] = []
    if is_new:
        events.append(
            CanvasCreate(
                artifact=Artifact(
                    id=path,
                    type=artifact_type,
                    title=title or path,
                    data=artifact_data,
                    meta=meta,
                )
            ).model_dump(by_alias=True, exclude_none=True)
        )
        events.append(
            CanvasStatus(id=path, status="complete").model_dump(by_alias=True, exclude_none=True)
        )
    else:
        events.append(CanvasPatch(id=path, patch=patch).model_dump(by_alias=True))
    events.append(
        CanvasCommit(id=path, description=description, revision=revision).model_dump(
            by_alias=True, exclude_none=True
        )
    )
    return events


def hydrate_events(
    store: CanvasStore,
    canvas_id: str,
    *,
    title_for: Callable[[str], str] | None = None,
    meta_for: Callable[[str], dict[str, Any] | None] | None = None,
) -> list[dict]:
    """Wire events reconstructing a canvas from its history, oldest commit first.

    Every artifact file in the commit log (see :data:`ARTIFACT_SUFFIXES`)
    becomes a ``canvas.create`` (first appearance, followed by a ``complete``
    status) or a ``canvas.patch`` (later appearances), and each commit emits
    its ``canvas.commit`` so the client rebuilds the version history too.

    ``title_for`` maps a file path to a display title (default: the path, or
    a table file's own title); ``meta_for`` maps a file path to renderer
    hints for its artifact (default: none). Both let the host app apply its
    own conventions — for example titling slide files from a deck manifest.
    """
    events: list[dict] = []
    seen: set[str] = set()
    for commit in reversed(store.history(canvas_id)):  # oldest first
        for path in commit.paths:
            if not path.endswith(ARTIFACT_SUFFIXES):
                continue
            content = store.read(canvas_id, path, revision=commit.revision).content
            produced = events_for_commit(
                path,
                content,
                is_new=path not in seen,
                revision=commit.revision,
                description=commit.description,
                title=title_for(path) if title_for else None,
                meta=meta_for(path) if meta_for else None,
            )
            if produced:
                events.extend(produced)
                seen.add(path)
    return events
