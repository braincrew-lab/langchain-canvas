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
    inline_slides_assets,
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
    ensure_archive_within_limits,
)
from .exporters import (
    DEFAULT_SLIDE_PAGE_IN,
    Exporter,
    MissingExporterDependencyError,
    default_exporters,
    exporter_for,
    pptx_page_size_inches,
)
from .formulas import SUPPORTED_FORMULA_FUNCTIONS, formula_guidance
from .replay import ARTIFACT_SUFFIXES, events_for_commit
from .store import (
    BinaryContentError,
    CanvasFileNotFoundError,
    CanvasStore,
    CanvasStoreError,
    Commit,
    EditConflictError,
    RevisionMismatchError,
)

_RETRY_HINT = "Call read_canvas again and retry with the fresh revision and exact content."
_SOURCES_PREFIX = "sources/"
_SOURCES_READONLY = (
    "Error: files under sources/ are the user's original uploads and are "
    "read-only for the agent. Create a new canvas file instead (for example "
    "an .html page or a .table.json table)."
)
_DEFAULT_READ_LIMIT = 400


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


def _refit_slides_to_page(
    data: dict, old_w: float, old_h: float, new_w: float, new_h: float
) -> None:
    """Re-project existing free elements onto a page with another size.

    Filling ``page`` changes the coordinate space the percent geometry
    refers to; leaving the numbers behind silently stretched every shape
    (a circle became ratio 0.750 on a 4:3 skin). This applies the same
    uniform-scale + center letterbox the exporter uses — at save time, so
    the stored deck already means the same picture on the new page.
    Structured slides (title / bullets, no elements) stay untouched: their
    derived layout is defined in page percent and redraws for any ratio.
    Font sizes ride the same uniform scale as the geometry — the exporter
    treats px as an absolute size in the deck's coordinate space, so
    scaling both keeps this exactly the file the old exporter-side
    projection produced for a page-less deck.

    The projection routes through the classic canvas: undo the letterbox
    that placed the content on the OLD page, then apply the NEW page's.
    A direct old-to-new min-scale is not invertible (4:3 to wide keeps
    scale 1, wide back to 4:3 shrinks by 0.75), so a skin swap would
    neither match a from-scratch deck nor survive a round trip. Composed
    through the canvas both hold; a first attach (old == canvas) reduces
    to the plain letterbox.
    """
    canvas_w, canvas_h = DEFAULT_SLIDE_PAGE_IN
    scale_old = min(old_w / canvas_w, old_h / canvas_h)
    scale_new = min(new_w / canvas_w, new_h / canvas_h)
    scale = scale_new / scale_old
    offset_x = (new_w - canvas_w * scale_new) / 2.0 - (
        (old_w - canvas_w * scale_old) / 2.0
    ) * scale
    offset_y = (new_h - canvas_h * scale_new) / 2.0 - (
        (old_h - canvas_h * scale_old) / 2.0
    ) * scale
    font_factor = scale
    for slide in data.get("slides") or []:
        if not isinstance(slide, dict):
            continue
        elements = slide.get("elements")
        if not isinstance(elements, list) or not elements:
            continue
        # The exporter applies `padding` in the NEW space too, so solve the
        # stored percents back out of the projected on-page position.
        pad = (slide.get("padding") or 0.0) / 100.0
        span = 1.0 - 2.0 * pad
        for el in elements:
            if not isinstance(el, dict):
                continue
            try:
                ex = pad + (float(el["x"]) / 100.0) * span
                ey = pad + (float(el["y"]) / 100.0) * span
                ew = (float(el["w"]) / 100.0) * span
                eh = (float(el["h"]) / 100.0) * span
            except (KeyError, TypeError, ValueError):
                continue  # malformed element — the exporter reports it later
            el["x"] = round(((offset_x + ex * old_w * scale) / new_w - pad) / span * 100.0, 4)
            el["y"] = round(((offset_y + ey * old_h * scale) / new_h - pad) / span * 100.0, 4)
            el["w"] = round(ew * old_w * scale / new_w / span * 100.0, 4)
            el["h"] = round(eh * old_h * scale / new_h / span * 100.0, 4)
            font = el.get("fontSize", el.get("font_size"))
            if isinstance(font, (int, float)):
                key = "fontSize" if "fontSize" in el else "font_size"
                el[key] = round(font * font_factor, 4)


