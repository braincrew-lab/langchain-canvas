"""Deterministic first-draft slide HTML, straight from extracted structure.

:func:`baseline_slide_html` turns one :class:`~.extract.SlideExtraction`
into dialect-compliant ``<section class="slide">`` markup — absolute-
positioned ``<div data-node-id>`` boxes, one per extracted text run, drawn
shape, or image, each carrying a ``data-pptx-shape-id`` back-reference to
the presentation shape it came from. This is the model's starting point,
not its final layout: a generation pass rewrites the markup, and
:func:`langchain_canvas.deck.validate.ensure_text_equality` is what holds
it to never losing the words along the way.
"""

from __future__ import annotations

import html as html_lib

from .extract import ImageAsset, ShapeGeom, SlideExtraction, TextRun

__all__ = ["baseline_slide_html"]

# The pixel canvas each ratio's percent geometry projects onto — the same
# "px on a fixed-width slide" convention `pptx_import.py` and `exporters.py`
# already use for font sizes, applied here to position too so a slide's
# markup reads as concrete boxes instead of a second percent system.
_RATIO_CANVAS_PX: dict[str, tuple[int, int]] = {
    "16:9": (1280, 720),
    "4:3": (1280, 960),
}
_DEFAULT_CANVAS_PX = (1280, 720)


def _canvas_size(ratio: str) -> tuple[int, int]:
    return _RATIO_CANVAS_PX.get(ratio, _DEFAULT_CANVAS_PX)


def _box_style(x: float, y: float, w: float, h: float, canvas: tuple[int, int]) -> str:
    width, height = canvas
    return (
        "position: absolute; "
        f"left: {x / 100 * width:.2f}px; "
        f"top: {y / 100 * height:.2f}px; "
        f"width: {w / 100 * width:.2f}px; "
        f"height: {h / 100 * height:.2f}px;"
    )


def _text_style(run: TextRun) -> str:
    parts: list[str] = []
    if run.font_size is not None:
        parts.append(f"font-size: {run.font_size:g}px")
    if run.bold:
        parts.append("font-weight: bold")
    if run.color:
        parts.append(f"color: {run.color}")
    if run.align:
        parts.append(f"text-align: {run.align}")
    if run.font_family:
        parts.append(f"font-family: {run.font_family}")
    if run.line_height is not None:
        parts.append(f"line-height: {run.line_height:g}")
    return "; ".join(parts) + (";" if parts else "")


def _text_box(run: TextRun, node_id: str, canvas: tuple[int, int]) -> str:
    style = _box_style(run.x, run.y, run.w, run.h, canvas) + " " + _text_style(run)
    text = html_lib.escape(run.text)
    return (
        f'<div class="lcx-block" data-node-id="{node_id}" '
        f'data-pptx-shape-id="{html_lib.escape(run.element_id, quote=True)}" '
        f'style="{style.strip()}">{text}</div>'
    )


_KNOWN_SHAPE_KINDS = frozenset({"rect", "ellipse", "line"})


def _shape_box(shape: ShapeGeom, node_id: str, canvas: tuple[int, int]) -> str:
    if shape.kind not in _KNOWN_SHAPE_KINDS:
        # An object this reader could geometrically place but not classify
        # into a dialect-drawable shape: surface it as the documented raster
        # fallback rather than silently dropping its provenance.
        return (
            f'<img class="lcx-block" data-node-id="{node_id}" '
            f'data-pptx-shape-id="{html_lib.escape(shape.element_id, quote=True)}" '
            f'data-lcx-fallback="raster" alt="">'
        )
    style_parts = [_box_style(shape.x, shape.y, shape.w, shape.h, canvas)]
    if shape.fill:
        style_parts.append(f"background: {shape.fill};")
    if shape.stroke:
        weight = shape.stroke_width if shape.stroke_width else 1
        style_parts.append(f"border: {weight:g}px solid {shape.stroke};")
    if shape.kind == "ellipse":
        style_parts.append("border-radius: 50%;")
    style = " ".join(style_parts)
    return (
        f'<div class="lcx-block" data-node-id="{node_id}" '
        f'data-pptx-shape-id="{html_lib.escape(shape.element_id, quote=True)}" '
        f'style="{style}"></div>'
    )


def _image_box(image: ImageAsset, node_id: str, canvas: tuple[int, int]) -> str:
    style = _box_style(image.x, image.y, image.w, image.h, canvas)
    src = f"assets/{image.sha}.{image.ext}"
    return (
        f'<img class="lcx-block" data-node-id="{node_id}" '
        f'data-pptx-shape-id="{html_lib.escape(image.element_id, quote=True)}" '
        f'src="{html_lib.escape(src, quote=True)}" style="{style}" alt="">'
    )


def _element_order(element_id: str) -> int:
    """The original shape's document order, recovered from ``e{index}``."""
    try:
        return int(element_id[1:])
    except ValueError:
        return 0


def baseline_slide_html(extraction: SlideExtraction, *, slide_id: str, ratio: str) -> str:
    """Absolute-positioned baseline markup for one extracted slide.

    Boxes are emitted in the presentation's own stacking order — recovered
    from each element's ``e{index}`` id — so a background picture still
    paints under the text placed on top of it, the way it did in the
    original deck.
    """
    canvas = _canvas_size(ratio)
    entries: list[tuple[int, ImageAsset | ShapeGeom | TextRun]] = []
    for image in extraction.images:
        entries.append((_element_order(image.element_id), image))
    for shape in extraction.shapes:
        entries.append((_element_order(shape.element_id), shape))
    for run in extraction.texts:
        entries.append((_element_order(run.element_id), run))
    entries.sort(key=lambda pair: pair[0])

    boxes: list[str] = []
    for seq, (_, element) in enumerate(entries):
        node_id = f"node-{slide_id}-{seq}"
        if isinstance(element, ImageAsset):
            boxes.append(_image_box(element, node_id, canvas))
        elif isinstance(element, ShapeGeom):
            boxes.append(_shape_box(element, node_id, canvas))
        else:
            boxes.append(_text_box(element, node_id, canvas))

    if not boxes:
        return '<section class="slide"></section>'
    body = "\n".join(boxes)
    return f'<section class="slide">\n{body}\n</section>'
