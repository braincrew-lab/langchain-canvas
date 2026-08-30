"""Standard canvas tools — the agent's hands on a persistent canvas.

Four file-level primitives over a :class:`~langchain_canvas.store.CanvasStore`:

- ``read_canvas``  — file content with line numbers + the current revision
- ``write_canvas`` — create or fully replace a file
- ``edit_canvas``  — replace one unique occurrence, **requires the revision
  returned by a prior read** (read-before-update enforced by the contract,
  not by prompt discipline)
- ``list_canvas_files`` — files currently on the canvas

The tools persist through the store **and** broadcast each committed
artifact-file change (``.html`` pages, ``.table.json`` tables) as wire events
(``canvas.create``/``patch``/``commit``) through the run's stream writer, so a
connected client redraws live. Without a stream
writer (unit tests, plain scripts) the broadcast is a silent no-op — same
contract as :class:`~langchain_canvas.emitter.Canvas`. Which canvas they act
on is resolved per call: ``canvas_id`` in the runtime context (or
``configurable``), falling back to ``thread_id`` — by default a thread and
its canvas are the same scope.

Build them with :func:`create_canvas_tools`, which closes over your store::

    store = InMemoryCanvasStore()
    agent = create_canvas_agent(model, tools=create_canvas_tools(store))
"""

from __future__ import annotations

import base64
import binascii
import html as html_lib
import json
import re
import subprocess
from collections.abc import Callable, Sequence
from typing import Any

from langchain.tools import ToolRuntime, tool

from .assets import (
    ASSET_IMAGE_MIME,
    ASSETS_PREFIX,
    inline_canvas_assets,
    normalize_asset_reference,
)
from .converters import (
    MAX_IMAGES_PER_CALL,
    MissingConverterDependencyError,
    PageRenderable,
    SourceConverter,
    UnsafeArchiveError,
    converter_for,
    default_converters,
)
from .deck import (
    SLIDES_HTML_SUFFIX,
    Deck,
    DeckParseError,
    PptxImportError,
    SlideTemplate,
    baseline_slide_html,
    extract_slides,
    format_layout_warnings,
    parse_deck,
    patch_slide,
    read_slide,
    sanitize_slide_html,
    serialize_deck,
    validate_deck,
    validate_slide_html,
)
from .document_lint import (
    format_document_warnings,
    is_document_path,
    lint_document_content,
)
from .document_ops import (
    DOCUMENT_OP_SUFFIXES,
    DocumentOpError,
    MissingDocumentDependencyError,
    insert_image,
    insert_paragraph,
    remove_paragraph,
    reopens,
    replace_image,
    replace_text,
)
from .exporters import (
    PPTX_MIME,
    Exporter,
    MissingExporterDependencyError,
    default_exporters,
    exporter_for,
    pptx_page_size_inches,
)
from .formulas import SUPPORTED_FORMULA_FUNCTIONS, formula_guidance
from .protocol.artifacts import TableData
from .protocol.events import CanvasCommit, CanvasSlidePatch, SlideStatus
from .replay import (
    ARTIFACT_SUFFIXES,
    TABLE_SUFFIX,
    display_title,
    encode_artifact,
    events_for_commit,
    source_preview_events,
    working_copy_path,
)
from .state import last_change_line
from .store import (
    BinaryContentError,
    CanvasFileNotFoundError,
    CanvasStore,
    CanvasStoreError,
    Commit,
    EditConflictError,
    RevisionMismatchError,
)
from .table_outline import add_sheet as table_add_sheet
from .table_outline import table_view
from .table_outline import write_cells as table_write_cells

_RETRY_HINT = "Call read_canvas again and retry with the fresh revision and exact content."
_SOURCES_PREFIX = "sources/"
_SOURCES_READONLY = (
    "Error: files under sources/ are the user's original uploads and are "
    "read-only for the agent. Create a new canvas file instead (for example "
    "an .html page or a .table.json table)."
)
_SOURCES_READONLY_DOCUMENT = (
    "Error: {path} is the user's original upload and is read-only. Call "
    "open_document_for_editing on it first, then edit the copy it makes."
)
_SOURCES_READONLY_DECK = (
    "Error: {path} is the user's original upload and is read-only. Call "
    "open_deck_for_editing on it first, then edit the copy it makes."
)
_SOURCES_READONLY_WORKBOOK = (
    "Error: {path} is the user's original upload and is read-only. Its editable "
    'working copy is {copy} — read that with sheet="s0", then change cells with '
    "write_table_cells. Do not rebuild it with write_canvas."
)
_DEFAULT_READ_LIMIT = 400


def _with_eye(text: str, images: list[dict]) -> str | list[dict]:
    """The tool reply as text, or text followed by page images when there are any."""
    if not images:
        return text
    return [{"type": "text", "text": text}, *images]
_DOCUMENT_FORMATS = ", ".join(DOCUMENT_OP_SUFFIXES)


def _is_document_file(path: str) -> bool:
    """Whether these are the binary documents the document operations edit."""
    return path.lower().endswith(DOCUMENT_OP_SUFFIXES)


def _other_ways_to_open(path: str, converters: list[SourceConverter]) -> str:
    """What to do with a file the document operations cannot open.

    A deck is the case that matters: there is no import from ``.pptx`` to a
    slides artifact yet, and an agent told only "this opens .docx" tends to
    invent a summary instead of saying so. Name the reads that do work —
    pages as images where a renderer covers the format, text otherwise — so
    the answer is a next step rather than a dead end.
    """
    if path.lower().endswith(".pptx"):
        return (
            f"To edit it, copy it out with open_deck_for_editing (it becomes a "
            f"{SLIDES_HTML_SUFFIX} deck you can edit and export back to PowerPoint). "
            f"To just look, read {path} — with `pages` for the slide images."
        )
    if any(
        isinstance(c, PageRenderable) and path.lower().endswith(c.suffixes)
        for c in converters
    ):
        return (
            f"Read {path} with `pages` to see it as images (or without `pages` "
            "for its text) — it stays a source file either way. Text canvas "
            "files are already editable: read one and use edit_canvas."
        )
    return (
        "Text canvas files are already editable — read one and use edit_canvas."
    )


_WORKING_COPY_MARKER = "Editing - "


# Markdown image syntax: `![alt](path)`. A Word file has no such shorthand and
# shows it as the literal characters, so a paragraph carrying one is refused
# and told where the picture goes instead.
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")

def _working_copy_name(source: str) -> str:
    """Canvas-root name for the editable copy of ``source``.

    The copy and the original are the same document, so nothing in the name
    itself tells them apart — the marker does. It goes in front because tabs
    show as much of a name as fits and clip the rest, and these names are
    long; a mark at the end would be the first thing to disappear. Copying a
    copy does not stack markers.
    """
    name = source.rsplit("/", 1)[-1]
    return name if name.startswith(_WORKING_COPY_MARKER) else _WORKING_COPY_MARKER + name


# An inline picture the deck reader hands over, by the four types it emits.
_IMAGE_DATA_URI = re.compile(r"^data:(image/(?:png|jpeg|gif|webp));base64,(.+)$", re.DOTALL)
_SUFFIX_FOR_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def _decode_image_data_uri(src: Any) -> tuple[str, bytes] | None:
    """(file suffix, bytes) for an inline image; ``None`` for anything else."""
    if not isinstance(src, str):
        return None
    match = _IMAGE_DATA_URI.match(src)
    if match is None:
        return None
    try:
        blob = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        return None
    return _SUFFIX_FOR_MIME[match.group(1)], blob



def _deck_copy_name(source: str) -> str:
    """Canvas-root name for the editable deck made from ``source``.

    The copy is a different kind of file from the upload — a deck the canvas
    owns, not a PowerPoint document — so it takes the suffix that says so
    rather than a marker on the same name.
    """
    name = source.rsplit("/", 1)[-1]
    stem = name[: -len(".pptx")] if name.lower().endswith(".pptx") else name
    return f"{stem}{SLIDES_HTML_SUFFIX}"


def _sources_readonly(path: str) -> str:
    """The refusal for an upload, naming the way forward for this file type.

    A Word file has one — copy it and edit the copy — and pointing at .html
    pages instead would be telling the agent it cannot do something it can.
    """
    if _is_document_file(path):
        return _SOURCES_READONLY_DOCUMENT.format(path=path)
    if path.lower().endswith(".pptx"):
        return _SOURCES_READONLY_DECK.format(path=path)
    if path.lower().endswith(".xlsx"):
        return _SOURCES_READONLY_WORKBOOK.format(path=path, copy=working_copy_path(path))
    return _SOURCES_READONLY


def _renderer_for(path: str, converters: list[SourceConverter]) -> PageRenderable | None:
    converter = converter_for(path, converters)
    return converter if isinstance(converter, PageRenderable) else None


