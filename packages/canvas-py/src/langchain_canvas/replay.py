"""Wire events for store commits — live emission and reload replay.

A store file maps to a wire artifact by its path suffix:

- ``.html``        → ``html`` artifact (the file is the page)
- ``.md``          → ``document`` artifact (the file is the markdown source;
  the title comes from the first ``# `` heading)
- ``.table.json``  → ``table`` artifact
- ``.chart.json``  → ``chart`` artifact
- ``.slides.json`` → ``slides`` artifact
- ``sources/*``    → text formats preview as document/html artifacts; every
  other upload becomes a ``file`` artifact (see :func:`source_preview_events`)

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

import base64
import io
import json
import mimetypes
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from .converters import (
    MissingConverterDependencyError,
    PageRenderable,
    SourceConverter,
    converter_for,
    default_converters,
)
from .protocol import Artifact, CanvasCommit, CanvasCreate, CanvasPatch, CanvasStatus
from .store import BinaryContentError, CanvasStore, CanvasStoreError, fold_history
from .table_merge import project_sheet_into_rows

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

def display_title(path: str) -> str:
    """What a person should read on the tab for a canvas file at ``path``.

    ``.slides.json`` says "this is a deck the canvas owns" to the store and
    the exporters; to the person looking at their presentation it says they
    are editing a JSON file. The machine keeps the path; the tab gets the
    name the file was given.
    """
    name = path.rsplit("/", 1)[-1]
    for suffix in ARTIFACT_SUFFIXES:
        if name.lower().endswith(suffix) and len(name) > len(suffix):
            return name[: -len(suffix)]
    return name


SOURCES_PREFIX = "sources/"
"""Store prefix for uploaded source files (the user's original material)."""

_SOURCE_PREVIEW_SUFFIXES: tuple[str, ...] = (".md", ".markdown", ".txt", ".json", ".html", ".htm")
#: Office files at the canvas root that open as tabs: the Word working copy
#: the document tools write, and any deck or workbook a host publishes there.
ROOT_FILE_SUFFIXES: tuple[str, ...] = (".docx", ".pptx", ".xlsx")


def _replayable(path: str) -> bool:
    """True when a committed path produces wire events on replay.

    Every upload under ``sources/`` does: text formats replay as editable-ish
    previews, everything else as a ``file`` artifact — the person who uploaded
    a file always sees it on the canvas.

    So does a document working copy at the canvas root. It is the file the
    user is having changed, it is drawn live the moment it is made, and the
    live builder and this one are the same by contract — leaving it out would
    make a reload lose exactly the file being worked on. Folders keep their
    own meaning: ``exports/`` is a download shelf and ``assets/`` is material
    other files reference, so neither opens as a tab.

    An office file a host's own tools publish at the root (a ``.pptx`` or
    ``.xlsx`` written by code, not only the Word working copy) is a
    deliverable too, so it replays the same way.
    """
    if path.startswith(SOURCES_PREFIX):
        return True
    if path.endswith(ARTIFACT_SUFFIXES):
        return True
    return "/" not in path and path.lower().endswith(ROOT_FILE_SUFFIXES)


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

    A table save with a grid editor state (``data["sheet"]``) also projects
    that state's data rectangle into ``rows`` before encoding, so stored
    rows always reflect what the person sees (typed formulas included, as
    their source text). See :mod:`langchain_canvas.table_merge`.
    """
    artifact_type = artifact.get("type")
    suffix = _ENVELOPE_SUFFIX_FOR.get(artifact_type) if isinstance(artifact_type, str) else None
    if artifact_type is None or suffix is None:
        allowed = ", ".join(sorted(_ENVELOPE_SUFFIX_FOR))
        raise ValueError(
            f"only {allowed} artifacts persist as JSON envelopes (got {artifact_type!r})"
        )
    if not isinstance(artifact.get("data"), dict):
        raise ValueError(f"{artifact_type} artifact needs a data object")
    if not path.endswith(suffix):
        raise ValueError(f"{artifact_type} path must end with {suffix}")
    data = artifact["data"]
    if artifact_type == "table" and data.get("sheet") and data.get("columns"):
        data = {
            **data,
            "rows": project_sheet_into_rows(data["columns"], data.get("rows") or [], data["sheet"]),
        }
    title = artifact.get("title")
    return _encode_envelope(artifact_type, title if isinstance(title, str) else path, data)


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
        # page/template ride along so the editor draws the deck's real page
        # (the create event carries them, but only for the first revision —
        # a later skin attach arrives as a patch).
        SLIDES_SUFFIX: ("slides", ("slides", "page", "template")),
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
                    title=title or display_title(path),
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


def source_preview_events(
    store: CanvasStore,
    canvas_id: str,
    path: str,
    *,
    is_new: bool,
    revision: str,
    description: str,
    converters: list[SourceConverter] | None = None,
) -> list[dict]:
    """Wire events showing one stored file at a revision.

    The single builder both replay (:func:`hydrate_events`) and a host's
    upload endpoint use, so the canvas drawn live at upload time and the one
    rebuilt on reload can never disagree. Text formats get the editable-ish
    preview; every other file becomes a ``file`` artifact — a card with
    whatever honest preview the installed converters can derive (page-one
    cover, text excerpt), or the bare facts (name, size, type) when nothing
    can be.

    Named for its first caller, uploads under ``sources/``; it takes any
    stored path, and the document tools use it for the working copies they
    write at the canvas root. ``converters`` lets a host put its own page
    renderer (an office-to-PDF service, say) ahead of the defaults so a deck
    or document gets a cover and a page grid; absent, the defaults apply.
    """
    # An uploaded workbook opens as an editable spreadsheet, not a file card:
    # `xlsx_to_sheets` is the twin of the browser's reader, so the grid a person
    # sees on upload matches an in-app import. A parse failure falls back to the
    # ordinary file preview rather than showing nothing.
    # Once a working copy exists the grid belongs to it — the upload steps
    # back to a card, or the person sees two grids and edits the one that
    # cannot save. Without a copy the upload still opens as a grid (hosts
    # that never call :func:`workbook_working_copy` keep today's behaviour).
    if path.lower().endswith(".xlsx") and not _has_working_copy(store, canvas_id, path):
        table_events = _table_preview_events(
            store, canvas_id, path, is_new=is_new, revision=revision, description=description
        )
        if table_events:
            return table_events
    if path.lower().endswith(_SOURCE_PREVIEW_SUFFIXES):
        try:
            content = store.read(canvas_id, path, revision=revision).content
        except BinaryContentError:
            pass  # text-suffixed upload that didn't decode — show it as a file
        except CanvasStoreError:
            return []
        else:
            return _source_preview_events(
                path, content, is_new=is_new, revision=revision, description=description
            )
    return _file_preview_events(
        store,
        canvas_id,
        path,
        is_new=is_new,
        revision=revision,
        description=description,
        converters=converters,
    )


def working_copy_path(source: str) -> str:
    """The canvas-root ``.table.json`` an uploaded workbook is edited through.

    ``sources/sales.xlsx`` -> ``sales.table.json``. One rule, spelled out
    once, so the upload door, the refusal that points at the copy, and the
    read header all name the same file.
    """
    name = source.rsplit("/", 1)[-1]
    stem = name[: -len(".xlsx")] if name.lower().endswith(".xlsx") else name
    return f"{stem}{TABLE_SUFFIX}"


def _has_working_copy(store: CanvasStore, canvas_id: str, source: str) -> bool:
    try:
        return any(info.path == working_copy_path(source) for info in store.list_files(canvas_id))
    except CanvasStoreError:
        return False


def workbook_working_copy(
    store: CanvasStore,
    canvas_id: str,
    source: str,
    *,
    actor: str,
) -> tuple[str, list[dict]] | None:
    """Land the editable copy of an uploaded workbook, with its wire events.

    Uploads under ``sources/`` are read-only, and a grid drawn straight from
    one can be typed into but never saved — the person's edits went to a
    shadow file with a mangled name, and the agent, refused at the source,
    rebuilt the table from scratch without its formatting or formulas. The
    copy is the file both of them work on: same sheets, fonts, fills,
    merges and formulas as the upload, at ``working_copy_path(source)``.

    Returns ``(path, events)``, or ``None`` when the copy already exists (it
    is the person's now — never overwritten) or the workbook does not parse
    (the upload stays a file card). Hosts call this right after landing the
    upload, so the copy's grid and the source's card arrive together.
    """
    from .xlsx_import import xlsx_to_sheets

    path = working_copy_path(source)
    if _has_working_copy(store, canvas_id, source):
        return None
    try:
        raw = store.read_bytes(canvas_id, source)
        parsed = xlsx_to_sheets(raw.data)
    except Exception:  # noqa: BLE001 — an unreadable workbook stays a file card
        return None
    data: dict[str, Any] = {
        "columns": parsed.get("columns", []),
        "rows": parsed.get("rows", []),
        "sheet": parsed.get("sheets", []),
    }
    content = encode_artifact({"type": "table", "title": display_title(path), "data": data}, path)
    commit = store.write(canvas_id, path, content, f"Working copy of {source}", actor=actor)
    events = events_for_commit(
        path, content, is_new=True, revision=commit.revision, description=commit.description
    )
    return path, events


def _table_preview_events(
    store: CanvasStore,
    canvas_id: str,
    path: str,
    *,
    is_new: bool,
    revision: str,
    description: str,
) -> list[dict]:
    """Wire events rendering an uploaded ``.xlsx`` as a ``table`` artifact.

    Reads the workbook with :func:`xlsx_to_sheets` (fonts, fills, formats,
    merges, images — the same model the browser builds) and lands it on the
    grid. Returns ``[]`` on any read/parse problem so the caller falls back to
    the plain file preview.
    """
    from .xlsx_import import xlsx_to_sheets

    try:
        raw = store.read_bytes(canvas_id, path, revision=revision)
    except CanvasStoreError:
        return []
    try:
        parsed = xlsx_to_sheets(raw.data)
    except Exception:  # noqa: BLE001 — any workbook problem degrades to a file card
        return []
    data: dict[str, Any] = {
        "columns": parsed.get("columns", []),
        "rows": parsed.get("rows", []),
        "sheet": parsed.get("sheets", []),
    }
    title = path.rsplit("/", 1)[-1]
    events: list[dict] = []
    if is_new:
        events.append(
            CanvasCreate(
                artifact=Artifact(id=path, type="table", title=title, data=data)
            ).model_dump(by_alias=True, exclude_none=True)
        )
        events.append(
            CanvasStatus(id=path, status="complete").model_dump(by_alias=True, exclude_none=True)
        )
    else:
        events.append(CanvasPatch(id=path, patch=data).model_dump(by_alias=True))
    events.append(
        CanvasCommit(id=path, description=description, revision=revision).model_dump(
            by_alias=True, exclude_none=True
        )
    )
    return events


_FILE_DATA_KEYS = ("path", "name", "mediaType", "size", "cover", "grids", "excerpt", "detail")

# Derived previews only — the stored file stays the truth. Bounded so a canvas
# with many uploads cannot grow the process without limit.
_PREVIEW_CACHE: OrderedDict[tuple[str, str, str, bool], dict[str, Any]] = OrderedDict()
_PREVIEW_CACHE_MAX = 128
#: Grid sheets kept per file preview (20 pages each).
_GRID_MAX_SHEETS = 4

_EXCERPT_MAX_CHARS = 400
_COVER_MAX_SIZE = (480, 640)


def _file_preview_events(
    store: CanvasStore,
    canvas_id: str,
    path: str,
    *,
    is_new: bool,
    revision: str,
    description: str,
    converters: list[SourceConverter] | None = None,
) -> list[dict]:
    """Wire events for one binary (or non-previewed) source file."""
    data = _file_preview_data(store, canvas_id, path, revision, converters)
    if data is None:
        return []
    events: list[dict] = []
    if is_new:
        events.append(
            CanvasCreate(
                artifact=Artifact(id=path, type="file", title=data["name"], data=data)
            ).model_dump(by_alias=True, exclude_none=True)
        )
        events.append(
            CanvasStatus(id=path, status="complete").model_dump(by_alias=True, exclude_none=True)
        )
    else:
        # Patch every key so a re-upload clears previews the new bytes lost
        # (mergePatch on the client deletes keys patched with null).
        events.append(
            CanvasPatch(id=path, patch={key: data.get(key) for key in _FILE_DATA_KEYS}).model_dump(
                by_alias=True
            )
        )
    events.append(
        CanvasCommit(id=path, description=description, revision=revision).model_dump(
            by_alias=True, exclude_none=True
        )
    )
    return events


def _file_preview_data(
    store: CanvasStore,
    canvas_id: str,
    path: str,
    revision: str,
    converters: list[SourceConverter] | None = None,
) -> dict[str, Any] | None:
    """The ``FileData`` payload for one stored file at a revision (cached).

    Previews step down honestly: a page-one cover (page-renderable sources),
    else a text excerpt through the source converter, else nothing beyond the
    file's bare facts. A derivation failure never blocks the card — showing
    the file's existence is the point; previews are a bonus.
    """
    active = converters if converters is not None else default_converters()
    # A host renderer derives more than the defaults do; keep the two apart.
    key = (canvas_id, path, revision, converters is not None)
    cached = _PREVIEW_CACHE.get(key)
    if cached is not None:
        _PREVIEW_CACHE.move_to_end(key)
        return dict(cached)
    try:
        got = store.read_bytes(canvas_id, path, revision=revision)
    except CanvasStoreError:
        return None
    name = path.rsplit("/", 1)[-1]
    media_type = mimetypes.guess_type(name)[0]
    data: dict[str, Any] = {
        "path": path,
        "name": name,
        "mediaType": media_type,
        "size": len(got.data),
        "cover": None,
        "grids": None,
        "excerpt": None,
        "detail": None,
    }
    # Images need no derived preview — the renderer shows the original bytes
    # straight from the store (one truth, nothing duplicated on the wire).
    if not (media_type or "").startswith("image/"):
        cover, detail = _derive_cover(path, got.data, active)
        data["cover"] = cover
        data["detail"] = detail
        if cover is not None:
            data["grids"] = _derive_grids(path, got.data, active)
        if cover is None:
            excerpt, fallback_detail = _derive_excerpt(path, got.data)
            data["excerpt"] = excerpt
            data["detail"] = detail or fallback_detail
    _PREVIEW_CACHE[key] = dict(data)
    while len(_PREVIEW_CACHE) > _PREVIEW_CACHE_MAX:
        _PREVIEW_CACHE.popitem(last=False)
    return data


def _derive_cover(
    path: str, data: bytes, converters: list[SourceConverter]
) -> tuple[str | None, str | None]:
    """(cover data-URI, detail line) via the page-render pipeline, or Nones.

    Reuses the same ``PageRenderable`` slot the agent's eye uses — one
    pipeline, two audiences. The full-size page-one render is shrunk to a
    card thumbnail here; sizing is this derivation layer's policy, so the
    converter contract stays untouched.
    """
    converter = converter_for(path, converters)
    if converter is None or not isinstance(converter, PageRenderable):
        return None, None
    try:
        converted = converter.render_pages(data, path=path, pages=[1])
        block = next(b for b in converted.blocks if b.get("type") == "image")
        png = base64.b64decode(block["data"])
        from PIL import Image  # the page render itself needed pillow already

        image = Image.open(io.BytesIO(png))
        image.thumbnail(_COVER_MAX_SIZE)
        out = io.BytesIO()
        image.convert("RGB").save(out, format="JPEG", quality=80)
        cover = "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()
    except Exception:  # noqa: BLE001 — a failed derivation degrades to the card
        return None, None
    pages = converted.metadata.get("pages")
    return cover, f"{pages} pages" if isinstance(pages, int) else None


def _derive_grids(
    path: str, data: bytes, converters: list[SourceConverter]
) -> list[str] | None:
    """Every page as labeled thumbnails tiled into grid sheets (data URIs), or None.

    The same ``render_grid`` the agent's eye uses for a deck overview, so what
    the file tab shows is exactly what the agent sees. Capped at
    ``_GRID_MAX_SHEETS`` sheets so a long document never floods the wire; a
    failure degrades to the cover alone.
    """
    converter = converter_for(path, converters)
    if converter is None or not isinstance(converter, PageRenderable):
        return None
    try:
        converted = converter.render_grid(data, path=path)
    except Exception:  # noqa: BLE001 — the grid is a bonus on the cover
        return None
    sheets = [
        "data:" + block.get("mime_type", "image/png") + ";base64," + block["data"]
        for block in converted.blocks
        if block.get("type") == "image" and block.get("data")
    ][:_GRID_MAX_SHEETS]
    return sheets or None


def _derive_excerpt(path: str, data: bytes) -> tuple[str | None, str | None]:
    """(text excerpt, detail line) via the source converter, or Nones.

    The same converter the agent reads through — what the card shows is a
    sample of exactly what the agent sees. Missing optional dependencies (an
    uninstalled extra) degrade to the bare card, honestly.
    """
    converter = converter_for(path, default_converters())
    if converter is None:
        return None, None
    try:
        converted = converter.convert(data, path=path)
    except MissingConverterDependencyError:
        return None, None
    except Exception:  # noqa: BLE001 — malformed bytes must not block the card
        return None, None
    text = "\n".join(
        str(block.get("text", "")) for block in converted.blocks if block.get("type") == "text"
    ).strip()
    excerpt = (text[:_EXCERPT_MAX_CHARS] + "…") if len(text) > _EXCERPT_MAX_CHARS else text
    detail = " · ".join(
        f"{value} {key}" if isinstance(value, int) else f"{key}: {value}"
        for key, value in converted.metadata.items()
    )
    return excerpt or None, (detail[:80] or None) if detail else None


def hydrate_events(
    store: CanvasStore,
    canvas_id: str,
    *,
    title_for: Callable[[str], str] | None = None,
    meta_for: Callable[[str], dict[str, Any] | None] | None = None,
    converters: list[SourceConverter] | None = None,
) -> list[dict]:
    """Wire events reconstructing a canvas from its history, oldest commit first.

    Every artifact file in the commit log (see :data:`ARTIFACT_SUFFIXES`)
    becomes a ``canvas.create`` (first appearance, followed by a ``complete``
    status) or a ``canvas.patch`` (later appearances), and each commit emits
    its ``canvas.commit`` so the client rebuilds the version history too.

    History is folded first (see :func:`~langchain_canvas.store.fold_history`),
    so a burst of small saves the writer grouped replays as the one version
    it reads as — the group's latest commit carries the whole file, so the
    canvas drawn is the same either way.

    ``title_for`` maps a file path to a display title (default: the path, or
    a table file's own title); ``meta_for`` maps a file path to renderer
    hints for its artifact (default: none). Both let the host app apply its
    own conventions — for example titling slide files from a deck manifest.
    """
    events: list[dict] = []
    seen: set[str] = set()
    for commit in reversed(fold_history(store.history(canvas_id))):  # oldest first
        for path in commit.paths:
            if not _replayable(path):
                continue
            if not path.endswith(ARTIFACT_SUFFIXES) or path.startswith(SOURCES_PREFIX):
                # Stored-file preview: uploads, and the document working copies
                # the tools leave at the canvas root.
                produced = source_preview_events(
                    store,
                    canvas_id,
                    path,
                    is_new=path not in seen,
                    revision=commit.revision,
                    description=commit.description,
                    converters=converters,
                )
            else:
                try:
                    content = store.read(canvas_id, path, revision=commit.revision).content
                except BinaryContentError:
                    continue  # binary bytes at an artifact suffix — nothing to draw
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
