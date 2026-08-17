"""Wire events for store commits — live emission and reload replay.

A store file maps to a wire artifact by its path suffix:

- ``.html``        → ``html`` artifact (the file is the page)
- ``.md``          → ``document`` artifact (the file is the markdown source;
  the title comes from the first ``# `` heading)
- ``.table.json``  → ``table`` artifact
- ``.chart.json``  → ``chart`` artifact
- ``.slides.json`` → ``slides`` artifact

The three ``.json`` forms share one JSON envelope — ``{"type": ..., "title":
..., "data": ...}`` — written by the save endpoints / tools and
readable/editable by agents as plain JSON. Text-natured artifacts (pages,
documents) store their content raw so line-targeted edits stay possible.

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
from .store import BinaryContentError, CanvasStore

TABLE_SUFFIX = ".table.json"
CHART_SUFFIX = ".chart.json"
SLIDES_SUFFIX = ".slides.json"
DOCUMENT_SUFFIX = ".md"

ARTIFACT_SUFFIXES: tuple[str, ...] = (
    ".html",
    DOCUMENT_SUFFIX,
    TABLE_SUFFIX,
    CHART_SUFFIX,
    SLIDES_SUFFIX,
)
"""Store path suffixes that render as canvas artifacts (see module docstring)."""

_ENVELOPE_SUFFIX_FOR: dict[str, str] = {
    "table": TABLE_SUFFIX,
    "chart": CHART_SUFFIX,
    "slides": SLIDES_SUFFIX,
}

SOURCES_PREFIX = "sources/"
"""Store prefix for uploaded source files (the user's original material)."""

_SOURCE_PREVIEW_SUFFIXES: tuple[str, ...] = (".md", ".markdown", ".txt", ".json", ".html", ".htm")


def _replayable(path: str) -> bool:
    """True when a committed path produces wire events on replay."""
    if path.startswith(SOURCES_PREFIX):
        return path.lower().endswith(_SOURCE_PREVIEW_SUFFIXES)
    return path.endswith(ARTIFACT_SUFFIXES)


def _encode_envelope(artifact_type: str, title: str, data: dict[str, Any]) -> str:
    envelope = {"type": artifact_type, "title": title, "data": data}
    return json.dumps(envelope, ensure_ascii=False, indent=2)


def encode_table(title: str, data: dict[str, Any]) -> str:
    """The ``.table.json`` file content for one table artifact.

    ``data`` is the wire ``TableData`` shape (``columns`` / ``rows`` and the
    optional opaque ``sheet`` editor state). Pretty-printed so agents can read
    and target-edit the file like any other canvas file.
    """
    return _encode_envelope("table", title, data)


def encode_chart(title: str, data: dict[str, Any]) -> str:
    """The ``.chart.json`` file content for one chart artifact.

    ``data`` is the wire ``ChartData`` shape (``chart`` / ``xKey`` / ``series``
    / ``rows``, plus optional ``options`` / ``echartsOption``).
    """
    return _encode_envelope("chart", title, data)


def encode_slides(title: str, data: dict[str, Any]) -> str:
    """The ``.slides.json`` file content for one slides artifact.

    ``data`` is the wire ``SlidesData`` shape (``slides``).
    """
    return _encode_envelope("slides", title, data)


def encode_artifact(artifact: dict[str, Any], path: str) -> str:
    """Store file content for one structured-artifact save, validated.

    ``artifact`` is the ``{type, title?, data}`` envelope a client posts for a
    hand edit. Accepts the JSON-envelope types (table / chart / slides) and
    requires ``path`` to end with the matching suffix; raises ``ValueError``
    with an honest reason otherwise, so save endpoints can turn it into a 422.
    Document edits are plain text saves to a ``.md`` path — no envelope.
    """
    artifact_type = artifact.get("type")
    suffix = _ENVELOPE_SUFFIX_FOR.get(artifact_type) if isinstance(artifact_type, str) else None
    if artifact_type is None or suffix is None:
        allowed = ", ".join(sorted(_ENVELOPE_SUFFIX_FOR))
        raise ValueError(f"only {allowed} artifacts persist as JSON envelopes (got {artifact_type!r})")
    if not isinstance(artifact.get("data"), dict):
        raise ValueError(f"{artifact_type} artifact needs a data object")
    if not path.endswith(suffix):
        raise ValueError(f"{artifact_type} path must end with {suffix}")
    title = artifact.get("title")
    return _encode_envelope(artifact_type, title if isinstance(title, str) else path, artifact["data"])


def _envelope_payload(content: str) -> tuple[str | None, dict[str, Any]] | None:
    """Parse an artifact-envelope file into (title, data), or ``None`` if malformed.

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


def _document_title(content: str) -> str | None:
    """The first ``# `` heading of a markdown document, or ``None``."""
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip() or None
    return None


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
    :data:`ARTIFACT_SUFFIXES`) — and malformed envelope (``.table.json`` /
    ``.chart.json`` / ``.slides.json``) content — produce no events.
    """
    if path.startswith(SOURCES_PREFIX):
        return _source_preview_events(
            path, content, is_new=is_new, revision=revision, description=description
        )
    # Envelope types share one decode path; the patch lists every data key so a
    # shrunk payload doesn't keep stale state (mergePatch on the client deletes
    # keys patched with null).
    envelope_keys = {
        TABLE_SUFFIX: ("table", ("columns", "rows", "sheet")),
        CHART_SUFFIX: ("chart", ("chart", "rows", "xKey", "series", "options", "echartsOption")),
        SLIDES_SUFFIX: ("slides", ("slides",)),
    }
    envelope = next((v for suffix, v in envelope_keys.items() if path.endswith(suffix)), None)
    if envelope is not None:
        payload = _envelope_payload(content)
        if payload is None:
            return []
        file_title, data = payload
        artifact_type, patch_keys = envelope
        artifact_data: dict[str, Any] = data
        patch: dict[str, Any] = {key: data.get(key) for key in patch_keys}
        # The file carries its own title (hosts' title_for conventions typically
        # fall back to the path, which must not shadow it).
        title = file_title or title
    elif path.endswith(".html"):
        artifact_type = "html"
        artifact_data = {"html": content}
        patch = {"html": content}
    elif path.endswith(DOCUMENT_SUFFIX):
        artifact_type = "document"
        artifact_data = {"format": "markdown", "content": content}
        patch = {"content": content}
        title = _document_title(content) or title
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


def _source_preview_events(
    path: str, content: str, *, is_new: bool, revision: str, description: str
) -> list[dict]:
    """Wire events previewing a text source file (markdown/html/json).

    Uploads render read-only-ish previews so a reload shows what was opened:
    markdown-ish files as document artifacts, html as an html artifact, json
    as a fenced document. Table-like sources (csv/xlsx) get no preview here —
    the client persists a `.table.json` working copy at import time, which
    replays through the artifact path instead. Binary sources produce no
    events (they are the agent's reading material, not canvas renders).
    """
    lowered = path.lower()
    title = path.rsplit("/", 1)[-1]
    if lowered.endswith((".html", ".htm")):
        artifact_type = "html"
        data: dict[str, Any] = {"html": content}
        patch: dict[str, Any] = {"html": content}
    elif lowered.endswith(".json"):
        artifact_type = "document"
        fenced = f"```json\n{content}\n```"
        data = {"format": "markdown", "content": fenced}
        patch = {"content": fenced}
    elif lowered.endswith((".md", ".markdown", ".txt")):
        artifact_type = "document"
        data = {"format": "markdown", "content": content}
        patch = {"content": content}
    else:
        return []

    events: list[dict] = []
    if is_new:
        events.append(
            CanvasCreate(
                artifact=Artifact(id=path, type=artifact_type, title=title, data=data)
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
            if not _replayable(path):
                continue
            try:
                content = store.read(canvas_id, path, revision=commit.revision).content
            except BinaryContentError:
                continue  # a text-suffixed upload that didn't decode — no preview
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
