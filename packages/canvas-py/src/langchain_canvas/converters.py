"""Source converters — stored source files rendered as model-usable content.

Uploaded files land in the store under ``sources/`` (the user's original
material, read-only for agents). A :class:`SourceConverter` turns one such
file's raw bytes into a :class:`ConvertedSource`: a list of LangChain-standard
content blocks (``{"type": "text", ...}`` and, for vision formats,
``{"type": "image", ...}``) plus metadata. The standard ``read_canvas`` tool
routes binary files through the converter matching their suffix, so the agent
never parses bytes.

Converters are pluggable: pass your own list to ``create_canvas_tools`` to
replace or extend the defaults — an in-house OCR or document-AI pipeline
implements the same one-method contract. Built-in converters that need a
parser library import it lazily and raise
:class:`MissingConverterDependencyError` with an install hint when absent, so
the core package stays dependency-free.
"""

from __future__ import annotations

import base64
import csv
import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class ConvertedSource:
    """A source file in model-usable form.

    ``blocks`` are LangChain-standard content blocks — text blocks always,
    image blocks for vision formats. ``metadata`` carries format facts a tool
    may surface to the agent (sheet names, page count, detected encoding, ...).
    """

    blocks: list[dict[str, Any]]
    metadata: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class SourceConverter(Protocol):
    """The pluggable contract: bytes of one source file in, blocks out."""

    suffixes: tuple[str, ...]
    """Path suffixes this converter handles (lowercase, with the dot)."""

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        """Convert one file. ``path`` is the store path, for messages/metadata."""
        ...


class MissingConverterDependencyError(RuntimeError):
    """A built-in converter's parser library is not installed.

    The message names the missing package and the extra that installs it, so
    the standard tools can relay an honest, actionable error to the agent.
    """


class UnsafeArchiveError(ValueError):
    """An OOXML file's ZIP container exceeds the safety limits.

    Raised *before* any parser touches the bytes, so a decompression bomb
    (a tiny upload that inflates to gigabytes) is refused with an honest
    message instead of taking the process down. The XML inside OOXML is
    already safe — python-pptx and python-docx parse with
    ``resolve_entities=False`` — so the container is the remaining door.
    """


# Refusal thresholds for untrusted OOXML containers. All three are checked
# together (any one alone is routable around). Calibrated 2026-08-24 against
# real corporate decks — a 15-slide, image-heavy pptx measures ~110 parts,
# ~1 MB unpacked, ratio ~1 — so these sit hundreds of times above real files,
# while a crafted 199 KB -> 200 MB bomb (ratio ~1000) trips two of them.
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
MAX_ARCHIVE_PARTS = 3000
MAX_ARCHIVE_COMPRESSION_RATIO = 200
# Ratio is meaningless for tiny archives (one small XML can legitimately
# compress far better than 200:1); only enforce it once the unpacked size
# could actually hurt.
_RATIO_ENFORCE_FLOOR_BYTES = 1024 * 1024


