"""Exporters — canvas files converted into deliverable office formats.

The mirror of :mod:`converters`: converters absorb what users bring in
(``sources/`` bytes -> content blocks), exporters produce what users take
away (canvas files -> office formats). Collaboration stays on the canvas
source files; an exported ``.docx`` or ``.xlsx`` is a snapshot at the door.

An :class:`Exporter` turns one canvas file's text into an
:class:`ExportedFile` (bytes + filename + media type). Exporters are
pluggable: pass your own list to ``create_export_tool`` to replace or extend
the defaults — an in-house rendering pipeline implements the same one-method
contract. Built-in exporters that need a writer library import it lazily and
raise :class:`MissingExporterDependencyError` with an install hint when
absent, so the core package stays dependency-free.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, Protocol, runtime_checkable

from .converters import ensure_archive_within_limits
from .protocol.artifacts import Slide, SlideElement, SlidesData
from .table_merge import merge_rows_into_sheet

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


@dataclass(frozen=True)
class ExportedFile:
    """One export result: raw bytes plus how to save or serve them."""

    data: bytes
    filename: str
    media_type: str


@runtime_checkable
class Exporter(Protocol):
    """The pluggable contract: one canvas file's text in, a file out."""

    suffixes: tuple[str, ...]
    """Canvas-path suffixes this exporter reads (lowercase, with the dot)."""

    target: str
    """Output format key (``"docx"``, ``"xlsx"``, ...) — what users ask for."""

    def export(self, content: str, *, path: str, title: str | None = None) -> ExportedFile:
        """Convert one file. ``path`` names the source for filenames/messages."""
        ...


class MissingExporterDependencyError(RuntimeError):
    """A built-in exporter's writer library is not installed.

    The message names the missing package and the extra that installs it, so
    the export tool can relay an honest, actionable error to the agent.
    """


def exporter_for(path: str, target: str, exporters: list[Exporter]) -> Exporter | None:
    """The first exporter matching ``path``'s suffix and the ``target`` format."""
    lowered = path.lower()
    wanted = target.lower().lstrip(".")
    for exporter in exporters:
        if exporter.target == wanted and lowered.endswith(exporter.suffixes):
            return exporter
    return None


def _stem(path: str) -> str:
    """The output filename stem for a canvas path (or directory prefix)."""
    name = path.rstrip("/").rsplit("/", 1)[-1]
    for suffix in (".table.json", ".slides.json", ".html", ".htm"):
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)]
            break
    return name or "export"


