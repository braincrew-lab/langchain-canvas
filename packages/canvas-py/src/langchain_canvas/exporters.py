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

from .table_merge import merge_rows_into_sheet

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


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
    for suffix in (".table.json", ".html", ".htm"):
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


def default_exporters() -> list[Exporter]:
    """The built-in exporters, in routing order."""
    return [TableXlsxExporter(), HtmlDocxExporter()]