def ensure_archive_within_limits(data: bytes, *, path: str) -> None:
    """Refuse an OOXML container whose ZIP directory promises too much.

    Reads only the central directory (sizes as declared), never the payload,
    so the check itself is O(parts) and allocation-free.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
    except zipfile.BadZipFile:
        # Not a ZIP at all is a formatting problem, not an attack — leave it
        # to each caller's own failure path (a parser error, a skin degrade).
        return
    _ensure_infos_within_limits(infos, path=path)


def _ensure_infos_within_limits(infos: list[zipfile.ZipInfo], *, path: str) -> None:
    """The limits check on a central directory already read (any zip source)."""
    if len(infos) > MAX_ARCHIVE_PARTS:
        raise UnsafeArchiveError(
            f"{path} holds {len(infos)} parts — more than the "
            f"{MAX_ARCHIVE_PARTS}-part limit for untrusted files"
        )
    total_uncompressed = sum(info.file_size for info in infos)
    if total_uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
        raise UnsafeArchiveError(
            f"{path} unpacks to {total_uncompressed // (1024 * 1024)} MB — over the "
            f"{MAX_ARCHIVE_UNCOMPRESSED_BYTES // (1024 * 1024)} MB limit for untrusted files"
        )
    total_compressed = sum(info.compress_size for info in infos)
    if (
        total_uncompressed > _RATIO_ENFORCE_FLOOR_BYTES
        and total_uncompressed > MAX_ARCHIVE_COMPRESSION_RATIO * max(total_compressed, 1)
    ):
        raise UnsafeArchiveError(
            f"{path} compresses {total_uncompressed // max(total_compressed, 1)}:1 — "
            f"over the {MAX_ARCHIVE_COMPRESSION_RATIO}:1 limit for untrusted files"
        )


@runtime_checkable
class PageRenderable(Protocol):
    """Optional converter extension: a paged source rendered as images.

    A separate protocol (not new methods on :class:`SourceConverter`) so
    existing custom converters keep working unchanged. Formats whose pages
    are worth *seeing* — scans, charts, layout — implement it; the standard
    ``read_canvas`` tool routes its ``pages`` parameter here. The PDF
    converter is the first implementation; office-document renderers plug
    into the same slot.
    """

    def render_pages(self, data: bytes, *, path: str, pages: list[int]) -> ConvertedSource:
        """The requested 1-based pages as labeled image blocks.

        Raises ``ValueError`` with an honest message for an out-of-range
        request, so the tool can relay it verbatim.
        """
        ...

    def render_grid(self, data: bytes, *, path: str) -> ConvertedSource:
        """Every page as a small labeled thumbnail, tiled into grid images.

        The cheap overview between "read the text" and "render these pages":
        one call shows the whole document's shape so the agent can pick the
        pages worth a full render.
        """
        ...


def converter_for(path: str, converters: list[SourceConverter]) -> SourceConverter | None:
    """The first converter whose suffix matches ``path`` (case-insensitive)."""
    lowered = path.lower()
    for converter in converters:
        if lowered.endswith(converter.suffixes):
            return converter
    return None


class TextSourceConverter:
    """Plain-text formats, decoded with UTF-8 (BOM-aware) then CP949.

    The trivial reference implementation of the contract. Files that decode
    with neither encoding fall back to lossy UTF-8 and say so in metadata —
    the agent gets honest content instead of an opaque failure.
    """

    suffixes: tuple[str, ...] = (".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm")

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        for encoding in ("utf-8-sig", "cp949"):
            try:
                return ConvertedSource(
                    blocks=[{"type": "text", "text": data.decode(encoding)}],
                    metadata={"encoding": encoding},
                )
            except UnicodeDecodeError:
                continue
        return ConvertedSource(
            blocks=[{"type": "text", "text": data.decode("utf-8", errors="replace")}],
            metadata={"encoding": "unknown (lossy utf-8)"},
        )


class XlsxSourceConverter:
    """Excel workbooks, one CSV-shaped section per sheet.

    Reads cached values (what Excel last computed), so formula cells show
    their results. Requires ``openpyxl`` — installed by the ``xlsx`` extra.
    """

    suffixes: tuple[str, ...] = (".xlsx",)

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        try:
            from openpyxl import load_workbook  # type: ignore[import-untyped]
        except ImportError as exc:
            raise MissingConverterDependencyError(
                "reading .xlsx needs openpyxl — install langchain-canvas[xlsx] "
                "or register your own converter for .xlsx"
            ) from exc

        ensure_archive_within_limits(data, path=path)
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        shapes = _shape_lines(data, path)
        sections: list[str] = []
        sheet_names: list[str] = []
        for sheet in workbook.worksheets:
            sheet_names.append(sheet.title)
            out = io.StringIO()
            writer = csv.writer(out)
            for row in sheet.iter_rows(values_only=True):
                writer.writerow(["" if cell is None else str(cell) for cell in row])
            body = out.getvalue().rstrip("\n") or "(empty)"
            section = f"### sheet: {sheet.title}\n{body}"
            if sheet.title in shapes:
                section += "\n\n#### shapes (text in drawing shapes)\n" + "\n".join(
                    shapes[sheet.title]
                )
            sections.append(section)
        workbook.close()
        metadata = {"sheets": ", ".join(sheet_names), "values": "cached results"}
        if shapes:
            metadata["shapes"] = str(sum(len(lines) for lines in shapes.values()))
        return ConvertedSource(
            blocks=[{"type": "text", "text": "\n\n".join(sections)}], metadata=metadata
        )


def _shape_lines(data: bytes, path: str) -> dict[str, list[str]]:
    """The text in a workbook's drawing shapes as ``- cell name: text`` lines per sheet name.

    Hidden shapes and shapes without text are left out; name and text are made safe to
    show a model. A drawing that cannot be read gives no lines: the cell text stands alone.
    """
    from .xlsx_drawings import model_safe_text, read_drawing_objects

    try:
        objects = read_drawing_objects(data, path=path)
    except Exception:  # noqa: BLE001 — shape text is an addition to the cell text
        return {}
    lines: dict[str, list[str]] = {}
    for obj in objects:
        if obj["text"] and not obj["hidden"]:
            lines.setdefault(obj["sheet_name"], []).append(
                f"- {obj['cell']} {model_safe_text(obj['name'])}: {model_safe_text(obj['text'])}"
            )
    return lines


#: Anthropic-family request limit is 5 MB per image *after* base64 (+33%).
MAX_INLINE_IMAGE_BYTES = 3_750_000

#: At most this many image blocks per tool call — pages or grid sheets alike.
MAX_IMAGES_PER_CALL = 8


class ImageSourceConverter:
    """Images as vision blocks — the model sees the picture, not a description.

    No parser dependency: the bytes go straight into a base64 image block.
    Delivery to the model requires a vision-capable model and a provider whose
    tool messages accept image blocks (Anthropic and Bedrock Converse do; some
    chat-completions providers accept text only). Oversized images degrade to
    an honest note instead of an oversized request.
    """

    suffixes: tuple[str, ...] = (".png", ".jpg", ".jpeg", ".gif", ".webp")

    max_bytes: int = MAX_INLINE_IMAGE_BYTES

    _MIME = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        suffix = "." + path.rsplit(".", 1)[-1].lower()
        mime = self._MIME.get(suffix, "application/octet-stream")
        if len(data) > self.max_bytes:
            return ConvertedSource(
                blocks=[
                    {
                        "type": "text",
                        "text": (
                            f"(image is {len(data):,} bytes — too large to inline; "
                            f"the limit is {self.max_bytes:,} bytes. Ask the user "
                            "for a smaller version.)"
                        ),
                    }
                ],
                metadata={"mime": mime, "bytes": len(data), "inlined": False},
            )
        return ConvertedSource(
            blocks=[
                {"type": "text", "text": f"(image {path}, {mime}, {len(data):,} bytes)"},
                {
                    "type": "image",
                    "source_type": "base64",
                    "mime_type": mime,
                    "data": base64.b64encode(data).decode(),
                },
            ],
            metadata={"mime": mime, "bytes": len(data), "inlined": True},
        )


_Box = tuple[float, float, float, float]  # left, top, right, bottom (from the top)

#: The text a gallery page carries: ``lcx<12 hex digits of the workbook's salt>chart<k>``.
_GALLERY_MARKER = re.compile(r"^lcx([0-9a-f]{12})chart(\d+)$")


def _inside(inner: _Box, outer: _Box) -> bool:
    return (
        inner[0] >= outer[0] - 1
        and inner[1] >= outer[1] - 1
        and inner[2] <= outer[2] + 1
        and inner[3] <= outer[3] + 1
    )


def _same(a: _Box, b: _Box) -> bool:
    return all(abs(x - y) <= 2 for x, y in zip(a, b, strict=True))


def _visible_share(box: _Box, page_width: float, page_height: float) -> float:
    """The share of a box's area that lies on the page."""
    area = (box[2] - box[0]) * (box[3] - box[1])
    if area <= 0:
        return 0.0
    width = min(box[2], page_width) - max(box[0], 0.0)
    height = min(box[3], page_height) - max(box[1], 0.0)
    return max(0.0, width) * max(0.0, height) / area