def _deck_with_skin_page(
    store: CanvasStore, canvas_id: str, content: str
) -> tuple[str, str | None, str | None]:
    """The deck content with ``page`` filled from its template skin.

    A deck that names a template gets the skin's real page size written
    into ``data.page``, so the editor, the preview, and the export agree
    on one aspect ratio — the agent never types the numbers by hand. The
    skin decides the page on a swap too: a deck whose page no longer
    matches its template is re-fitted from its CURRENT page, otherwise the
    content stays stranded in the old ratio's letterbox with no way out
    through coordinates alone. When the size changes the existing elements
    are re-fitted (see :func:`_refit_slides_to_page`); when the RATIO
    changes the third return value carries a note to relay — the change is
    safe but the content now sits letterboxed, and re-placing it is the
    model's call, never a silent one. A deck without a template keeps
    whatever page it has. Content that is not a template-bearing
    envelope passes through untouched (the exporter raises its own honest
    errors later). Returns ``(content, error, note)``: a skin that trips
    the archive safety limits is an error to relay, not a detail to
    absorb.
    """
    try:
        envelope = json.loads(content)
    except json.JSONDecodeError:
        return content, None, None
    data = envelope.get("data") if isinstance(envelope, dict) else None
    if not isinstance(data, dict):
        return content, None, None
    template = data.get("template")
    if not isinstance(template, str) or not template.lower().endswith(".pptx"):
        return content, None, None
    ref = normalize_asset_reference(template)
    if ref is None:
        return content, None, None
    try:
        raw = store.read_bytes(canvas_id, ref).data
    except CanvasStoreError:
        return content, None, None  # missing skin degrades at export time too
    try:
        ensure_archive_within_limits(raw, path=ref)
    except UnsafeArchiveError as exc:
        return content, f"Error: {exc}", None
    size = pptx_page_size_inches(raw)
    if size is None:
        return content, None, None
    new_w, new_h = round(size[0], 4), round(size[1], 4)
    # "The skin decides the page" holds on a swap too, not only on the first
    # attach: the deck's current page is the OLD coordinate space to re-fit
    # from. A deck whose page already matches the skin passes untouched.
    old_w, old_h = DEFAULT_SLIDE_PAGE_IN
    page = data.get("page")
    if isinstance(page, dict):
        got_w = page.get("widthIn", page.get("width_in"))
        got_h = page.get("heightIn", page.get("height_in"))
        if (
            isinstance(got_w, (int, float))
            and isinstance(got_h, (int, float))
            and got_w > 0
            and got_h > 0
        ):
            if abs(got_w - new_w) < 1e-4 and abs(got_h - new_h) < 1e-4:
                return content, None, None
            old_w, old_h = float(got_w), float(got_h)
    data["page"] = {"widthIn": new_w, "heightIn": new_h}
    note = None
    if abs(new_w - old_w) > 1e-4 or abs(new_h - old_h) > 1e-4:
        # Any size change re-fits: with the same ratio the percents come out
        # unchanged and only font sizes ride the physical scale, so the
        # stored deck exports exactly like the un-swapped one did.
        _refit_slides_to_page(data, old_w, old_h, new_w, new_h)
    if abs(new_w / new_h - old_w / old_h) > 1e-6:
        note = (
            f" Note: page changed to {new_w} x {new_h} in to match the "
            "template. Existing slides were re-fitted without distortion; "
            "re-place their elements for the new ratio if you want the "
            "full page."
        )
    return json.dumps(envelope, ensure_ascii=False), None, note


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
        header = f"revision: {got.revision}\nconverted view of {path}" + (
            f" ({meta})" if meta else ""
        )
        body = f"{header}\n{sliced}" + (f"\n{note}" if note else "")
        images = [block for block in converted.blocks if block.get("type") == "image"]
        if images:
            return [{"type": "text", "text": body}, *images]
        return body

    @tool
    def read_canvas(
        path: str,
        runtime: ToolRuntime,
        offset: int = 0,
        limit: int = _DEFAULT_READ_LIMIT,
        pages: str | None = None,
    ) -> str | list[dict]:
        """Read one canvas file before viewing or editing it.

        Returns the file with line numbers plus the current `revision`. You
        need that revision to call `edit_canvas` or to safely overwrite with
        `write_canvas` — always read a file again right before editing it, so
        you see edits the user may have made by hand.

        Long files are windowed: `offset`/`limit` select a line range and the
        output says how to read the rest. Binary uploads under `sources/` are
        rendered through a format converter instead of raw bytes.

        Page-renderable sources (.pdf) can also be *seen*: observe cheaply
        first — the default text view names the page count and which pages
        have no text layer — then `pages="grid"` for a one-shot thumbnail
        overview of every page, then `pages="3"` / `"2-5"` / `"1,4,7"` to
        render just the pages that matter (scans, charts, layout questions)
        as images. At most 8 page images per call.
        """
        canvas_id = _canvas_id(runtime)
        if pages is not None:
            return _read_source_pages(canvas_id, path, pages)
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
        sliced, note = _sliced(got.content, offset, limit)
        return f"revision: {got.revision}\n{sliced}" + (f"\n{note}" if note else "")

    @tool
    def write_canvas(
        path: str,
        content: str,
        description: str,
        runtime: ToolRuntime,
        revision: str | None = None,
    ) -> str:
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

        Structured files carry an envelope: a `.slides.json` deck is
        `{"type": "slides", "title": "...", "data": {"slides": [...]}}`.
        Each slide is either structured (`title` / `subtitle` / `bullets` /
        `image` / `layout`) or free elements (`elements` with `type`
        text|image|shape and `x`/`y`/`w`/`h` as percent of the slide,
        0-100; `fontSize` in px, colors as `#hex` strings). Optional per
        slide: `background` (a `#hex` string), `notes`. Optional deck-level
        `"template": "sources/brand.pptx"` makes the pptx export build on
        that file's masters and layouts. A `.table.json` sheet is
        `{"type": "table", "data": {"sheet": {...}}}`.
        """
        if path.startswith(_SOURCES_PREFIX):
            return _SOURCES_READONLY
        canvas_id = _canvas_id(runtime)
        page_note = None
        if path.lower().endswith(".slides.json"):
            content, page_error, page_note = _deck_with_skin_page(
                store, canvas_id, content
            )
            if page_error is not None:
                return page_error
        is_new = not _has_file(canvas_id, path)
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
        return f"Wrote {path} (revision {commit.revision}).{page_note or ''}"

    @tool
    def edit_canvas(
        path: str,
        old: str,
        new: str,
        description: str,
        revision: str,
        runtime: ToolRuntime,
    ) -> str:
        """Replace exactly one occurrence of `old` with `new` in a canvas file.

        `revision` must be the value returned by your most recent
        `read_canvas` of this file — if the file changed since (for example
        the user edited it), the call is rejected and you must read again.
        `old` must match exactly once; include enough surrounding context to
        make it unique. `description` is the version-history entry. Files
        under `sources/` (the user's uploads) are read-only.
        """
        if path.startswith(_SOURCES_PREFIX):
            return _SOURCES_READONLY
        canvas_id = _canvas_id(runtime)
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
        return f"Edited {path} (revision {commit.revision})."

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

    return [read_canvas, write_canvas, edit_canvas, list_canvas_files]


def create_export_tool(store: CanvasStore, *, exporters: list[Exporter] | None = None) -> Any:
    """Build an ``export_canvas`` tool bound to ``store``.

    Kept separate from :func:`create_canvas_tools` so the four standard tools
    stay a stable contract — add this tool when your agent should hand users
    office files. ``exporters`` defaults to the built-in set (see
    :mod:`langchain_canvas.exporters`) and is fully replaceable with your own
    pipeline. Exported files land on the canvas under ``exports/``.
    """
    active_exporters = default_exporters() if exporters is None else exporters

    @tool
    def export_canvas(path: str, target: str, runtime: ToolRuntime) -> str:
        """Export canvas work into a downloadable office file.

        ``path`` is one canvas file (``report/02-overview.html``,
        ``sales.table.json``) or a directory prefix ending in ``/``
        (``report/``), which merges every .html file under it, in name
        order, into one document with a page break between sections.
        ``target`` is the output format: ``docx`` for .html files,
        ``xlsx`` for .table.json tables, ``pptx`` for .slides.json decks.
        The result is saved under ``exports/`` on the canvas, where the
        user can download it.

        Template skin: a slides deck whose data carries
        ``"template": "sources/brand.pptx"`` exports onto that file's
        masters and layouts, so the original's logos, backgrounds, and
        headers survive. A missing or unreadable skin degrades to the
        plain blank-layout export.
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
                "(.html, .table.json, .slides.json)."
            )

        # Relative asset references (assets/, sources/) become data: URIs here,
        # before the exporter runs — exporters keep their one-method contract
        # and the exported file leaves self-contained, images included.
        if sample.lower().endswith((".html", ".htm")):
            content = inline_canvas_assets(content, store, canvas_id)
        elif sample.lower().endswith(".slides.json"):
            content = inline_slides_assets(content, store, canvas_id)

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
        return (
            f"Exported {path} to {out_path} ({len(exported.data)} bytes, revision "
            f"{commit.revision}). The user can download it from the canvas file list."
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