def _verified(data: bytes, path: str, converters: list[SourceConverter]) -> str:
    """"" when the edited bytes pass every check, else why they did not.

    Two checks beyond the save-time one every file already gets: the result
    still opens as a document, and it still renders. A document that parses
    but no longer draws is exactly the failure a user finds by opening the
    file, and the caller refuses to save on either — an edit that cannot be
    seen is not an edit that gets reported as done.
    """
    problem = reopens(data)
    if problem is not None:
        return f"Error: the edit did not save — the result no longer opens ({problem})."
    renderer = _renderer_for(path, converters)
    if renderer is None:
        return ""
    try:
        renderer.render_pages(data, path=path, pages=[1])
    except Exception as exc:  # any renderer failure blocks the save
        return (
            f"Error: the edit did not save — the result no longer renders ({exc}). "
            "The file on the canvas is unchanged."
        )
    return ""


def _look_note(path: str, converters: list[SourceConverter]) -> str:
    """The instruction to actually look at what was just written."""
    if _renderer_for(path, converters) is None:
        return (
            " No page renderer is installed here, so the result was reopened but "
            "not seen — check it yourself before telling the user it is done."
        )
    return (
        f' Look at it before telling the user it is done: read_canvas(path="{path}", '
        'pages="grid").'
    )


def _broadcast_source(
    store: CanvasStore,
    runtime: ToolRuntime,
    canvas_id: str,
    path: str,
    is_new: bool,
    commit: Commit,
) -> None:
    """Push the file's card to a connected client (silent without a writer)."""
    writer = getattr(runtime, "stream_writer", None)
    if writer is None:
        return
    for event in source_preview_events(
        store,
        canvas_id,
        path,
        is_new=is_new,
        revision=commit.revision,
        description=commit.description,
    ):
        writer(event)


def _save_document(
    store: CanvasStore,
    runtime: ToolRuntime,
    canvas_id: str,
    path: str,
    data: bytes,
    description: str,
    revision: str,
    *,
    converters: list[SourceConverter],
    verb: str,
    note: str = "",
) -> str:
    """Check the edited bytes, save them, redraw the card, say what to look at.

    The order is the point: a result that no longer opens or no longer renders
    never reaches the store, so "saved" and "still a document" cannot come
    apart. The save itself keeps the read-before-write contract every other
    write keeps — a stale ``revision`` is refused, not overwritten.
    """
    problem = _verified(data, path, converters)
    if problem:
        return problem
    try:
        commit = store.write_bytes(
            canvas_id, path, data, description, base_revision=revision, actor="agent"
        )
    except RevisionMismatchError as exc:
        return f"Error: {exc}. {_RETRY_HINT}"
    except CanvasStoreError as exc:
        return f"Error: {exc}."
    _broadcast_source(store, runtime, canvas_id, path, False, commit)
    return f"{verb} {path} (revision {commit.revision}).{note}" + _look_note(path, converters)


def _canvas_id(runtime: ToolRuntime) -> str:
    """Resolve the target canvas for this call.

    Precedence: explicit ``canvas_id`` in the runtime context (attribute or
    mapping key), then ``configurable.canvas_id``, then ``configurable.thread_id``.
    """
    context = runtime.context
    for source in (
        getattr(context, "canvas_id", None),
        context.get("canvas_id") if isinstance(context, dict) else None,
    ):
        if source:
            return str(source)
    configurable: dict[str, Any] = (runtime.config or {}).get("configurable", {})
    for key in ("canvas_id", "thread_id"):
        if configurable.get(key):
            return str(configurable[key])
    raise ValueError(
        "No canvas id: provide `canvas_id` in the runtime context or run with a `thread_id`."
    )


def _sliced(content: str, offset: int, limit: int) -> tuple[str, str]:
    """A line window of ``content`` plus a continuation note ("" when complete)."""
    lines = content.split("\n")
    total = len(lines)
    window = lines[offset : offset + limit]
    numbered = "\n".join(
        f"{i:>4}\t{line}" for i, line in enumerate(window, start=offset + 1)
    )
    end = offset + len(window)
    if offset == 0 and end >= total:
        return numbered, ""
    note = f"[lines {offset + 1}-{end} of {total}"
    if end < total:
        note += f" — call read_canvas again with offset={end} for more"
    return numbered, note + "]"


def _parse_pages(spec: str) -> list[int]:
    """1-based page numbers from a spec like ``"3"``, ``"2-5"`` or ``"1,4,7"``.

    Order-preserving and de-duplicated; raises ``ValueError`` with an honest
    message on anything else, so the tool can relay it verbatim.
    """
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        lo, dash, hi = part.partition("-")
        if dash and lo.strip().isdigit() and hi.strip().isdigit():
            start, end = int(lo), int(hi)
            if start < 1 or start > end:
                raise ValueError(f"page range {part!r} is not ascending from 1 or higher")
            pages.extend(range(start, end + 1))
        elif part.isdigit() and int(part) >= 1:
            pages.append(int(part))
        else:
            raise ValueError(
                f'pages must be "grid", or page numbers like "3", "2-5", "1,4,7" (got {spec!r})'
            )
    return list(dict.fromkeys(pages))