def _outer_chart_boxes(boxes: list[_Box], marks: list[_Box]) -> list[_Box]:
    """Candidate boxes holding a mark, outermost only, twins merged, reading order."""
    charts = [
        box for box in boxes if any(_inside(mark, box) and not _same(mark, box) for mark in marks)
    ]
    outer = [
        box
        for box in charts
        if not any(
            other is not box and not _same(other, box) and _inside(box, other) for other in charts
        )
    ]
    merged: list[_Box] = []
    for box in outer:
        twin = next((k for k, kept in enumerate(merged) if _same(kept, box)), None)
        if twin is None:
            merged.append(box)
            continue
        kept = merged[twin]
        merged[twin] = (
            min(kept[0], box[0]),
            min(kept[1], box[1]),
            max(kept[2], box[2]),
            max(kept[3], box[3]),
        )
    merged.sort(key=lambda b: (round(b[1]), round(b[0])))
    return merged


class PdfSourceConverter:
    """PDFs as per-page extracted text, and — on request — as page images.

    Text extraction requires ``pypdf`` (the ``pdf`` extra). Pages without an
    extractable text layer (scans) say so honestly instead of silently
    contributing nothing.

    Page rendering (the :class:`PageRenderable` side) requires ``pypdfium2``
    and ``pillow`` (the ``pdf-images`` extra) — both plain wheels, no external
    binary. Rendering is recomputed on every call by design: a persistent
    preview belongs to the file-artifact track, not here.
    """

    suffixes: tuple[str, ...] = (".pdf",)

    #: Render scales tried in order until the PNG fits the inline byte cap.
    render_scales: tuple[float, ...] = (2.0, 1.5, 1.0)
    max_bytes: int = MAX_INLINE_IMAGE_BYTES
    #: Grid overview tiling: 4 columns x 5 rows of thumbnails per sheet.
    grid_columns: int = 4
    grid_rows: int = 5
    grid_cell_width: int = 280

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        try:
            from pypdf import PdfReader  # type: ignore[import-untyped]
        except ImportError as exc:
            raise MissingConverterDependencyError(
                "reading .pdf needs pypdf — install langchain-canvas[pdf] "
                "or register your own converter for .pdf"
            ) from exc

        reader = PdfReader(io.BytesIO(data))
        sections: list[str] = []
        empty_pages = 0
        for number, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").strip()
            if not text:
                empty_pages += 1
                text = "(no extractable text on this page — it may be a scan or an image)"
            sections.append(f"### page {number}\n{text}")
        metadata: dict[str, Any] = {"pages": len(reader.pages)}
        if empty_pages:
            metadata["pages without text"] = empty_pages
        return ConvertedSource(
            blocks=[{"type": "text", "text": "\n\n".join(sections)}], metadata=metadata
        )

    def _document(self, data: bytes) -> Any:
        try:
            import pypdfium2 as pdfium  # type: ignore[import-untyped]
            from PIL import Image  # noqa: F401  — needed by bitmap.to_pil()
        except ImportError as exc:
            raise MissingConverterDependencyError(
                "rendering .pdf pages needs pypdfium2 and pillow — install "
                "langchain-canvas[pdf-images] or register your own renderer for .pdf"
            ) from exc
        return pdfium.PdfDocument(data)

    def _render_png(self, document: Any, index: int, scale: float) -> bytes:
        bitmap = document[index].render(scale=scale)
        out = io.BytesIO()
        bitmap.to_pil().save(out, format="PNG")
        return out.getvalue()

    @staticmethod
    def _image_block(png: bytes) -> dict[str, Any]:
        return {
            "type": "image",
            "source_type": "base64",
            "mime_type": "image/png",
            "data": base64.b64encode(png).decode(),
        }

    #: Deprecated: not read since 0.7.52 (chart pages come from ``_chart_boxes``).
    #: Kept so a host that sets them keeps working.
    chart_min_big_paths: int = 2
    chart_min_area_paths: int = 40
    chart_max_text_objects: int = 200
    #: A mark (bar, wedge, legend key) is a colored fill at least this big (pt).
    #: A chart printed fit-to-page draws its bars about 3pt wide.
    chart_mark_min: float = 1.0
    #: A chart area is a filled or stroked box with a colored mark inside it.
    #: It is at least this fraction of the page width and height, so a chart
    #: shrunk with its page is still found.
    chart_box_min_fraction: tuple[float, float] = (0.08, 0.04)
    #: A box that leaves the page counts for chart_pages only when at
    #: least this share of its area is on the page; a sliver of a chart drawn
    #: past the edge is not a chart page.
    chart_cut_min_visible: float = 0.25
    #: Absolute floor (pt) on top of the fraction; 0 leaves the fraction alone.
    chart_box_min_width: float = 0.0
    chart_box_min_height: float = 0.0
    #: Each crop is rendered on its own at the scale that makes it about
    #: ``chart_crop_width`` px wide (between the two scale bounds), so a
    #: chart on a page that was shrunk to fit still reads at grid size.
    chart_crop_width: float = 960.0
    chart_crop_min_scale: float = 2.0
    chart_crop_max_scale: float = 8.0

    def chart_pages(self, data: bytes, *, path: str) -> list[int]:
        """1-based pages that hold at least one chart.

        A page counts when ``_chart_boxes`` finds a chart area on it. A chart
        cut by a page break counts on both pages. Hosts that render office
        files to PDF call this on that PDF so the workbook viewer can show
        chart pages under the read-only grid.
        """
        document = self._document(data)
        try:
            return [
                index
                for index, page in enumerate(document, 1)
                if self._chart_boxes(page)
            ]
        finally:
            document.close()

    def chart_images(self, data: bytes, *, path: str) -> list[dict[str, Any]]:
        """Each marked chart page of a gallery copy as a PNG crop, in page order.

        The pages come from ``xlsx_chart_gallery``: one chart per page, and on each
        page a small text ``lcx<salt>chart<k>`` saying which chart it is. A page
        whose text starts with no such marker is not a gallery page and is skipped,
        so nothing is guessed from colors or shapes. The crop is the union of every
        object on the page except that marker; when two pages carry the same
        marker, the first wins.
        Returns ``[{"chart": k, "salt": s, "page": n, "box": [x, y, w, h],
        "png": bytes}, ...]`` with the box in points from the page's top-left corner.
        """
        document = self._document(data)
        crops: list[dict[str, Any]] = []
        seen: set[tuple[str, int]] = set()
        try:
            for index, page in enumerate(document, 1):
                marker = self._page_marker(page)
                if marker is None or (marker[0], marker[1]) in seen:
                    continue
                box = self._marked_chart_box(page)
                if box is None:
                    continue
                seen.add((marker[0], marker[1]))
                crop = self._crop_chart(page, index, box)
                crops.append({"chart": marker[1], "salt": marker[0], **crop})
        finally:
            document.close()
        return crops

    @staticmethod
    def _page_marker(page: Any) -> tuple[str, int] | None:
        """The ``(salt, chart number)`` of a gallery page, or None for any other page."""
        textpage = page.get_textpage()
        try:
            for token in textpage.get_text_range().split():
                found = _GALLERY_MARKER.match(token)
                if found:
                    return found[1], int(found[2])
        finally:
            textpage.close()
        return None

    @staticmethod
    def _marked_chart_box(page: Any) -> _Box | None:
        """Everything drawn on a gallery page but its marker, from the top-left corner."""
        import ctypes

        import pypdfium2.raw as pdfium_c  # type: ignore[import-untyped]

        _, page_height = page.get_size()
        textpage = page.get_textpage()
        union: _Box | None = None
        try:
            for obj in page.get_objects(max_depth=1):
                if obj.type == pdfium_c.FPDF_PAGEOBJ_TEXT:
                    # a chart title that only mentions "lcx" is not the marker
                    size = pdfium_c.FPDFTextObj_GetText(obj.raw, textpage.raw, None, 0)
                    buffer = (ctypes.c_ushort * max(1, size))()
                    pdfium_c.FPDFTextObj_GetText(obj.raw, textpage.raw, buffer, size)
                    text = bytes(buffer).decode("utf-16-le", errors="ignore").split("\x00")[0]
                    if _GALLERY_MARKER.match(text.strip()):
                        continue
                left, bottom, right, top = (ctypes.c_float() for _ in range(4))
                if not pdfium_c.FPDFPageObj_GetBounds(obj.raw, left, bottom, right, top):
                    continue
                box: _Box = (
                    left.value, page_height - top.value, right.value, page_height - bottom.value
                )
                union = box if union is None else (
                    min(union[0], box[0]), min(union[1], box[1]),
                    max(union[2], box[2]), max(union[3], box[3]),
                )
        finally:
            textpage.close()
        if union is None or union[2] <= union[0] or union[3] <= union[1]:
            return None
        return union

    def _crop_chart(self, page: Any, index: int, box: _Box) -> dict[str, Any]:
        left, top, right, bottom = box
        page_width, page_height = page.get_size()
        pad = 2.0
        # Only the chart's own area is rendered, at a scale that makes it
        # about ``chart_crop_width`` px wide.
        scale = min(
            self.chart_crop_max_scale,
            max(self.chart_crop_min_scale, self.chart_crop_width / (right - left)),
        )
        cut_left = max(0.0, left - pad)
        cut_top = max(0.0, top - pad)
        cut_right = max(0.0, page_width - min(page_width, right + pad))
        cut_bottom = max(0.0, page_height - min(page_height, bottom + pad))
        crop = page.render(scale=scale, crop=(cut_left, cut_bottom, cut_right, cut_top)).to_pil()
        out = io.BytesIO()
        crop.save(out, format="PNG")
        return {
            "page": index,
            "box": [round(left, 1), round(top, 1), round(right - left, 1), round(bottom - top, 1)],
            "png": out.getvalue(),
        }

    def _chart_boxes(self, page: Any) -> list[_Box]:
        """Chart areas on one page as (left, top, right, bottom) in points from the top.

        LibreOffice draws a chart as a box (its chart area, a filled or
        stroked rectangle) with colored marks inside: bars, wedges, lines.
        A box counts when it is at least ``chart_box_min_fraction`` of the
        page and a colored, non-white filled mark of ``chart_mark_min`` sits
        inside it; no larger qualifying box may hold it (the plot area inside
        a chart is not a second chart), and the border and the white fill of
        one chart area collapse into one box. A box that leaves the page is
        a chart cut by a page break: it counts while ``chart_cut_min_visible``
        of it is on the page. Cell fills and gridlines sit in no box, so a
        printed table yields nothing.
        Boxes come ordered top to bottom, then left to right.
        """
        import ctypes

        import pypdfium2.raw as pdfium_c  # type: ignore[import-untyped]

        def _bounds(raw: object) -> tuple[float, float, float, float] | None:
            left, bottom, right, top = (ctypes.c_float() for _ in range(4))
            if not pdfium_c.FPDFPageObj_GetBounds(raw, left, bottom, right, top):
                return None
            return left.value, bottom.value, right.value, top.value

        def _draw_mode(raw: object) -> tuple[bool, bool]:
            fill_mode, stroke = ctypes.c_int(), ctypes.c_int()
            pdfium_c.FPDFPath_GetDrawMode(raw, fill_mode, stroke)
            return fill_mode.value != 0, stroke.value != 0

        def _fill_rgb(raw: object) -> tuple[int, int, int] | None:
            red, green, blue, alpha = (ctypes.c_uint() for _ in range(4))
            if not pdfium_c.FPDFPageObj_GetFillColor(raw, red, green, blue, alpha):
                return None
            return red.value, green.value, blue.value

        page_width, page_height = page.get_size()
        min_width = max(self.chart_box_min_width, page_width * self.chart_box_min_fraction[0])
        min_height = max(self.chart_box_min_height, page_height * self.chart_box_min_fraction[1])
        boxes: list[_Box] = []
        marks: list[_Box] = []
        for obj in page.get_objects(max_depth=2):
            if obj.type != pdfium_c.FPDF_PAGEOBJ_PATH:
                continue
            bounds = _bounds(obj.raw)
            if bounds is None:
                continue
            left, bottom, right, top = bounds
            box: _Box = (left, page_height - top, right, page_height - bottom)
            width, height = right - left, top - bottom
            filled, stroked = _draw_mode(obj.raw)
            on_page = (
                left >= -1
                and right <= page_width + 1
                and box[1] >= -1
                and box[3] <= page_height + 1
            )
            shown = (
                on_page
                or _visible_share(box, page_width, page_height) >= self.chart_cut_min_visible
            )
            if (
                shown
                and (filled or stroked)
                and width >= min_width
                and height >= min_height
            ):
                boxes.append(box)
            if filled and width > self.chart_mark_min and height > self.chart_mark_min:
                rgb = _fill_rgb(obj.raw)
                if rgb is not None and rgb != (255, 255, 255):
                    marks.append(box)
        return _outer_chart_boxes(boxes, marks)

    def render_pages(self, data: bytes, *, path: str, pages: list[int]) -> ConvertedSource:
        """The requested 1-based pages as labeled PNG image blocks.

        Each page gets a ``### page N`` text label directly before its image,
        so the model never has to infer which image is which. A page is
        rendered at the largest scale whose PNG fits the inline byte cap;
        one that fits at no scale degrades to an honest text note.
        """
        document = self._document(data)
        total = len(document)
        bad = [p for p in pages if p < 1 or p > total]
        if bad:
            raise ValueError(f"{path} has {total} page(s) — valid range is 1-{total}")

        blocks: list[dict[str, Any]] = []
        scales_used: set[float] = set()
        for page in pages:
            png = b""
            for scale in self.render_scales:
                png = self._render_png(document, page - 1, scale)
                if len(png) <= self.max_bytes:
                    scales_used.add(scale)
                    break
            if len(png) > self.max_bytes:
                blocks.append(
                    {
                        "type": "text",
                        "text": (
                            f"### page {page} — could not be inlined: the rendered image is "
                            f"{len(png):,} bytes even at the smallest scale (limit "
                            f"{self.max_bytes:,}). Read this page as text instead."
                        ),
                    }
                )
                continue
            blocks.append({"type": "text", "text": f"### page {page} (image follows)"})
            blocks.append(self._image_block(png))
        return ConvertedSource(
            blocks=blocks,
            metadata={
                "pages": total,
                "rendered": ", ".join(str(p) for p in pages),
                "scale": ", ".join(str(s) for s in sorted(scales_used, reverse=True)) or "none",
            },
        )

    def render_grid(self, data: bytes, *, path: str) -> ConvertedSource:
        """Every page as a numbered thumbnail, tiled into grid sheets.

        The overview layer of the observation ladder: 20 thumbnails per
        sheet, each labeled with its page number so the agent can follow up
        with a full render of just the pages that matter. Raises
        ``ValueError`` when the document needs more sheets than one call may
        carry.
        """
        document = self._document(data)
        from PIL import Image, ImageDraw, ImageFont

        total = len(document)
        per_sheet = self.grid_columns * self.grid_rows
        sheets = (total + per_sheet - 1) // per_sheet
        if sheets > MAX_IMAGES_PER_CALL:
            raise ValueError(
                f"{path} has {total} pages — a grid overview would need {sheets} sheets, "
                f"more than the {MAX_IMAGES_PER_CALL}-image limit per call. Read the text "
                "layer first and request specific pages instead."
            )

        font = ImageFont.load_default(size=18)
        blocks: list[dict[str, Any]] = []
        for sheet_index in range(sheets):
            first = sheet_index * per_sheet
            last = min(first + per_sheet, total)
            thumbs: list[Any] = []
            for index in range(first, last):
                width = document[index].get_size()[0]
                scale = self.grid_cell_width / width if width else 0.4
                bitmap = document[index].render(scale=scale)
                thumb = bitmap.to_pil()
                draw = ImageDraw.Draw(thumb)
                label = str(index + 1)
                box = draw.textbbox((0, 0), label, font=font)
                draw.rectangle((0, 0, box[2] + 10, box[3] + 8), fill="#111111")
                draw.text((5, 3), label, fill="#ffffff", font=font)
                thumbs.append(thumb)

            cell_h = max(t.height for t in thumbs)
            columns = min(self.grid_columns, len(thumbs))
            rows = (len(thumbs) + columns - 1) // columns
            width = columns * self.grid_cell_width + 8 * (columns + 1)
            height = rows * cell_h + 8 * (rows + 1)
            sheet = Image.new("RGB", (width, height), "#e5e5e5")
            for i, thumb in enumerate(thumbs):
                r, c = divmod(i, columns)
                sheet.paste(thumb, (8 + c * (self.grid_cell_width + 8), 8 + r * (cell_h + 8)))
            out = io.BytesIO()
            sheet.save(out, format="PNG")
            encoded = out.getvalue()
            if len(encoded) > self.max_bytes:
                # A photo-heavy sheet can blow the PNG cap — JPEG is far smaller.
                out = io.BytesIO()
                sheet.save(out, format="JPEG", quality=80)
                encoded = out.getvalue()
            label = f"### pages {first + 1}-{last} (grid overview, numbered thumbnails)"
            if len(encoded) > self.max_bytes:
                blocks.append(
                    {
                        "type": "text",
                        "text": label
                        + " — could not be inlined (too large); request page ranges instead.",
                    }
                )
                continue
            blocks.append({"type": "text", "text": label})
            block = self._image_block(encoded)
            block["mime_type"] = "image/png" if encoded[:4] == b"\x89PNG" else "image/jpeg"
            blocks.append(block)
        return ConvertedSource(
            blocks=blocks,
            metadata={
                "pages": total,
                "grid": f"{sheets} sheet(s), up to {per_sheet} thumbnails each",
            },
        )


