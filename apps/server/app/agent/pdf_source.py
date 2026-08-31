"""PDF reference material for an HTML writer, never a flattened output slide."""

from __future__ import annotations

import ctypes
import hashlib
import io
from dataclasses import dataclass, field
from threading import Lock
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .deck_template_models import TemplateBudget

_PDF_LOCK = Lock()


@dataclass
class PdfPageSource:
    number: int
    width: float
    height: float
    reference_png: bytes
    texts: list[dict] = field(default_factory=list)
    images: dict[str, bytes] = field(default_factory=dict)
    image_boxes: list[dict] = field(default_factory=list)
    shapes: list[dict] = field(default_factory=list)
    clipped_text_regions: list[dict] = field(default_factory=list)
    clipped_references: list[bytes] = field(default_factory=list)


def extract_pdf_pages(
    data: bytes, pages: list[int] | None = None, *, budget: "TemplateBudget | None" = None
) -> list[PdfPageSource]:
    """Extract positioned text and original image objects, plus a visual reference.

    Text and image bounds are given in the same 1280px coordinate system the
    HTML renderer uses. Page screenshots are sent to the model only. A scanned
    page's full-page image is not offered as a reusable asset: its words must
    be transcribed by the vision model into native HTML.

    ``budget`` is optional and defaults to ``None`` — legacy callers (the
    full PDF import path) are unaffected. When given (the template compile
    path), each page's render is bounded by
    ``budget.run_stage``, checked before and after — see
    ``deck_template_models.py::TemplateBudget``.
    """
    import pypdfium2 as pdfium
    from pypdfium2 import raw

    results = []
    asset_prefix = f"assets/pdf-{hashlib.sha256(data).hexdigest()[:16]}"
    with _PDF_LOCK, pdfium.PdfDocument(data) as document:
        if not 0 < len(document) <= 500:
            raise ValueError("PDF must contain 1–500 pages")
        selected = pages if pages is not None else list(range(1, len(document) + 1))
        if (
            not selected
            or len(set(selected)) != len(selected)
            or any(n < 1 or n > len(document) for n in selected)
        ):
            raise ValueError(
                f"pages must contain unique page numbers in 1–{len(document)}"
            )
        for number in sorted(selected):
            page = document[number - 1]
            textpage = page.get_textpage()
            try:
                width, height = page.get_size()
                scale = 1280 / width
                if budget is not None:
                    with budget.run_stage(f"pdf_render_page_{number}"):
                        bitmap = page.render(scale=scale)
                else:
                    bitmap = page.render(scale=scale)
                try:
                    output = io.BytesIO()
                    bitmap.to_pil().save(output, format="PNG")
                finally:
                    bitmap.close()
                source = PdfPageSource(number, width, height, output.getvalue())
                objects = list(page.get_objects(textpage=textpage))
                for order, obj in enumerate(objects):
                    if not isinstance(obj, pdfium.PdfTextObj):
                        continue
                    text = obj.extract()
                    if not text.strip():
                        continue
                    left, bottom, right, top = obj.get_bounds()
                    font = obj.get_font()
                    rgba = [ctypes.c_uint() for _ in range(4)]
                    has_color = raw.FPDFPageObj_GetFillColor(obj, *rgba)
                    source.texts.append(
                        {
                            "text": text,
                            "order": order,
                            "x": round(left * scale, 2),
                            "y": round((height - top) * scale, 2),
                            "w": round((right - left) * scale, 2),
                            "h": round((top - bottom) * scale, 2),
                            "font": font.get_family_name(),
                            "weight": font.get_weight() or 400,
                            "size": round(obj.get_font_size() * scale, 2),
                            "color": ("#" + "".join(f"{c.value:02x}" for c in rgba[:3]))
                            if has_color and rgba[3].value > 0
                            else None,
                            "color_note": "Use the reference image if color is null (PDF transparency or gradient).",
                        }
                    )
                    if (
                        text == "〮"
                        and (right - left) * scale < source.texts[-1]["size"] * 0.3
                    ):
                        source.texts[-1]["display_text"] = "·"
                    if source.texts[-1]["color"] is None:
                        # Transparent PDF text is sometimes painted through a
                        # separate gradient. Give the writer observed colors,
                        # not a fabricated black fill from an empty alpha value.
                        from PIL import Image

                        with Image.open(io.BytesIO(source.reference_png)) as reference:
                            crop = reference.crop(
                                (
                                    left * scale,
                                    (height - top) * scale,
                                    right * scale,
                                    (height - bottom) * scale,
                                )
                            ).convert("RGB")
                            quantized = crop.quantize(colors=8).convert("RGB")
                            colors = quantized.getcolors(crop.width * crop.height) or []
                            source.texts[-1]["reference_palette"] = [
                                "#" + "".join(f"{channel:02x}" for channel in rgb)
                                for _, rgb in sorted(colors, reverse=True)
                            ]
                for index, obj in enumerate(objects):
                    if not isinstance(obj, pdfium.PdfImage):
                        continue
                    left, bottom, right, top = obj.get_bounds()
                    coverage = (right - left) * (top - bottom) / (width * height)
                    if not source.texts and coverage > 0.8:
                        continue  # scanned slide: reference only, never output bitmap
                    native = obj.get_bitmap()
                    try:
                        is_color_tile = native.width <= 4 and native.height <= 4
                    finally:
                        native.close()
                    if is_color_tile:
                        # Tiny color tiles clipped by PDF glyph outlines are
                        # not figures. Extracting the tile loses the glyph clip
                        # and paints a rectangle. Ask the vision writer to
                        # transcribe the reference region as HTML text instead.
                        region = {
                            "x": left * scale,
                            "y": (height - top) * scale,
                            "w": (right - left) * scale,
                            "h": (top - bottom) * scale,
                        }
                        previous = (
                            source.clipped_text_regions[-1]
                            if source.clipped_text_regions
                            else None
                        )
                        if (
                            previous
                            and abs(previous["y"] - region["y"]) < 3
                            and 0 <= region["x"] - previous["x"] < previous["w"] + 12
                        ):
                            previous["w"] = max(
                                previous["w"], region["x"] + region["w"] - previous["x"]
                            )
                        else:
                            source.clipped_text_regions.append(region)
                        continue
                    bitmap = obj.get_bitmap(render=True)
                    try:
                        output = io.BytesIO()
                        bitmap.to_pil().save(output, format="PNG")
                    finally:
                        bitmap.close()
                    name = f"{asset_prefix}/page-{number}-image-{index}.png"
                    source.images[name] = output.getvalue()
                    source.image_boxes.append(
                        {
                            "src": name,
                            "order": index,
                            "x": round(left * scale, 2),
                            "y": round((height - top) * scale, 2),
                            "w": round((right - left) * scale, 2),
                            "h": round((top - bottom) * scale, 2),
                        }
                    )
                for order, obj in enumerate(objects):
                    if obj.type != raw.FPDF_PAGEOBJ_PATH:
                        continue
                    count = raw.FPDFPath_CountSegments(obj)
                    left, bottom, right, top = obj.get_bounds()
                    x, y, w, h = (
                        left * scale,
                        (height - top) * scale,
                        (right - left) * scale,
                        (top - bottom) * scale,
                    )
                    if count > 32:
                        continue
                    # Outlined PDF glyphs should be rewritten as HTML text,
                    # not duplicated as hundreds of vector glyph shapes.
                    if w * h > 0 and any(
                        max(0, min(x + w, t["x"] + t["w"] + 2) - max(x, t["x"] - 2))
                        * max(0, min(y + h, t["y"] + t["h"] + 2) - max(y, t["y"] - 2))
                        / (w * h)
                        > 0.75
                        for t in source.texts
                    ):
                        continue
                    fill_mode, stroke_on = ctypes.c_int(), ctypes.c_int()
                    raw.FPDFPath_GetDrawMode(obj, fill_mode, stroke_on)
                    fill, stroke = (
                        [ctypes.c_uint() for _ in range(4)],
                        [ctypes.c_uint() for _ in range(4)],
                    )
                    raw.FPDFPageObj_GetFillColor(obj, *fill)
                    raw.FPDFPageObj_GetStrokeColor(obj, *stroke)
                    thickness = ctypes.c_float()
                    raw.FPDFPageObj_GetStrokeWidth(obj, thickness)
                    segments = []
                    matrix = obj.get_matrix()
                    for i in range(count):
                        segment = raw.FPDFPath_GetPathSegment(obj, i)
                        px, py = ctypes.c_float(), ctypes.c_float()
                        raw.FPDFPathSegment_GetPoint(segment, px, py)
                        point_x, point_y = matrix.on_point(px.value, py.value)
                        segments.append(
                            {
                                "type": raw.FPDFPathSegment_GetType(segment),
                                "x": round(point_x * scale, 2),
                                "y": round((height - point_y) * scale, 2),
                            }
                        )
                    source.shapes.append(
                        {
                            "order": order,
                            "x": round(x, 2),
                            "y": round(y, 2),
                            "w": round(w, 2),
                            "h": round(h, 2),
                            "fill": "rgba("
                            + ",".join(str(c.value) for c in fill[:3])
                            + f",{fill[3].value / 255})"
                            if fill_mode.value
                            else None,
                            "stroke": "#"
                            + "".join(f"{c.value:02x}" for c in stroke[:3])
                            if stroke_on.value
                            else None,
                            "stroke_width": round(thickness.value * scale, 2),
                            "segments": segments,
                            "rounded": any(
                                raw.FPDFPathSegment_GetType(
                                    raw.FPDFPath_GetPathSegment(obj, i)
                                )
                                == raw.FPDF_SEGMENT_BEZIERTO
                                for i in range(count)
                            ),
                        }
                    )
                if source.clipped_text_regions:
                    # Resolve tiny lettering from PDF vector clips at higher
                    # resolution; magnifying the overview loses fine strokes.
                    detail = page.render(scale=scale * 4)
                    try:
                        detail_image = detail.to_pil()
                        for region in source.clipped_text_regions:
                            x, y, w, h = (region[k] for k in ("x", "y", "w", "h"))
                            crop = detail_image.crop(
                                (
                                    max(0, x - 2) * 4,
                                    max(0, y - 2) * 4,
                                    min(1280, x + w + 2) * 4,
                                    min(height * scale, y + h + 2) * 4,
                                )
                            )
                            output = io.BytesIO()
                            crop.save(output, format="PNG")
                            source.clipped_references.append(output.getvalue())
                    finally:
                        detail.close()
                results.append(source)
            finally:
                textpage.close()
                page.close()
    return results