def create_canvas_tools(
    store: CanvasStore,
    *,
    converters: list[SourceConverter] | None = None,
    title_for: Callable[[str], str] | None = None,
    meta_for: Callable[[str], dict[str, Any] | None] | None = None,
) -> list[Any]:
    """Return the four standard canvas tools bound to ``store``.

    ``converters`` render binary source files (uploads under ``sources/``)
    into model-usable content when the agent reads them; defaults to the
    built-in set (see :mod:`langchain_canvas.converters`) and is fully
    replaceable with your own pipeline. ``title_for`` / ``meta_for``
    customize the live broadcast the same way they customize
    :func:`~langchain_canvas.replay.hydrate_events`: map a file path to a
    display title / renderer hints (for example titling slide files from a
    deck manifest). Defaults: the path as title, no hints.
    """
    active_converters = default_converters() if converters is None else converters

    def _broadcast(
        runtime: ToolRuntime, canvas_id: str, path: str, is_new: bool, commit: Commit
    ) -> None:
        # Same silent no-op contract as the Canvas emitter: no writer, no wire.
        writer = getattr(runtime, "stream_writer", None)
        if writer is None or not path.endswith(ARTIFACT_SUFFIXES):
            return
        content = store.read(canvas_id, path, revision=commit.revision).content
        for event in events_for_commit(
            path,
            content,
            is_new=is_new,
            revision=commit.revision,
            description=commit.description,
            title=title_for(path) if title_for else None,
            meta=meta_for(path) if meta_for else None,
        ):
            writer(event)

    def _has_file(canvas_id: str, path: str) -> bool:
        return any(info.path == path for info in store.list_files(canvas_id))

    def _revision_header(canvas_id: str, path: str, revision: str) -> str:
        """``revision: v4`` plus who last changed the file and when.

        The revision alone says nothing about whether the person has been
        here; the actor and the age do, and they come from the log the store
        already keeps.
        """
        last = last_change_line(store, canvas_id, path)
        return f"revision: {revision}" + (f"\n{last}" if last else "")

    def _edit_document(
        runtime: ToolRuntime,
        canvas_id: str,
        path: str,
        old: str,
        new: str,
        description: str,
        revision: str,
    ) -> str:
        """`edit_canvas` over a Word file — same contract, real paragraphs.

        Word splits one visible sentence across runs, so a replacement that
        matched the file's raw XML would almost never be the one the reader
        asked for. This matches the text as read, across run boundaries, and
        keeps the same one-match-only rule the text path has.
        """
        try:
            got = store.read_bytes(canvas_id, path)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        try:
            edited = replace_text(got.data, old, new, path=path)
        except (DocumentOpError, MissingDocumentDependencyError) as exc:
            return f"Error: {exc}"
        return _save_document(
            store,
            runtime,
            canvas_id,
            path,
            edited,
            description,
            revision,
            converters=active_converters,
            verb="Edited",
        )

    def _canvas_paths(canvas_id: str) -> set[str] | None:
        try:
            return {info.path for info in store.list_files(canvas_id)}
        except CanvasStoreError:
            return None

    def _is_checked(path: str) -> bool:
        """Whether a save-time check has anything to say about this path."""
        lowered = path.lower()
        return lowered.endswith(SLIDES_HTML_SUFFIX) or is_document_path(path)

    def _save_note(canvas_id: str, path: str, content: str) -> str:
        """Certain-only warnings for a file just saved ('' when clean).

        Free to compute (fields, coordinates and a file list — no render), so
        it rides every save and the model sees a defect the moment it writes
        one. A deck gets the deck check; a document or page gets the
        reference check, which is the defect that reached readers as a broken
        image. See :mod:`langchain_canvas.deck.validate` and
        :mod:`langchain_canvas.document_lint` for the no-false-positives
        contract both keep.
        """
        lowered = path.lower()
        if lowered.endswith(SLIDES_HTML_SUFFIX):
            return _deck_html_note(content)
        if is_document_path(path):
            on_canvas = _canvas_paths(canvas_id)
            if on_canvas is None:
                return ""
            return format_document_warnings(
                lint_document_content(
                    content, path=path, ref_exists=on_canvas.__contains__
                )
            )
        return ""

    def _table_refusal(
        canvas_id: str, path: str, content: str, *, is_new: bool
    ) -> tuple[str | None, str]:
        """``(refusal, content)`` for a table save: refuse, or normalise.

        Three things put a broken grid in front of the person: a file that is
        not the envelope, keys written outside ``data``, and a rewrite of a
        table the person has formatted (its ``sheet``) that drops that state.
        Everything else is normalised through the schema, so ``columns`` and
        ``rows`` are always present for the renderer.
        """
        shape = (
            '{"type": "table", "title": "...", "data": {"columns": [...], "rows": [...]}}'
        )
        try:
            envelope = json.loads(content)
        except json.JSONDecodeError as exc:
            return (
                f"Error: {path} was not saved — it is not valid JSON ({exc.msg} at line "
                f"{exc.lineno}). A table is {shape}."
            ), content
        if not isinstance(envelope, dict):
            return f"Error: {path} was not saved — a table is {shape}.", content
        misplaced = [k for k in ("columns", "rows", "sheet") if k in envelope]
        if misplaced:
            named = ", ".join(f'"{k}"' for k in misplaced)
            return (
                f"Error: {path} was not saved — {named} must sit inside \"data\", not at "
                f"the top level: {shape}."
            ), content
        data = envelope.get("data")
        if not isinstance(data, dict):
            return f"Error: {path} was not saved — \"data\" is missing: {shape}.", content
        try:
            model = TableData.model_validate(data)
        except Exception as exc:  # noqa: BLE001 - pydantic's message is the fix
            return f"Error: {path} was not saved — {exc}", content
        if not is_new:
            try:
                current = json.loads(store.read(canvas_id, path).content)
            except (CanvasStoreError, ValueError):
                current = None
            has_sheet = isinstance(current, dict) and bool(
                (current.get("data") or {}).get("sheet")
            )
            if has_sheet and not model.sheet:
                return (
                    f"Error: {path} was not saved — it holds the person's grid state "
                    "(formatting, merges, formulas), which this rewrite would erase. "
                    "Change cells with write_table_cells instead."
                ), content
        normalised = model.model_dump(by_alias=True, exclude_none=True)
        title = envelope.get("title")
        try:
            content = encode_artifact(
                {
                    "type": "table",
                    "title": title if isinstance(title, str) else display_title(path),
                    "data": normalised,
                },
                path,
            )
        except ValueError as exc:
            return f"Error: {path} was not saved — {exc}", content
        return None, content

    def _deck_html_note(content: str) -> str:
        """The deck check for a canonical ``.slides.html`` deck."""
        warnings = [issue.message for issue in validate_deck(content)]
        return format_layout_warnings(warnings)

    def _read_source_pages(canvas_id: str, path: str, spec: str) -> str | list[dict]:
        """Rendered page images (or the grid overview) for one paged source.

        Renders are recomputed on every call by design — a persistent
        preview belongs to the file-artifact track, not the read tool.
        """
        converter = converter_for(path, active_converters)
        if converter is None or not isinstance(converter, PageRenderable):
            renderable = sorted(
                {
                    suffix
                    for c in active_converters
                    if isinstance(c, PageRenderable)
                    for suffix in c.suffixes
                }
            )
            supported = ", ".join(renderable) if renderable else "none installed"
            return (
                f"Error: `pages` applies to page-renderable sources ({supported}); "
                f"{path} is not one — read it without `pages` for the text view."
            )
        try:
            got = store.read_bytes(canvas_id, path)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        try:
            if spec.strip().lower() == "grid":
                converted = converter.render_grid(got.data, path=path)
            else:
                numbers = _parse_pages(spec)
                if len(numbers) > MAX_IMAGES_PER_CALL:
                    return (
                        f"Error: asked for {len(numbers)} pages; the limit is "
                        f"{MAX_IMAGES_PER_CALL} per call — request a narrower range "
                        '(or pages="grid" for a thumbnail overview).'
                    )
                converted = converter.render_pages(got.data, path=path, pages=numbers)
        except MissingConverterDependencyError as exc:
            return f"Error: {exc}"
        except ValueError as exc:
            return f"Error: {exc}"
        meta = ", ".join(f"{k}: {v}" for k, v in converted.metadata.items())
        header = f"revision: {got.revision}\n{path}" + (f" ({meta})" if meta else "")
        return [{"type": "text", "text": header}, *converted.blocks]

    def _read_source(canvas_id: str, path: str, offset: int, limit: int) -> str | list[dict]:
        """A binary file rendered through its converter (or an honest refusal)."""
        converter = converter_for(path, active_converters)
        if converter is None:
            suffixes = sorted({s for c in active_converters for s in c.suffixes})
            return (
                f"Error: {path} is a binary file and no converter handles it. "
                f"Converters are installed for: {', '.join(suffixes)}."
            )
        got = store.read_bytes(canvas_id, path)
        try:
            converted = converter.convert(got.data, path=path)
        except MissingConverterDependencyError as exc:
            return f"Error: {exc}"
        except UnsafeArchiveError as exc:
            return f"Error: {exc}"
        text = "\n".join(
            str(block.get("text", "")) for block in converted.blocks if block.get("type") == "text"
        )
        sliced, note = _sliced(text, offset, limit)
        meta = ", ".join(f"{k}: {v}" for k, v in converted.metadata.items())
        header = f"{_revision_header(canvas_id, path, got.revision)}\nconverted view of {path}" + (
            f" ({meta})" if meta else ""
        )
        way_in = _way_to_edit(canvas_id, path)
        if way_in:
            header += f"\n{way_in}"
        body = f"{header}\n{sliced}" + (f"\n{note}" if note else "")
        images = [block for block in converted.blocks if block.get("type") == "image"]
        if images:
            return [{"type": "text", "text": body}, *images]
        return body

    def _way_to_edit(canvas_id: str, path: str) -> str:
        """One line under an upload's read: the file it is edited through.

        A read that shows the words but not the door leaves the model to
        guess, and the guess was a fresh file with none of the original's
        formatting. Empty for files that are not uploads.
        """
        if not path.startswith(_SOURCES_PREFIX):
            return ""
        lowered = path.lower()
        if lowered.endswith(".xlsx"):
            copy = working_copy_path(path)
            if _has_file(canvas_id, copy):
                return (
                    f'Editable working copy: {copy} — read it with sheet="s0" and change '
                    "cells with write_table_cells (this upload is read-only)."
                )
            return "This upload is read-only; there is no editable copy on the canvas yet."
        if lowered.endswith(".pptx"):
            return (
                "To edit: open_deck_for_editing makes an editable copy "
                "(this upload is read-only)."
            )
        if lowered.endswith(DOCUMENT_OP_SUFFIXES):
            return (
                "To edit: open_document_for_editing makes an editable copy "
                "(this upload is read-only)."
            )
        return ""

    @tool
    def read_canvas(
        path: str,
        runtime: ToolRuntime,
        offset: int = 0,
        limit: int = _DEFAULT_READ_LIMIT,
        pages: str | None = None,
        sheet: str | None = None,
    ) -> str | list[dict]:
        """Read one canvas file before viewing or editing it.

        Returns the file with line numbers plus the current `revision`. You
        need that revision to call `edit_canvas` or to safely overwrite with
        `write_canvas` — always read a file again right before editing it, so
        you see edits the user may have made by hand.

        Long files are windowed: `offset`/`limit` select a line range and the
        output says how to read the rest. Binary uploads under `sources/` are
        rendered through a format converter instead of raw bytes.

        Page-renderable sources ({page_formats}) can also be *seen*: observe cheaply
        first — the default text view names the page count and which pages
        have no text layer — then `pages="grid"` for a one-shot thumbnail
        overview of every page, then `pages="3"` / `"2-5"` / `"1,4,7"` to
        render just the pages that matter (scans, charts, layout questions)
        as images. At most 8 page images per call.

        A `.table.json` table answers with its map, not its contents: every
        rectangle addressed, sized, and counted. A table carries the same
        data twice — `rows`, which is yours, and the grid sheets, which are
        the person's — and the grid is where the size is. Read one with
        `sheet="rows"` or `sheet="s0"`; `offset`/`limit` window that one.
        """
        canvas_id = _canvas_id(runtime)
        if pages is not None:
            return _read_source_pages(canvas_id, path, pages)
        if sheet is not None and not path.endswith(".table.json"):
            return (
                f"Error: `sheet` applies to .table.json tables; {path} is not "
                "one — read it without `sheet`."
            )
        offset = max(0, offset)
        limit = max(1, limit)
        try:
            got = store.read(canvas_id, path)
        except BinaryContentError:
            try:
                return _read_source(canvas_id, path, offset, limit)
            except CanvasStoreError as exc:
                return f"Error: {exc}."
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        if path.endswith(".table.json"):
            try:
                view = table_view(got.content, sheet)
            except ValueError as exc:
                return f"Error: {exc}."
            if view is not None and sheet is None:
                return f"{_revision_header(canvas_id, path, got.revision)}\n{view}"
            if view is not None:
                header, _, body = view.partition("\n")
                sliced, note = _sliced(body, offset, limit)
                return (
                    f"{_revision_header(canvas_id, path, got.revision)}\n{header}\n{sliced}"
                    + (f"\n{note}" if note else "")
                )
        sliced, note = _sliced(got.content, offset, limit)
        header = _revision_header(canvas_id, path, got.revision)
        return f"{header}\n{sliced}" + (f"\n{note}" if note else "")

    @tool
    def write_canvas(
        path: str,
        content: str,
        description: str,
        runtime: ToolRuntime,
        revision: str | None = None,
    ) -> str | list[dict]:
        """Create a new canvas file, or fully replace an existing one.

        `description` becomes the version-history entry — one short sentence
        describing the change. For small changes to an existing file prefer
        `edit_canvas`; use `write_canvas` for new files or full rewrites.
        When replacing an existing file, pass the `revision` from your most
        recent `read_canvas` — if the canvas changed since (for example the
        user edited it by hand), the call is rejected instead of silently
        overwriting their work. Omit `revision` only for brand-new files.
        Files under `sources/` (the user's uploads) are read-only.

        Images already on the canvas embed by relative path — an .html page
        uses `<img src="sources/photo.png">` (or `assets/...`), a document
        uses `![photo](sources/photo.png)`. Use the path exactly as
        list_canvas_files shows it, even from a file inside a folder (never
        `../`). The canvas shows them live and exports inline the bytes, so
        never copy an upload to reference it.

        A structured `.table.json` sheet carries an envelope:
        `{"type": "table", "title": "...", "data": {"sheet": {...}}}`. A
        slide deck is a `.slides.html` file instead — raw HTML, one
        `<template data-slide-id>` per slide — made and edited slide by
        slide through the dedicated deck tools, never written whole
        through this one.
        """
        if path.startswith(_SOURCES_PREFIX):
            return _sources_readonly(path)
        canvas_id = _canvas_id(runtime)
        is_new = not _has_file(canvas_id, path)
        if path.lower().endswith(TABLE_SUFFIX):
            refusal, content = _table_refusal(canvas_id, path, content, is_new=is_new)
            if refusal is not None:
                return refusal
        try:
            commit = store.write(
                canvas_id,
                path,
                content,
                description,
                base_revision=revision,
                actor="agent",
            )
        except RevisionMismatchError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        _broadcast(runtime, canvas_id, path, is_new, commit)
        save_note = _save_note(canvas_id, path, content)
        return f"Wrote {path} (revision {commit.revision}).{save_note}"

    @tool
    def edit_canvas(
        path: str,
        old: str,
        new: str,
        description: str,
        revision: str,
        runtime: ToolRuntime,
    ) -> str | list[dict]:
        """Replace exactly one occurrence of `old` with `new` in a canvas file.

        `revision` must be the value returned by your most recent
        `read_canvas` of this file — if the file changed since (for example
        the user edited it), the call is rejected and you must read again.
        `old` must match exactly once; include enough surrounding context to
        make it unique. `description` is the version-history entry. Files
        under `sources/` (the user's uploads) are read-only.

        Word files ({document_formats}) are edited the same way: `old` is text
        copied from `read_canvas`, matched across the runs Word split it into,
        and may lead with the address the read printed — `"[p7] Title"` — to
        pick that paragraph when the same words appear twice (`"[p7]"` alone
        means the whole paragraph). `new` is the replacement text only; an
        address in front of it is dropped, never written into the document.
        and it must still match exactly once in the whole file — body, tables,
        headers and footers included.
        """
        if path.startswith(_SOURCES_PREFIX):
            return _sources_readonly(path)
        canvas_id = _canvas_id(runtime)
        if old == new:
            return "Error: old and new are the same — nothing to change, nothing saved."
        if _is_document_file(path):
            return _edit_document(runtime, canvas_id, path, old, new, description, revision)
        try:
            commit = store.edit(
                canvas_id,
                path,
                old,
                new,
                description,
                base_revision=revision,
                actor="agent",
            )
        except RevisionMismatchError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except EditConflictError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        _broadcast(runtime, canvas_id, path, is_new=False, commit=commit)
        save_note = ""
        if _is_checked(path):
            # Small edits introduce defects as easily as full writes — an
            # edit is how a document picks up a reference to a file that is
            # not there. Check the file as the edit left it.
            edited = store.read(canvas_id, path, revision=commit.revision).content
            save_note = _save_note(canvas_id, path, edited)
            return f"Edited {path} (revision {commit.revision}).{save_note}"
        return f"Edited {path} (revision {commit.revision}).{save_note}"

    @tool
    def list_canvas_files(runtime: ToolRuntime) -> str:
        """List the files currently on the canvas, with sizes in bytes."""
        try:
            infos = store.list_files(_canvas_id(runtime))
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        if not infos:
            return "The canvas is empty."
        return "\n".join(f"{info.path} ({info.size} bytes)" for info in infos)

    # The eye reaches whatever page-renderable converters are installed, and
    # a format the description does not name is a format the model will say
    # it cannot see. An agent asked to look at page 2 of an imported deck
    # answered "I have no tool for that" while the tool sat in its own list.
    renderable = sorted(
        {
            suffix
            for converter in active_converters
            if isinstance(converter, PageRenderable)
            for suffix in converter.suffixes
        }
    )
    read_canvas.description = read_canvas.description.replace(
        "{page_formats}", ", ".join(renderable) if renderable else "none installed"
    )
    edit_canvas.description = edit_canvas.description.replace(
        "{document_formats}", _DOCUMENT_FORMATS
    )
    return [read_canvas, write_canvas, edit_canvas, list_canvas_files]