class TableXlsxExporter:
    """``.table.json`` tables as Excel workbooks.

    Values first: the ``columns``/``rows`` shape becomes one sheet with a
    bold header row; an edited Fortune-sheet state (``data.sheet``) exports
    every sheet's cell values and merged ranges. Formula cells stay live
    formulas in the workbook (an ``=``-prefixed row value, or a typed
    formula's ``f`` field in the sheet state) — spreadsheet apps recalculate
    them on open. Rich per-cell styling stays with the browser export menu
    or an adopter's pipeline. Requires ``openpyxl`` — installed by the
    ``xlsx`` extra.
    """

    suffixes: tuple[str, ...] = (".table.json",)
    target: str = "xlsx"

    def export(self, content: str, *, path: str, title: str | None = None) -> ExportedFile:
        try:
            from openpyxl import Workbook  # type: ignore[import-untyped]
            from openpyxl.styles import Font  # type: ignore[import-untyped]
        except ImportError as exc:
            raise MissingExporterDependencyError(
                "exporting .table.json to xlsx needs openpyxl — install "
                "langchain-canvas[xlsx] or register your own exporter"
            ) from exc

        try:
            artifact = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path} does not contain valid table JSON") from exc
        data = artifact.get("data") or {}

        workbook = Workbook()
        default_sheet = workbook.active
        if default_sheet is not None:
            workbook.remove(default_sheet)

        # Rows the agent wrote after the person's last edit are merged into the
        # sheet state first, so the export never drops an agent change.
        sheets = data.get("sheet") or []
        if sheets and data.get("columns"):
            sheets = (
                merge_rows_into_sheet(data["columns"], data.get("rows") or [], sheets) or sheets
            )
        for sheet in sheets:
            ws = workbook.create_sheet(str(sheet.get("name") or "Sheet1"))
            for cell in sheet.get("celldata") or []:
                v = cell.get("v")
                # A typed formula lives in ``f`` — keep it a formula (openpyxl
                # stores no cached value; spreadsheet apps recalculate on open).
                formula = v.get("f") if isinstance(v, dict) else None
                value: Any
                if isinstance(formula, str) and formula:
                    value = formula if formula.startswith("=") else "=" + formula
                elif isinstance(v, dict):
                    value = v.get("v") if v.get("v") is not None else v.get("m")
                else:
                    value = v
                ws.cell(row=int(cell["r"]) + 1, column=int(cell["c"]) + 1, value=value)
            for merge in ((sheet.get("config") or {}).get("merge") or {}).values():
                try:
                    ws.merge_cells(
                        start_row=merge["r"] + 1,
                        start_column=merge["c"] + 1,
                        end_row=merge["r"] + merge["rs"],
                        end_column=merge["c"] + merge["cs"],
                    )
                except (KeyError, ValueError):
                    continue  # overlapping/invalid merge ranges — keep the values

        if not workbook.worksheets:
            ws = workbook.create_sheet("Sheet1")
            columns = data.get("columns") or []
            if columns:
                keys = [column.get("key") for column in columns]
                ws.append([column.get("label") or column.get("key") for column in columns])
                for header_cell in ws[1]:
                    header_cell.font = Font(bold=True)
                for row in data.get("rows") or []:
                    ws.append([row.get(key) for key in keys])

        out = io.BytesIO()
        workbook.save(out)
        return ExportedFile(out.getvalue(), f"{_safe_name(title) or _stem(path)}.xlsx", XLSX_MIME)


# --- html -> docx ----------------------------------------------------------------

_SKIP_TAGS = {"style", "script", "title"}
_PARA_TAGS = {"p", "div", "section", "article", "header", "footer", "blockquote"}
_HEADING_TAGS = {"h1", "h2", "h3", "h4"}


@dataclass
class _Run:
    text: str
    bold: bool
    italic: bool