def _table_lines(rows: list[list[str]]) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    for row in rows:
        writer.writerow(row)
    return out.getvalue().rstrip("\n")


class DocxSourceConverter:
    """Word documents as addressed text — paragraphs, tables and pictures.

    Every body paragraph carries its number and its style name, every table
    and picture its address, so a model reading the document can point at a
    part of it afterwards. A plain text dump gives none of that back: the
    heading hierarchy is gone and there is no way to say *which* paragraph.
    See :mod:`langchain_canvas.document_ops` for what the addresses mean and
    which edits accept them.

    Requires ``python-docx`` — installed by the ``office`` extra.
    """

    suffixes: tuple[str, ...] = (".docx",)

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        try:
            import docx  # type: ignore[import-untyped]  # noqa: F401
        except ImportError as exc:
            raise MissingConverterDependencyError(
                "reading .docx needs python-docx — install langchain-canvas[office] "
                "or register your own converter for .docx"
            ) from exc
        # Imported here, not at module scope: document_ops reads the archive
        # limits from this module, and a top-level pair would be a cycle.
        from .document_ops import outline

        ensure_archive_within_limits(data, path=path)
        rendered = outline(data, path=path)
        return ConvertedSource(
            blocks=[{"type": "text", "text": rendered.render()}],
            # The counts header inside the text carries the full set; the
            # metadata stays the two facts a preview card has room for.
            metadata={key: rendered.counts[key] for key in ("paragraphs", "tables")},
        )