def create_document_tools(
    store: CanvasStore, *, converters: list[SourceConverter] | None = None
) -> list[Any]:
    """Build the Word-editing tools bound to ``store``.

    The agent already replaces text in a document through ``edit_canvas``;
    these are the edits text replacement cannot express — adding a paragraph,
    dropping one, swapping a picture — plus the copy step that makes an
    upload editable in the first place. Kept out of
    :func:`create_canvas_tools` so the four standard tools stay a stable
    contract; mount these when your agent should hand documents back.

    Uploads under ``sources/`` stay read-only here as everywhere else. The
    working copy is what gets edited, and the original the user sent is still
    on the canvas next to it, unchanged, for as long as the canvas lives.

    ``converters`` is the same list :func:`create_canvas_tools` takes, used
    here to prove an edited file still renders before it is saved; defaults
    to the built-in set.
    """
    active_converters = default_converters() if converters is None else converters

    def _document(canvas_id: str, path: str) -> tuple[bytes | None, str]:
        """The stored bytes of a document path, or why they are not usable."""
        if not _is_document_file(path):
            return None, (
                f"Error: these operations edit {_DOCUMENT_FORMATS} files (got {path}). "
                + _other_ways_to_open(path, active_converters)
            )
        if path.startswith(_SOURCES_PREFIX):
            return None, _sources_readonly(path)
        try:
            return store.read_bytes(canvas_id, path).data, ""
        except CanvasFileNotFoundError as exc:
            return None, f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return None, f"Error: {exc}."

    @tool
    def open_document_for_editing(
        source: str, runtime: ToolRuntime, destination: str | None = None
    ) -> str:
        """Make an editable copy of an uploaded Word file.

        Use this once, before the first edit: uploads under `sources/` are the
        user's originals and stay read-only, so edits go to a copy. The copy
        lands at the canvas root named `Editing - <file name>`, so the two sit
        side by side and the user can tell at a glance which one is theirs and
        which one you are changing. The marker goes in front because the two
        names are otherwise identical and a long one is clipped at the end.
        Pass `destination` to name the copy yourself.

        After this, read the copy with `read_canvas` and change it with
        `edit_canvas`, `insert_document_paragraph`, `insert_document_image`,
        `remove_document_paragraph` and `replace_document_image`.
        """
        canvas_id = _canvas_id(runtime)
        if not _is_document_file(source):
            return (
                f"Error: this opens {_DOCUMENT_FORMATS} files (got {source}). "
                + _other_ways_to_open(source, active_converters)
            )
        target = (destination or _working_copy_name(source)).strip()
        if target.startswith(_SOURCES_PREFIX):
            return (
                "Error: sources/ holds the user's uploads — put the working copy "
                "somewhere else (the default is the marked name at the canvas root)."
            )
        if not _is_document_file(target):
            return f"Error: the copy has to keep the document's format ({_DOCUMENT_FORMATS})."
        try:
            got = store.read_bytes(canvas_id, source)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        if any(info.path == target for info in store.list_files(canvas_id)):
            return (
                f"Error: {target} is already on the canvas. Edit that one, or pass "
                "`destination` to copy under another name."
            )
        try:
            commit = store.write_bytes(
                canvas_id, target, got.data, f"Copy {source} for editing", actor="agent"
            )
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        _broadcast_source(store, runtime, canvas_id, target, True, commit)
        return (
            f"Copied {source} to {target} ({len(got.data)} bytes, revision "
            f"{commit.revision}). Edit {target}; {source} keeps the user's original."
        )

    @tool
    def insert_document_paragraph(
        path: str,
        anchor: str,
        text: str,
        description: str,
        revision: str,
        runtime: ToolRuntime,
        style: str | None = None,
        position: str = "after",
    ) -> str:
        """Add a paragraph next to one that is already in a Word file.

        `anchor` is text copied from `read_canvas` that appears exactly once
        in the document — it names the paragraph to add next to, and an anchor
        matching nothing or several places is refused rather than guessed at.
        `position` is `after` (the default) or `before`. `style` names a
        paragraph style the document already has, such as `Heading 2` or
        `List Bullet`; `read_canvas` shows each paragraph's style in
        parentheses, so match the paragraphs around the new one. Omitted, the
        new paragraph takes the document's default style.

        This writes text. A picture goes in with `insert_document_image` —
        markdown image syntax is refused here, because a Word file would show
        it as the characters themselves.

        `revision` must come from your most recent `read_canvas` of this file.
        """
        canvas_id = _canvas_id(runtime)
        found = _MARKDOWN_IMAGE.search(text)
        if found:
            return (
                f"Error: {found.group(0)!r} is markdown image syntax, which a Word file "
                "shows as plain text rather than a picture. Use insert_document_image to "
                "put the picture in."
            )
        data, problem = _document(canvas_id, path)
        if data is None:
            return problem
        try:
            edited = insert_paragraph(
                data, anchor=anchor, text=text, style=style, position=position, path=path
            )
        except (DocumentOpError, MissingDocumentDependencyError) as exc:
            return f"Error: {exc}"
        return _save_document(
            store,
            runtime,
            canvas_id,
            path,
            edited,
            description,
            revision,
            converters=active_converters,
            verb="Added a paragraph to",
        )

    @tool
    def remove_document_paragraph(
        path: str, anchor: str, description: str, revision: str, runtime: ToolRuntime
    ) -> str:
        """Delete one paragraph from a Word file.

        `anchor` is text copied from `read_canvas` that appears exactly once
        in the document; the paragraph holding it is the one removed. A
        paragraph that is the only one in its table cell cannot be removed —
        Word needs one there — so replace its text instead.

        `revision` must come from your most recent `read_canvas` of this file.
        """
        canvas_id = _canvas_id(runtime)
        data, problem = _document(canvas_id, path)
        if data is None:
            return problem
        try:
            edited = remove_paragraph(data, anchor=anchor, path=path)
        except (DocumentOpError, MissingDocumentDependencyError) as exc:
            return f"Error: {exc}"
        return _save_document(
            store,
            runtime,
            canvas_id,
            path,
            edited,
            description,
            revision,
            converters=active_converters,
            verb="Removed a paragraph from",
        )

    @tool
    def insert_document_image(
        path: str,
        image_path: str,
        description: str,
        revision: str,
        runtime: ToolRuntime,
        anchor: str | None = None,
        position: str = "after",
        width_inches: float | None = None,
        alt_text: str | None = None,
    ) -> str:
        """Put a picture into a Word file.

        `image_path` is a file already on the canvas, under `assets/` or
        `sources/`; bring an image the user attached onto the canvas before
        pointing at it here. Nothing is fetched from outside the canvas.

        Leave `anchor` out to put the picture at the end of the document.
        Given one — text copied from `read_canvas` that appears exactly once —
        the picture goes next to that paragraph, `after` it by default or
        `before` it.

        The picture arrives at its own size, brought down to the width of the
        text column if it is wider than that; it is never enlarged. Pass
        `width_inches` to choose the width yourself, and the height follows
        the picture's proportions. `alt_text` describes it for a reader who
        cannot see it.

        `revision` must come from your most recent `read_canvas` of this file.
        """
        canvas_id = _canvas_id(runtime)
        data, problem = _document(canvas_id, path)
        if data is None:
            return problem
        reference = normalize_asset_reference(image_path)
        if reference is None:
            return (
                f"Error: {image_path} is not a canvas image path — pass one under "
                f"{ASSETS_PREFIX} or {_SOURCES_PREFIX}, exactly as list_canvas_files "
                "shows it."
            )
        try:
            picture = store.read_bytes(canvas_id, reference).data
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        try:
            edited, note = insert_image(
                data,
                image=picture,
                anchor=anchor,
                position=position,
                width_inches=width_inches,
                alt_text=alt_text,
                path=path,
            )
        except (DocumentOpError, MissingDocumentDependencyError) as exc:
            return f"Error: {exc}"
        return _save_document(
            store,
            runtime,
            canvas_id,
            path,
            edited,
            description,
            revision,
            converters=active_converters,
            verb="Added a picture to",
            note=f" {note}",
        )

    @tool
    def replace_document_image(
        path: str,
        index: int,
        image_path: str,
        description: str,
        revision: str,
        runtime: ToolRuntime,
    ) -> str:
        """Swap the picture at `[img<index>]` in a Word file for another image.

        `index` is the number `read_canvas` prints next to the picture —
        `[img0]` is 0. `image_path` is a file already on the canvas, under
        `assets/` or `sources/`; bring an image the user attached onto the
        canvas before pointing at it here. The picture keeps the width it has
        on the page and its height is refitted to the new image, so the
        layout around it does not move.

        `revision` must come from your most recent `read_canvas` of this file.
        """
        canvas_id = _canvas_id(runtime)
        data, problem = _document(canvas_id, path)
        if data is None:
            return problem
        reference = normalize_asset_reference(image_path)
        if reference is None:
            return (
                f"Error: {image_path} is not a canvas image path — pass one under "
                f"{ASSETS_PREFIX} or {_SOURCES_PREFIX}, exactly as list_canvas_files "
                "shows it."
            )
        try:
            picture = store.read_bytes(canvas_id, reference).data
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        try:
            edited, note = replace_image(data, index=index, image=picture, path=path)
        except (DocumentOpError, MissingDocumentDependencyError) as exc:
            return f"Error: {exc}"
        return _save_document(
            store,
            runtime,
            canvas_id,
            path,
            edited,
            description,
            revision,
            converters=active_converters,
            verb="Replaced a picture in",
            note=f" {note}",
        )

    return [
        open_document_for_editing,
        insert_document_paragraph,
        insert_document_image,
        remove_document_paragraph,
        replace_document_image,
    ]