class _HtmlOutline(HTMLParser):
    """Linearize an HTML document into export blocks.

    Blocks are tuples: ``("heading", level, runs)``, ``("para", runs)``,
    ``("bullet", runs)``, ``("table", rows, has_header)``, ``("page_break",)``
    and ``("image", bytes)``. Inline bold/italic survive as run flags;
    style/script content is dropped.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[tuple[Any, ...]] = []
        self._runs: list[_Run] = []
        self._kind: tuple[Any, ...] = ("para",)
        self._bold = 0
        self._italic = 0
        self._skip = 0
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None
        self._has_header = False

    def finish(self) -> None:
        self.close()
        self._flush()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP_TAGS:
            self._skip += 1
            return
        if self._skip:
            return
        if self._table is not None:
            if tag == "tr":
                self._row = []
            elif tag in ("td", "th"):
                self._cell = []
                if tag == "th":
                    self._has_header = True
            return
        if tag == "table":
            self._flush()
            self._table = []
            self._has_header = False
        elif tag in _HEADING_TAGS:
            self._flush()
            self._kind = ("heading", int(tag[1]))
        elif tag == "li":
            self._flush()
            self._kind = ("bullet",)
        elif tag in _PARA_TAGS:
            self._flush()
        elif tag in ("b", "strong"):
            self._bold += 1
        elif tag in ("i", "em"):
            self._italic += 1
        elif tag == "br":
            self._runs.append(_Run("\n", False, False))
        elif tag == "hr":
            self._flush()
            self.blocks.append(("page_break",))
        elif tag == "img":
            data = _data_uri_bytes(dict(attrs).get("src") or "")
            if data:
                self._flush()
                self.blocks.append(("image", data))

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
            return
        if self._skip:
            return
        if self._table is not None:
            if tag in ("td", "th") and self._cell is not None:
                if self._row is None:
                    self._row = []
                self._row.append(_squash("".join(self._cell)).strip())
                self._cell = None
            elif tag == "tr" and self._row is not None:
                self._table.append(self._row)
                self._row = None
            elif tag == "table":
                if self._table:
                    self.blocks.append(("table", self._table, self._has_header))
                self._table = None
            return
        if tag in _HEADING_TAGS or tag == "li" or tag in _PARA_TAGS:
            self._flush()
        elif tag in ("b", "strong"):
            self._bold = max(0, self._bold - 1)
        elif tag in ("i", "em"):
            self._italic = max(0, self._italic - 1)

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        if self._cell is not None:
            self._cell.append(data)
            return
        if self._table is not None:
            return
        squashed = _squash(data)
        if squashed.strip() or self._runs:
            self._runs.append(_Run(squashed, self._bold > 0, self._italic > 0))

    def _flush(self) -> None:
        runs, self._runs = self._runs, []
        kind, self._kind = self._kind, ("para",)
        trimmed = _trim_runs(runs)
        if trimmed:
            self.blocks.append((*kind, trimmed))


def _squash(text: str) -> str:
    return re.sub(r"[ \t\r\f\v]*\n[ \t\r\f\v]*|[ \t\r\f\v]+", lambda m: "\n" if "\n" in m.group(0) else " ", text)


def _trim_runs(runs: list[_Run]) -> list[_Run]:
    """Strip outer whitespace from a run list; drop it entirely when blank."""
    if not "".join(run.text for run in runs).strip():
        return []
    trimmed = list(runs)
    trimmed[0] = _Run(trimmed[0].text.lstrip(), trimmed[0].bold, trimmed[0].italic)
    trimmed[-1] = _Run(trimmed[-1].text.rstrip(), trimmed[-1].bold, trimmed[-1].italic)
    return [run for run in trimmed if run.text]


def _data_uri_bytes(src: str) -> bytes | None:
    match = re.match(r"^data:image/(?:png|jpe?g|gif);base64,(.+)$", src.strip(), re.IGNORECASE)
    if not match:
        return None
    try:
        return base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError):
        return None


def _pptx_data_uri_bytes(src: str | None) -> bytes | None:
    """The pptx bytes of an inlined template skin, or ``None``.

    A non-data-URI value here means the skin reference could not be inlined
    (file missing, wrong type) — the caller degrades to the blank export.
    """
    if not src:
        return None
    match = re.match(
        rf"^data:{re.escape(PPTX_MIME)};base64,(.+)$", src.strip(), re.IGNORECASE
    )
    if not match:
        return None
    try:
        return base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError):
        return None


def pptx_page_size_inches(data: bytes) -> tuple[float, float] | None:
    """The (width, height) a pptx declares, in inches, or ``None``.

    Reads only ``ppt/presentation.xml``'s ``sldSz`` attributes out of the
    ZIP — no python-pptx needed — so tools can learn a skin's page size
    cheaply. Callers gate the bytes with ``ensure_archive_within_limits``
    first when they come from an untrusted upload.
    """
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            xml = archive.read("ppt/presentation.xml").decode("utf-8", "replace")
    except (zipfile.BadZipFile, KeyError):
        return None
    match = re.search(r'<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"', xml)
    if match is None:
        match = re.search(r'<p:sldSz[^>]*\bcy="(\d+)"[^>]*\bcx="(\d+)"', xml)
        if match is None:
            return None
        cy, cx = match.group(1), match.group(2)
    else:
        cx, cy = match.group(1), match.group(2)
    return int(cx) / _EMU_PER_INCH, int(cy) / _EMU_PER_INCH


def _skin_presentation(template: str | None, presentation_cls: Any) -> Any | None:
    """The template skin opened as the base presentation, or ``None``.

    Drops the skin's own slides — the deck's content replaces them — while
    its masters and layouts (logos, backgrounds, headers) stay and style
    every slide added on top. Unreadable skin bytes degrade to ``None`` so
    the export never dies on a bad template; a skin whose ZIP container
    exceeds the safety limits raises ``UnsafeArchiveError`` instead — a
    decompression bomb is an attack to refuse loudly, not a formatting
    mishap to absorb.
    """
    data = _pptx_data_uri_bytes(template)
    if data is None:
        return None
    ensure_archive_within_limits(data, path="the template skin")
    try:
        base = presentation_cls(io.BytesIO(data))
        id_list = base.slides._sldIdLst
        for slide_id in list(id_list):
            base.part.drop_rel(slide_id.rId)
            id_list.remove(slide_id)
    except Exception:  # noqa: BLE001 — any parse failure means "not a usable skin"
        return None
    return base


def _content_layout(presentation: Any) -> Any:
    """The least-furnished layout — the closest thing to a blank canvas.

    Prefers a layout literally named "Blank" (the stock template's index 6),
    else the one with the fewest placeholders, so skinned exports draw on
    the emptiest surface the template offers while inheriting its master.
    """
    layouts = [
        layout
        for master in presentation.slide_masters
        for layout in master.slide_layouts
    ]
    for layout in layouts:
        if (layout.name or "").strip().lower() == "blank":
            return layout
    return min(layouts, key=lambda layout: len(layout.placeholders))


def _safe_name(title: str | None) -> str | None:
    if not title or not title.strip():
        return None
    return re.sub(r"[\s/\\]+", "-", title.strip())


class HtmlDocxExporter:
    """``.html`` pages as Word documents.

    A deliberate subset survives the trip: headings (h1-h4), paragraph text
    with inline bold/italic, bullet items, flat tables, page breaks (``hr``)
    and ``data:``-URI images. CSS layout does not — the canvas file stays the
    source of truth; the ``.docx`` is a snapshot at the door. Requires
    ``python-docx`` — installed by the ``office`` extra.
    """

    suffixes: tuple[str, ...] = (".html", ".htm")
    target: str = "docx"

    def export(self, content: str, *, path: str, title: str | None = None) -> ExportedFile:
        try:
            from docx import Document  # type: ignore[import-untyped]
            from docx.enum.text import WD_BREAK  # type: ignore[import-untyped]
            from docx.shared import Inches  # type: ignore[import-untyped]
        except ImportError as exc:
            raise MissingExporterDependencyError(
                "exporting .html to docx needs python-docx — install "
                "langchain-canvas[office] or register your own exporter"
            ) from exc

        outline = _HtmlOutline()
        outline.feed(content)
        outline.finish()

        document = Document()
        for block in outline.blocks:
            kind = block[0]
            if kind == "heading":
                paragraph = document.add_heading("", level=min(int(block[1]), 4))
                _add_runs(paragraph, block[2])
            elif kind == "bullet":
                _add_runs(document.add_paragraph(style="List Bullet"), block[1])
            elif kind == "para":
                _add_runs(document.add_paragraph(), block[1])
            elif kind == "table":
                _add_table(document, block[1], block[2])
            elif kind == "page_break":
                document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            elif kind == "image":
                try:
                    document.add_picture(io.BytesIO(block[1]), width=Inches(6))
                except Exception:  # noqa: BLE001 — corrupt image data; keep the document
                    continue

        out = io.BytesIO()
        document.save(out)
        return ExportedFile(out.getvalue(), f"{_safe_name(title) or _stem(path)}.docx", DOCX_MIME)


def _add_runs(paragraph: Any, runs: list[_Run]) -> None:
    for run in runs:
        added = paragraph.add_run(run.text)
        if run.bold:
            added.bold = True
        if run.italic:
            added.italic = True


def _add_table(document: Any, rows: list[list[str]], has_header: bool) -> None:
    width = max(len(row) for row in rows)
    if not width:
        return
    table = document.add_table(rows=len(rows), cols=width)
    table.style = "Table Grid"
    for i, row in enumerate(rows):
        for j, value in enumerate(row):
            cell = table.cell(i, j)
            cell.text = value
            if has_header and i == 0:
                for run in cell.paragraphs[0].runs:
                    run.bold = True


# --- slides -> pptx --------------------------------------------------------

# The editor's slide canvas is 1280x720 px; the exported deck is 10 x 5.625
# inches (16:9) — the same page the browser-side pptx export uses, so the two
# doors produce the same-looking deck. Element geometry is percent-based.
_SLIDE_WIDTH_IN = 10.0
_SLIDE_HEIGHT_IN = 5.625
# python-pptx page dimensions are Emu integers (914400 per inch).
_EMU_PER_INCH = 914400
# Element font sizes are px on the 1280px-wide slide; PowerPoint wants points.
_PX_TO_PT = 0.75
_DEFAULT_FONT_PX = 24.0
_DEFAULT_SHAPE_FILL = "5B5BD6"

_HEX_COLOR_PATTERN = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _hex_rgb(value: str | None) -> str | None:
    """A 6-digit RGB hex string for a ``#rgb`` / ``#rrggbb`` color, else None."""
    if not value:
        return None
    match = _HEX_COLOR_PATTERN.match(value.strip())
    if not match:
        return None
    digits = match.group(1)
    if len(digits) == 3:
        digits = "".join(ch * 2 for ch in digits)
    return digits.upper()


def _derived_slide_elements(slide: Slide) -> list[SlideElement]:
    """Movable elements derived from a slide's structured shape.

    The twin of ``toElements`` in ``canvas-react/src/client/slideElements.ts``
    — same layouts, same geometry, same font sizes — so a deck an agent wrote
    structurally exports the way the canvas renders it. An explicit
    ``elements`` array (the user has edited) wins over derivation; that
    preference lives in :func:`_resolved_slide_elements`.
    """
    layout = slide.layout or "content"
    elements: list[SlideElement] = []

    def push(element_id: str, **kwargs: Any) -> None:
        kwargs.setdefault("color", slide.text_color)
        elements.append(SlideElement(id=element_id, **kwargs))

    if layout in ("title", "section"):
        if slide.title:
            push(
                "title", type="text", x=10, y=34, w=80, h=18, text=slide.title,
                font_size=54 if layout == "title" else 40, bold=True, align="center",
            )
        if slide.subtitle:
            push(
                "subtitle", type="text", x=10, y=58, w=80, h=8,
                text=slide.subtitle, font_size=24, align="center",
            )
    elif layout == "image":
        if slide.title:
            push(
                "title", type="text", x=6, y=6, w=88, h=10, text=slide.title,
                font_size=28, bold=True,
            )
        if slide.image:
            elements.append(
                SlideElement(id="img", type="image", x=14, y=20, w=72, h=66, src=slide.image)
            )
    elif layout == "two-column":
        if slide.title:
            push(
                "title", type="text", x=6, y=6, w=88, h=10, text=slide.title,
                font_size=28, bold=True,
            )
        for i, bullet in enumerate(slide.bullets):
            push(f"bul_{i}", type="text", x=6, y=24 + i * 8, w=42, h=7, text=f"• {bullet}", font_size=18)
        for i, bullet in enumerate(slide.bullets2):
            push(f"bul2_{i}", type="text", x=52, y=24 + i * 8, w=42, h=7, text=f"• {bullet}", font_size=18)
    else:
        if slide.title:
            push(
                "title", type="text", x=6, y=8, w=88, h=10, text=slide.title,
                font_size=32, bold=True,
            )
        for i, bullet in enumerate(slide.bullets):
            push(f"bul_{i}", type="text", x=8, y=28 + i * 9, w=84, h=8, text=f"• {bullet}", font_size=20)
    return elements


def _resolved_slide_elements(slide: Slide) -> list[SlideElement]:
    """What is actually on the slide: explicit edits win, else derive."""
    return slide.elements if slide.elements else _derived_slide_elements(slide)


class SlidesPptxExporter:
    """``.slides.json`` decks as editable PowerPoint files.

    Every element lands as a real shape — text boxes with runs, pictures,
    drawing shapes — never a rendered bitmap, so the received file reopens
    fully editable. What survives the trip: percent geometry mapped onto a
    16:9 page (padding insets included), text with size / bold / color /
    alignment, ``data:``-URI images (png / jpeg / gif) placed contained in
    their box, rect / ellipse / line shapes, solid ``#hex`` slide
    backgrounds, and speaker notes. Structured slides (title / bullets /
    layout) derive the same elements the canvas renders.

    Template skins: when the deck's ``template`` field references a pptx
    (inlined to a data URI before export), the export opens that file as its
    base — the skin's masters and layouts style every slide, so the
    original's logos, backgrounds, and headers survive; the skin's own
    slides are dropped and its native page size is kept (percent geometry
    projects onto any page). A missing or unreadable skin degrades to the
    blank default below.

    Honest limits: without a skin there is no master or theme (elements sit
    on a blank 16:9 layout); the canvas preview never renders the skin
    (export-time only); no animations, transitions, or SmartArt; image/url
    backgrounds are skipped; an explicit slide ``background`` paints over
    the skin's; non-data-URI image references are skipped (inline assets
    before exporting); fonts fall back to whatever the viewer has installed.
    Requires ``python-pptx`` — installed by the ``office`` extra.
    """

    suffixes: tuple[str, ...] = (".slides.json",)
    target: str = "pptx"

    def export(self, content: str, *, path: str, title: str | None = None) -> ExportedFile:
        try:
            from pptx import Presentation  # type: ignore[import-untyped]
            from pptx.dml.color import RGBColor  # type: ignore[import-untyped]
            from pptx.enum.shapes import (  # type: ignore[import-untyped]
                MSO_CONNECTOR,
                MSO_SHAPE,
            )
            from pptx.enum.text import PP_ALIGN  # type: ignore[import-untyped]
            from pptx.util import Emu, Inches, Pt  # type: ignore[import-untyped]
        except ImportError as exc:
            raise MissingExporterDependencyError(
                "exporting .slides.json to pptx needs python-pptx — install "
                "langchain-canvas[office] or register your own exporter"
            ) from exc

        try:
            envelope = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path} does not contain valid slides JSON") from exc
        if not isinstance(envelope, dict):
            raise ValueError(f"{path} does not contain a slides envelope")
        if not isinstance(envelope.get("data"), dict):
            # A deck written without the envelope used to export as one blank
            # slide — silence that hides the real mistake. Name the shape so
            # a tool-calling model can correct itself.
            raise ValueError(
                f'{path} has no "data" envelope — write slides files as '
                '{"type": "slides", "data": {"slides": [...]}} '
                "(element x/y/w/h are percent of the slide, 0-100)"
            )
        try:
            deck = SlidesData.model_validate(envelope.get("data") or {})
        except Exception as exc:  # noqa: BLE001 — pydantic detail relayed honestly
            raise ValueError(f"{path} does not contain a valid slide deck: {exc}") from exc
        envelope_title = envelope.get("title")
        if not isinstance(envelope_title, str):
            envelope_title = None

        alignments = {
            "left": PP_ALIGN.LEFT,
            "center": PP_ALIGN.CENTER,
            "right": PP_ALIGN.RIGHT,
        }
        # The deck's own page is the coordinate space its percent geometry
        # refers to; absent means the classic 16:9 canvas.
        canvas_w = deck.page.width_in if deck.page else _SLIDE_WIDTH_IN
        canvas_h = deck.page.height_in if deck.page else _SLIDE_HEIGHT_IN
        presentation = _skin_presentation(deck.template, Presentation)
        if presentation is None:
            presentation = Presentation()
            presentation.slide_width = Inches(canvas_w)
            presentation.slide_height = Inches(canvas_h)
        # A skin keeps its native page size. (The stub types the dimensions
        # Optional; a real file always carries them.)
        page_w_in = (presentation.slide_width or Inches(canvas_w)) / _EMU_PER_INCH
        page_h_in = (presentation.slide_height or Inches(canvas_h)) / _EMU_PER_INCH
        # When the page differs from the deck's canvas (a skin with another
        # aspect ratio), project with ONE uniform scale and center the
        # content — width and height stretched separately would distort
        # every shape (a circle approved on the 16:9 preview must stay a
        # circle on a 4:3 page). The leftover margins show the skin's own
        # background, which is exactly what a branded page is for.
        scale = min(page_w_in / canvas_w, page_h_in / canvas_h)
        offset_x = (page_w_in - canvas_w * scale) / 2.0
        offset_y = (page_h_in - canvas_h * scale) / 2.0
        blank_layout = _content_layout(presentation)

        for slide_model in deck.slides or [Slide()]:
            slide = presentation.slides.add_slide(blank_layout)
            background = _hex_rgb(slide_model.background)
            if background is not None:
                fill = slide.background.fill
                fill.solid()
                fill.fore_color.rgb = RGBColor.from_string(background)

            # A slide `padding` (percent) insets the content area, exactly as
            # the editor and the browser-side exports apply it.
            pad = (slide_model.padding or 0.0) / 100.0
            span = 1.0 - 2.0 * pad

            def inch_box(element: SlideElement) -> tuple[Any, Any, Any, Any]:
                left = offset_x + (pad + (element.x / 100.0) * span) * canvas_w * scale
                top = offset_y + (pad + (element.y / 100.0) * span) * canvas_h * scale
                width = (element.w / 100.0) * span * canvas_w * scale
                height = (element.h / 100.0) * span * canvas_h * scale
                return Inches(left), Inches(top), Inches(width), Inches(height)

            for element in _resolved_slide_elements(slide_model):
                left, top, width, height = inch_box(element)
                if element.type == "text":
                    box = slide.shapes.add_textbox(left, top, width, height)
                    frame = box.text_frame
                    frame.word_wrap = True
                    frame.margin_left = frame.margin_right = Emu(0)
                    frame.margin_top = frame.margin_bottom = Emu(0)
                    color = _hex_rgb(element.color) or _hex_rgb(slide_model.text_color)
                    alignment = alignments.get(element.align or "left")
                    for index, line in enumerate((element.text or "").split("\n")):
                        paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
                        paragraph.alignment = alignment
                        run = paragraph.add_run()
                        run.text = line
                        # Text rides the same scale as the geometry, so type
                        # and shapes keep their relative proportions on any
                        # page size.
                        run.font.size = Pt(
                            (element.font_size or _DEFAULT_FONT_PX) * _PX_TO_PT * scale
                        )
                        run.font.bold = bool(element.bold)
                        if color is not None:
                            run.font.color.rgb = RGBColor.from_string(color)
                elif element.type == "shape":
                    fill_color = _hex_rgb(element.fill) or _DEFAULT_SHAPE_FILL
                    if element.shape == "line":
                        connector = slide.shapes.add_connector(
                            MSO_CONNECTOR.STRAIGHT, left, top, Emu(int(left) + int(width)), Emu(int(top) + int(height))
                        )
                        connector.line.color.rgb = RGBColor.from_string(fill_color)
                        connector.line.width = Pt(2)
                    else:
                        shape_type = MSO_SHAPE.OVAL if element.shape == "ellipse" else MSO_SHAPE.RECTANGLE
                        shape = slide.shapes.add_shape(shape_type, left, top, width, height)
                        shape.fill.solid()
                        shape.fill.fore_color.rgb = RGBColor.from_string(fill_color)
                        shape.line.fill.background()
                elif element.src:
                    data = _data_uri_bytes(element.src)
                    if data is None:
                        continue  # not inlined / not an embeddable type — skip honestly
                    try:
                        picture = slide.shapes.add_picture(io.BytesIO(data), left, top)
                    except Exception:  # noqa: BLE001 — corrupt image data; keep the deck
                        continue
                    # Contain the picture in its box (never stretch), centered —
                    # the same object-fit the canvas and browser exports use.
                    native_w, native_h = picture.image.size
                    if native_w and native_h:
                        scale = min(int(width) / native_w, int(height) / native_h)
                        picture.width = Emu(int(native_w * scale))
                        picture.height = Emu(int(native_h * scale))
                        picture.left = Emu(int(left) + (int(width) - int(picture.width)) // 2)
                        picture.top = Emu(int(top) + (int(height) - int(picture.height)) // 2)

            if slide_model.notes:
                notes_frame = slide.notes_slide.notes_text_frame
                if notes_frame is not None:
                    notes_frame.text = slide_model.notes

        out = io.BytesIO()
        presentation.save(out)
        # The deck's own title names the file when the caller has none — a
        # slides envelope carries one, unlike the html/table sources.
        name = _safe_name(title) or _safe_name(envelope_title) or _stem(path)
        return ExportedFile(out.getvalue(), f"{name}.pptx", PPTX_MIME)


def default_exporters() -> list[Exporter]:
    """The built-in exporters, in routing order."""
    return [TableXlsxExporter(), HtmlDocxExporter(), SlidesPptxExporter()]