class PptxSourceConverter:
    """PowerPoint decks as per-slide text — titles, body text, and tables.

    Requires ``python-pptx`` — installed by the ``office`` extra.
    """

    suffixes: tuple[str, ...] = (".pptx",)

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        try:
            from pptx import Presentation  # type: ignore[import-untyped]
        except ImportError as exc:
            raise MissingConverterDependencyError(
                "reading .pptx needs python-pptx — install langchain-canvas[office] "
                "or register your own converter for .pptx"
            ) from exc

        ensure_archive_within_limits(data, path=path)
        deck = Presentation(io.BytesIO(data))
        sections: list[str] = []
        for number, slide in enumerate(deck.slides, start=1):
            parts: list[str] = []
            for shape in slide.shapes:
                if shape.has_table:
                    rows = [
                        [cell.text.strip() for cell in row.cells] for row in shape.table.rows
                    ]
                    parts.append(_table_lines(rows))
                elif shape.has_text_frame:
                    text = shape.text_frame.text.strip()
                    if text:
                        parts.append(text)
            body = "\n".join(parts) or "(no text on this slide)"
            sections.append(f"### slide {number}\n{body}")
        return ConvertedSource(
            blocks=[{"type": "text", "text": "\n\n".join(sections)}],
            metadata={"slides": len(deck.slides)},
        )


def default_converters() -> list[SourceConverter]:
    """The built-in converter set. Grows as format tiers land."""
    return [
        TextSourceConverter(),
        XlsxSourceConverter(),
        ImageSourceConverter(),
        PdfSourceConverter(),
        DocxSourceConverter(),
        PptxSourceConverter(),
    ]