def create_table_tools(store: CanvasStore) -> list[Any]:
    """Build the table-writing tools bound to ``store``.

    ``read_canvas`` shows a table as a map and hands back one addressed
    rectangle; these write to the same addresses. Without them the only way
    to change a cell is to rewrite the whole file, which on a real import
    means resending millions of characters and losing the person's
    formatting, merges and other sheets in the process.

    Kept out of :func:`create_canvas_tools` so the four standard tools stay a
    stable contract; mount these when your agent should edit spreadsheets.
    """

    def _load(canvas_id: str, path: str) -> Any:
        if not path.endswith(".table.json"):
            if path.startswith(_SOURCES_PREFIX) and path.lower().endswith(".xlsx"):
                raise ValueError(
                    f"{path} is the uploaded original (read-only); its working copy is "
                    f"{working_copy_path(path)} — read that with sheet=\"s0\" and write "
                    "cells there"
                )
            raise ValueError(f"this works on .table.json tables (got {path})")
        return store.read(canvas_id, path)

    def _save(
        runtime: ToolRuntime,
        canvas_id: str,
        path: str,
        content: str,
        description: str,
        revision: str,
        note: str,
    ) -> str:
        try:
            commit = store.write(
                canvas_id, path, content, description, base_revision=revision, actor="agent"
            )
        except RevisionMismatchError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        # Same silent no-op contract as the other writers: no writer, no wire.
        writer = getattr(runtime, "stream_writer", None)
        if writer is not None:
            for event in events_for_commit(
                path,
                content,
                is_new=False,
                revision=commit.revision,
                description=commit.description,
            ):
                writer(event)
        return f"{note} ({path}, revision {commit.revision})"

    @tool
    def write_table_cells(
        path: str,
        sheet: str,
        cells: dict[str, Any],
        description: str,
        revision: str,
        runtime: ToolRuntime,
    ) -> str:
        """Put values into one sheet of a .table.json table, cell by cell.

        `sheet` is an address `read_canvas` printed — `s0`, `s1`, ... — and
        `cells` maps cell addresses to what goes in them:
        `{"B3": 42, "C3": "=B3*2", "D3": "done"}`. The column letters are in
        the `### sheet:` line of the read, so nothing needs counting. A value
        starting with `=` stays a formula; `""` clears the cell. Styling on a
        cell you overwrite stays.

        To match the sheet's look, write a dict: `{"v": "Notes", "like":
        "A3"}` copies A3's bold, fill, font and colour onto the cell; explicit
        keys win over the copy — `{"v": "Total", "bl": 1, "bg": "#DDEBF7",
        "fc": "#1F4E78", "fs": 11}`. The read's `styles:` lines say where each
        look lives, so "like the header" is `like` the header's address.

        This is how to change a table: rewriting the whole file with
        `write_canvas` replaces every sheet and drops the formatting, merges
        and formulas only the grid holds. `revision` must be the value from
        your most recent `read_canvas` of this file.
        """
        canvas_id = _canvas_id(runtime)
        try:
            got = _load(canvas_id, path)
            content, note = table_write_cells(got.content, sheet, cells)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        except ValueError as exc:
            return f"Error: {exc}."
        return _save(runtime, canvas_id, path, content, description, revision, note)

    @tool
    def add_table_sheet(
        path: str,
        name: str,
        description: str,
        revision: str,
        runtime: ToolRuntime,
    ) -> str:
        """Add an empty sheet to a .table.json table.

        The new sheet goes last and takes the next address, so the addresses
        `read_canvas` already gave you keep pointing at the same sheets.
        Write into it with `write_table_cells`. `revision` must be the value
        from your most recent `read_canvas` of this file.
        """
        canvas_id = _canvas_id(runtime)
        try:
            got = _load(canvas_id, path)
            content, note = table_add_sheet(got.content, name)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        except ValueError as exc:
            return f"Error: {exc}."
        return _save(runtime, canvas_id, path, content, description, revision, note)

    return [write_table_cells, add_table_sheet]


def inline_deck_skin(content: str, store: CanvasStore, canvas_id: str) -> str:
    """Replace a deck's ``lcx:source`` skin reference with a ``data:`` URI.

    The canonical-dialect twin of :func:`inline_slides_assets`'s template
    inlining: :class:`~langchain_canvas.deck.export.DeckPptxExporter` keeps
    the ``Exporter`` contract content-only, so the export tool inlines the
    ``.pptx`` skin reference here before the exporter runs. A reference that
    cannot be inlined (missing, not a store path, not a ``.pptx``) is left
    untouched — the exporter then degrades to a blank export, the same
    honesty :func:`inline_slides_assets` applies to its ``template`` field.
    """
    try:
        deck = parse_deck(content)
    except DeckParseError:
        return content
    source = deck.source
    if not isinstance(source, str) or not source.lower().endswith(".pptx"):
        return content
    path = normalize_asset_reference(source)
    if path is None:
        return content
    try:
        raw = store.read_bytes(canvas_id, path).data
    except CanvasStoreError:
        return content
    encoded = base64.b64encode(raw).decode()
    new_source = f"data:{PPTX_MIME};base64,{encoded}"
    patched = Deck(title=deck.title, ratio=deck.ratio, source=new_source, slides=deck.slides)
    return serialize_deck(patched)


def create_export_tool(
    store: CanvasStore,
    *,
    exporters: list[Exporter] | None = None,
    converters: list[SourceConverter] | None = None,
) -> Any:
    """Build an ``export_canvas`` tool bound to ``store``.

    ``converters`` is the same list ``create_canvas_tools`` takes; when one of
    them renders pages for the exported format, the reply carries a thumbnail
    grid of the file that was just written — the export is the moment the
    result is final, so it is the moment to look.

    Kept separate from :func:`create_canvas_tools` so the four standard tools
    stay a stable contract — add this tool when your agent should hand users
    office files. ``exporters`` defaults to the built-in set (see
    :mod:`langchain_canvas.exporters`) and is fully replaceable with your own
    pipeline. Exported files land on the canvas under ``exports/``.
    """
    active_exporters = default_exporters() if exporters is None else exporters

    active_converters = default_converters() if converters is None else converters

    @tool
    def export_canvas(path: str, target: str, runtime: ToolRuntime) -> str | list[dict]:
        """Export canvas work into a downloadable office file.

        ``path`` is one canvas file (``report/02-overview.html``,
        ``sales.table.json``, ``deck.slides.html``) or a directory prefix
        ending in ``/`` (``report/``), which merges every .html file under
        it, in name order, into one document with a page break between
        sections. ``target`` is the output format: ``docx`` for .html
        files, ``xlsx`` for .table.json tables, ``pptx`` for
        ``.slides.html`` decks. The result is saved under ``exports/`` on
        the canvas, where the user can download it.

        Template skin: a ``.slides.html`` deck's ``lcx:source`` meta points
        an export at that file's masters and layouts, so the original's
        logos, backgrounds, and headers survive, and the text takes the
        face that file uses most. A missing or unreadable skin degrades to
        the plain blank-layout export, where fonts fall back to whatever
        the viewer has installed.
        """
        canvas_id = _canvas_id(runtime)
        try:
            if path.endswith("/"):
                section_paths = sorted(
                    info.path
                    for info in store.list_files(canvas_id)
                    if info.path.startswith(path) and info.path.lower().endswith((".html", ".htm"))
                )
                if not section_paths:
                    return f"Error: no .html files under {path} to export."
                content = "\n<hr/>\n".join(
                    store.read(canvas_id, section).content for section in section_paths
                )
                sample = section_paths[0]
            else:
                content = store.read(canvas_id, path).content
                sample = path
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except BinaryContentError:
            return (
                f"Error: {path} is binary; export reads text canvas files "
                "(.html, .table.json, .slides.html)."
            )

        # Relative asset references (assets/, sources/) become data: URIs here,
        # before the exporter runs — exporters keep their one-method contract
        # and the exported file leaves self-contained, images included. The
        # .slides.html check runs before the general .html check (both match
        # `endswith`) so a canonical deck gets both its asset references AND
        # its lcx:source skin reference inlined.
        if sample.lower().endswith(SLIDES_HTML_SUFFIX):
            content = inline_canvas_assets(content, store, canvas_id)
            content = inline_deck_skin(content, store, canvas_id)
        elif sample.lower().endswith((".html", ".htm")):
            content = inline_canvas_assets(content, store, canvas_id)

        exporter = exporter_for(sample, target, active_exporters)
        if exporter is None:
            available = sorted(
                {e.target for e in active_exporters if sample.lower().endswith(e.suffixes)}
            )
            hint = f" Formats available for this file: {', '.join(available)}." if available else ""
            return f"Error: no exporter turns {sample} into {target!r}.{hint}"
        try:
            exported = exporter.export(content, path=path)
        except MissingExporterDependencyError as exc:
            return f"Error: {exc}"
        except ValueError as exc:
            return f"Error: {exc}"

        out_path = f"exports/{exported.filename}"
        commit = store.write_bytes(
            canvas_id,
            out_path,
            exported.data,
            f"Export {path} -> {exported.filename}",
            actor="agent",
        )
        reply = (
            f"Exported {path} to {out_path} ({len(exported.data)} bytes, revision "
            f"{commit.revision}). The user can download it from the canvas file list."
        )
        renderer = _renderer_for(out_path, active_converters)
        if renderer is None:
            return reply
        try:
            converted = renderer.render_grid(exported.data, path=out_path)
        except Exception:  # noqa: BLE001 - the look is a bonus; the export already landed
            return reply + " (The page renderer could not draw it — read it with pages=\"grid\".)"
        images = [block for block in converted.blocks if block.get("type") == "image"]
        if not images:
            return reply
        return _with_eye(
            reply + " These are its pages as exported — check them before telling the user "
            "it is done.",
            images,
        )

    return export_canvas


def create_asset_tool(store: CanvasStore) -> Any:
    """Build a ``write_canvas_asset`` tool bound to ``store``.

    The intake wiring for binary assets: it moves image bytes the agent
    already holds (handed over by the host, produced by a separate pipeline)
    onto the canvas under ``assets/``, where every canvas file can reference
    them by relative path. It creates nothing — image *generation* belongs to
    the adopter's own tools, not the canvas core. Kept separate from
    :func:`create_canvas_tools` so the four standard tools stay a stable
    contract.
    """

    @tool
    def write_canvas_asset(
        path: str, content_base64: str, description: str, runtime: ToolRuntime
    ) -> str:
        """Store an image the canvas can reference, under `assets/`.

        `path` is a file name like `logo.png` (stored as `assets/logo.png`)
        or an explicit `assets/...` path. `content_base64` is the raw image
        bytes, base64-encoded — this tool stores bytes you already have; it
        does not create or fetch images. `description` is the version-history
        entry.

        Reference the stored file from canvas files by its relative path:
        `<img src="assets/logo.png">` in an .html page,
        `![logo](assets/logo.png)` in a document, `src: "assets/logo.png"`
        on a slide image element. The canvas displays it live and exports
        inline the bytes into the exported file. The user's uploads under
        `sources/` are referenced the same way — never copy them here.
        """
        canvas_id = _canvas_id(runtime)
        path = path.strip()
        if path.startswith(ASSETS_PREFIX):
            pass
        elif "/" not in path and path:
            path = ASSETS_PREFIX + path
        elif path.startswith(_SOURCES_PREFIX):
            return (
                "Error: files under sources/ are the user's uploads. Reference "
                'them directly (<img src="sources/...">) instead of copying.'
            )
        else:
            return (
                f"Error: assets live under {ASSETS_PREFIX} — pass a file name "
                f"or an {ASSETS_PREFIX}... path (got {path!r})."
            )
        dot = path.rfind(".")
        suffix = path[dot:].lower() if dot != -1 else ""
        if suffix not in ASSET_IMAGE_MIME:
            supported = ", ".join(sorted(ASSET_IMAGE_MIME))
            return (
                f"Error: {suffix or 'no extension'} is not an embeddable image "
                f"type ({supported}). For text content use write_canvas."
            )
        # Models often hand back a full data: URI — accept it, keep the bytes.
        encoded = content_base64.strip()
        if encoded.startswith("data:"):
            encoded = encoded.partition(",")[2]
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            return "Error: content_base64 is not valid base64."
        if not data:
            return "Error: content_base64 decoded to zero bytes."
        try:
            commit = store.write_bytes(canvas_id, path, data, description, actor="agent")
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        return (
            f"Wrote {path} ({len(data)} bytes, revision {commit.revision}). "
            f'Reference it by relative path, e.g. <img src="{path}">.'
        )

    return write_canvas_asset


_EXPECT_PATTERN = re.compile(r"^\s*(?P<key>[^\[\]=]+)\[(?P<row>\d+)\]\s*=\s*(?P<value>.*?)\s*$")
_FUNCTION_NAME_PATTERN = re.compile(r"([A-Z][A-Z0-9.]*)\s*\(")


def _values_equal(got: object, want: str) -> bool:
    """Loose comparison for expect assertions: numeric when both parse."""
    try:
        return float(str(got)) == float(want)
    except ValueError:
        return str(got).strip() == want


def _error_hint(formula: str) -> str:
    """Why a formula likely failed, steering toward supported classics."""
    unsupported = sorted(
        name
        for name in set(_FUNCTION_NAME_PATTERN.findall(formula.upper()))
        if name not in SUPPORTED_FORMULA_FUNCTIONS
    )
    if unsupported:
        return (
            f"{', '.join(unsupported)} is not supported on this canvas — rewrite with "
            "classic equivalents (SUMIFS, MATCH, TEXTJOIN, ...; see the supported list "
            "in this tool's description)"
        )
    return "the formula failed to evaluate — check references and argument types"


def create_check_table_tool(
    store: CanvasStore, *, evaluator: Sequence[str] | None = None
) -> Any:
    """Build a ``check_table`` tool bound to ``store``.

    Closes the write → check → fix loop for table formulas: the tool
    evaluates every formula cell of a ``.table.json`` file and reports the
    results — and errors — back as text the agent can act on.

    ``evaluator`` is the command that does the evaluating: an argv sequence
    that reads a ``{"columns": ..., "rows": ...}`` JSON payload on stdin and
    writes ``{"results": [...]}`` on stdout. The reference command is
    ``("node", "<canvas-react>/dist/formula-cli.js")`` — a one-shot
    subprocess around the *same* engine and function registrations the
    client uses to display formula results, so the check can never drift
    from what the canvas shows. With ``evaluator=None`` (or a missing
    runtime) the tool stays mounted but answers with honest guidance
    instead of a false verdict.
    """

    @tool
    def check_table(
        path: str, runtime: ToolRuntime, expect: list[str] | None = None
    ) -> str:
        """Evaluate the formulas of a .table.json file and report every result.

        Run this after writing or editing a table that contains formulas
        ("=..." cell values). It computes each formula with the same engine
        the canvas uses, so what it reports is what the user sees. Fix every
        ERROR (read_canvas + edit_canvas) and re-check until it reports
        0 errors. ``expect`` optionally asserts computed values, one entry
        per assertion in the form ``column_key[row_index]=value`` with the
        0-based index into ``rows`` — for example ``["total[2]=1250"]``.
        """
        canvas_id = _canvas_id(runtime)
        if not path.endswith(".table.json"):
            return f"Error: check_table reads .table.json files (got {path})."
        try:
            content = store.read(canvas_id, path).content
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."

        try:
            envelope = json.loads(content)
            data = envelope.get("data") or {}
            columns = data.get("columns") or []
            rows = data.get("rows") or []
        except (ValueError, AttributeError):
            return f"Error: {path} does not contain valid table JSON."

        typed = sum(
            1
            for sheet in data.get("sheet") or []
            for cell in sheet.get("celldata") or []
            if isinstance(cell.get("v"), dict) and cell["v"].get("f")
        )
        typed_note = (
            f"\nNote: {typed} typed formula(s) exist in the sheet editor state; they "
            "evaluate in the grid and are not checked here."
            if typed
            else ""
        )

        formula_cells = sum(
            1
            for row in rows
            for value in row.values()
            if isinstance(value, str) and value.startswith("=")
        )
        if formula_cells == 0 and not expect:
            return f"0 ERROR — no formula cells in {path} rows.{typed_note}"

        if evaluator is None:
            return (
                "Error: check_table has no formula evaluator configured. The host "
                "must pass `evaluator` to create_check_table_tool (normally "
                "('node', '<canvas-react>/dist/formula-cli.js')). The formulas were "
                "NOT verified."
            )
        payload = json.dumps({"columns": columns, "rows": rows})
        try:
            proc = subprocess.run(  # noqa: S603 — host-configured argv, no shell
                list(evaluator), input=payload.encode(), capture_output=True, timeout=60
            )
            output = json.loads(proc.stdout.decode())
            results = output["results"]
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
            return (
                f"Error: the formula evaluator could not run ({exc}). The formulas "
                "were NOT verified — is Node.js installed and the canvas package built?"
            )

        lines: list[str] = []
        errors = 0
        computed: dict[tuple[str, int], object] = {}
        for cell in results:
            key, row_idx = str(cell["key"]), int(cell["row"])
            value = cell.get("value")
            computed[(key, row_idx)] = value
            if value == "#ERR":
                errors += 1
                lines.append(
                    f"ERROR {key}[{row_idx}]: {cell['formula']} -> #ERR — "
                    + _error_hint(str(cell["formula"]))
                )
            else:
                lines.append(f"ok    {key}[{row_idx}]: {cell['formula']} -> {value}")

        for assertion in expect or []:
            match = _EXPECT_PATTERN.match(assertion)
            if not match:
                errors += 1
                lines.append(
                    f"ERROR expect {assertion!r}: not in the form column_key[row_index]=value"
                )
                continue
            key, row_idx = match["key"].strip(), int(match["row"])
            got = computed.get((key, row_idx))
            if got is None:
                got = rows[row_idx].get(key) if row_idx < len(rows) else None
            if _values_equal(got, match["value"]):
                lines.append(f"ok    expect {key}[{row_idx}] = {match['value']}")
            else:
                errors += 1
                lines.append(f"ERROR expect {key}[{row_idx}] = {match['value']}, got {got}")

        summary = f"{errors} ERROR — {len(results)} formula cell(s) evaluated in {path}."
        return "\n".join([summary, *lines]) + typed_note

    check_table.description += "\n\n" + formula_guidance()
    return check_table


def _ratio_for_pptx(data: bytes) -> str:
    """The deck ratio nearest the source presentation's declared page size.

    Defaults to ``"16:9"`` when the page size cannot be read — the same
    fallback :func:`~langchain_canvas.deck.baseline._canvas_size` uses for an
    unrecognized ratio string.
    """
    size = pptx_page_size_inches(data)
    if size is None or size[1] <= 0:
        return "16:9"
    aspect = size[0] / size[1]
    return "4:3" if abs(aspect - 4 / 3) < abs(aspect - 16 / 9) else "16:9"


def _parse_incoming_template(template_html: str, slide_id: str) -> SlideTemplate:
    """The one ``<template>`` fragment ``template_html`` must contain.

    ``edit_deck_slide`` takes a full ``<template data-slide-id="...">...
    </template>`` fragment (the same shape :func:`~langchain_canvas.deck.patch_slide`
    and ``canvas.slide_patch``'s ``template_html`` carry) — wrapping it in a
    throwaway deck document reuses :func:`~langchain_canvas.deck.parse_deck`'s
    title/style/body split instead of duplicating that parsing here.
    """
    wrapper = f"<!DOCTYPE html><html><body>{template_html}</body></html>"
    try:
        parsed = parse_deck(wrapper)
    except DeckParseError as exc:
        raise DeckParseError(f"template_html is not a valid <template> fragment: {exc}") from exc
    if len(parsed.slides) != 1:
        raise DeckParseError(
            "template_html must contain exactly one <template data-slide-id=...> element"
        )
    slide = parsed.slides[0]
    if slide.slide_id != slide_id:
        raise DeckParseError(
            f"template_html's data-slide-id {slide.slide_id!r} does not match {slide_id!r}"
        )
    return slide


def _serialize_template_fragment(
    slide_id: str, title: str | None, style_css: str, body_html: str
) -> str:
    """The ``<template data-slide-id="...">...</template>`` fragment
    :func:`~langchain_canvas.deck.patch_slide` expects.

    Mirrors ``deck.model``'s private slide serialization format exactly (the
    shape :func:`~langchain_canvas.deck.parse_deck` reads back), kept here
    rather than exported from ``deck.model`` because this task's edits are
    scoped to this module.
    """
    attrs = f' data-slide-id="{html_lib.escape(slide_id, quote=True)}"'
    if title:
        attrs += f' data-slide-title="{html_lib.escape(title, quote=True)}"'
    parts = [f"<template{attrs}>"]
    if style_css:
        parts.append(f"<style>{style_css}</style>")
    parts.append(body_html)
    parts.append("</template>")
    return "\n".join(parts)


def create_deck_tools(store: CanvasStore) -> list[Any]:
    """Build the tools that make an uploaded deck editable, slide by slide.

    An uploaded ``.pptx`` already shows as slides — the upload path extracts
    it with :func:`~langchain_canvas.deck.extract_slides`. But it shows from
    under ``sources/``, where the user's originals are read-only, and under
    its own name, which no exporter matches. So it can be looked at and
    nothing else.

    ``open_deck_for_editing`` copies it out: each slide's structure rendered
    into dialect-compliant baseline HTML, written to a ``.slides.html`` deck
    at the canvas root, which edits and exports like any deck the agent
    builds. The copy names the original as its ``lcx:source`` meta, so
    exporting rebuilds on the real masters and layouts rather than a blank
    page. ``read_deck_slide``/``edit_deck_slide``/``list_deck_slides`` then
    work one slide at a time, without resending or rewriting the whole deck.

    Kept out of :func:`create_canvas_tools` so the four standard tools stay a
    stable contract; mount this when your agent should edit decks people send.
    """

    @tool
    def open_deck_for_editing(
        source: str,
        runtime: ToolRuntime,
        destination: str | None = None,
    ) -> str:
        """Copy an uploaded PowerPoint file into an editable canvas deck.

        `source` is the uploaded `.pptx` (usually under `sources/`). The copy
        lands at the canvas root as a `.slides.html` deck you can inspect
        with `list_deck_slides` and edit one slide at a time with
        `read_deck_slide`/`edit_deck_slide`; pass `destination` to name it
        yourself. The upload stays where it is, unchanged.

        The copy keeps each slide's shapes, text, pictures and speaker notes,
        and points at the original as its source so an export rebuilds on
        the original's masters. Tables, charts and grouped shapes do not come
        across — read the upload itself to see those.
        """
        canvas_id = _canvas_id(runtime)
        if not source.lower().endswith(".pptx"):
            return (
                f"Error: this opens .pptx files (got {source}). "
                + _other_ways_to_open(source, default_converters())
            )
        target = (destination or _deck_copy_name(source)).strip()
        if target.startswith(_SOURCES_PREFIX):
            return (
                "Error: sources/ holds the user's uploads — put the copy "
                "somewhere else (the default is the deck's name at the canvas root)."
            )
        if not target.endswith(SLIDES_HTML_SUFFIX):
            return f"Error: the copy has to be a {SLIDES_HTML_SUFFIX} file (got {target})."
        if any(info.path == target for info in store.list_files(canvas_id)):
            return (
                f"Error: {target} is already on the canvas. Edit that one, or pass "
                "`destination` to copy under another name."
            )
        try:
            got = store.read_bytes(canvas_id, source)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."

        try:
            extractions = extract_slides(got.data, path=source)
        except UnsafeArchiveError as exc:
            return f"Error: {exc}."
        except PptxImportError as exc:
            return f"Error: {exc}."

        ratio = _ratio_for_pptx(got.data)
        slides: list[SlideTemplate] = []
        for index, extraction in enumerate(extractions):
            slide_id = f"slide-{index + 1:03d}"
            for image in extraction.images:
                asset_path = f"{ASSETS_PREFIX}{image.sha}.{image.ext}"
                if not any(info.path == asset_path for info in store.list_files(canvas_id)):
                    try:
                        store.write_bytes(
                            canvas_id, asset_path, image.data, f"Asset for {source}", actor="agent"
                        )
                    except CanvasStoreError as exc:
                        return f"Error: {exc}."
            body_html = baseline_slide_html(extraction, slide_id=slide_id, ratio=ratio)
            slides.append(
                SlideTemplate(slide_id=slide_id, title=None, style_css="", body_html=body_html)
            )

        content = serialize_deck(
            Deck(title=display_title(target), ratio=ratio, source=source, slides=slides)
        )
        description = f"Copy {source} for editing"
        try:
            commit = store.write(canvas_id, target, content, description, actor="agent")
        except CanvasStoreError as exc:
            return f"Error: {exc}."

        writer = getattr(runtime, "stream_writer", None)
        if writer is not None:
            for event in events_for_commit(
                target,
                content,
                is_new=True,
                revision=commit.revision,
                description=commit.description,
            ):
                writer(event)
            for slide in slides:
                writer(
                    SlideStatus(id=target, slide_id=slide.slide_id, stage="complete").model_dump(
                        by_alias=True, exclude_none=True
                    )
                )

        return (
            f"Copied {source} to {target} ({len(slides)} slide(s), revision "
            f"{commit.revision}). Edit {target} and export it to pptx; {source} "
            "keeps the user's original."
        )

    @tool
    def read_deck_slide(path: str, slide_id: str, runtime: ToolRuntime) -> str:
        """Read one slide's `<template>` fragment out of a `.slides.html` deck.

        Returns the deck's current `revision` plus the exact fragment you can
        edit and pass back to `edit_deck_slide`. Always read a slide again
        right before editing it, so you see edits the user may have made by
        hand.
        """
        canvas_id = _canvas_id(runtime)
        if not path.endswith(SLIDES_HTML_SUFFIX):
            return f"Error: {path} is not a {SLIDES_HTML_SUFFIX} deck."
        try:
            got = store.read(canvas_id, path)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        try:
            slide = read_slide(got.content, slide_id)
        except DeckParseError as exc:
            return f"Error: {exc}."
        fragment = _serialize_template_fragment(
            slide.slide_id, slide.title, slide.style_css, slide.body_html
        )
        return f"revision: {got.revision}\n{fragment}"

    @tool
    def list_deck_slides(path: str, runtime: ToolRuntime) -> str:
        """List a `.slides.html` deck's slide ids and titles, in order."""
        canvas_id = _canvas_id(runtime)
        if not path.endswith(SLIDES_HTML_SUFFIX):
            return f"Error: {path} is not a {SLIDES_HTML_SUFFIX} deck."
        try:
            got = store.read(canvas_id, path)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        try:
            deck = parse_deck(got.content)
        except DeckParseError as exc:
            return f"Error: {exc}."
        if not deck.slides:
            return f"{path} has no slides."
        return "\n".join(
            f"{slide.slide_id}: {slide.title or '(untitled)'}" for slide in deck.slides
        )

    @tool
    def edit_deck_slide(
        path: str, slide_id: str, template_html: str, revision: str, runtime: ToolRuntime
    ) -> str:
        """Replace one slide's `<template>` fragment in a `.slides.html` deck.

        `template_html` is a full `<template data-slide-id="...">...
        </template>` fragment for `slide_id` — read one with `read_deck_slide`
        first, then send back the edited fragment. `revision` must be the
        value from your most recent `read_deck_slide`/`list_deck_slides` of
        this file; if the deck changed since, the call is rejected and you
        must read again. The fragment is sanitized against an HTML allowlist
        before it is saved, and every other slide's bytes are left untouched
        — even a byte-identical duplicate slide is never affected, because
        the match is on `slide_id`, never on content.
        """
        canvas_id = _canvas_id(runtime)
        if not path.endswith(SLIDES_HTML_SUFFIX):
            return f"Error: {path} is not a {SLIDES_HTML_SUFFIX} deck."
        try:
            got = store.read(canvas_id, path)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."

        try:
            incoming = _parse_incoming_template(template_html, slide_id)
        except DeckParseError as exc:
            return f"Error: {exc}."

        body_result = sanitize_slide_html(incoming.body_html)
        removed = list(body_result.removed)
        style_css = incoming.style_css
        if style_css:
            style_result = sanitize_slide_html(f"<style>{style_css}</style>")
            removed += style_result.removed
            style_css = style_result.html.removeprefix("<style>").removesuffix("</style>")

        issues = validate_slide_html(body_result.html, slide_id=slide_id)
        if issues:
            return "Error: " + "; ".join(issue.message for issue in issues)

        new_fragment = _serialize_template_fragment(
            slide_id, incoming.title, style_css, body_result.html
        )
        try:
            new_deck_html = patch_slide(got.content, slide_id, new_fragment)
        except DeckParseError as exc:
            return f"Error: {exc}."

        description = f"Edit slide {slide_id}"
        try:
            commit = store.write(
                canvas_id, path, new_deck_html, description, base_revision=revision, actor="agent"
            )
        except RevisionMismatchError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except CanvasStoreError as exc:
            return f"Error: {exc}."

        writer = getattr(runtime, "stream_writer", None)
        if writer is not None:
            writer(
                CanvasSlidePatch(id=path, slide_id=slide_id, template_html=new_fragment).model_dump(
                    by_alias=True, exclude_none=True
                )
            )
            writer(
                CanvasCommit(id=path, description=description, revision=commit.revision).model_dump(
                    by_alias=True, exclude_none=True
                )
            )
        removed_note = f" Removed unsafe content: {', '.join(removed)}." if removed else ""
        return f"Edited slide {slide_id} in {path} (revision {commit.revision}).{removed_note}"

    return [open_deck_for_editing, read_deck_slide, edit_deck_slide, list_deck_slides]
