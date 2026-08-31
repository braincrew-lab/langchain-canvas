"""Non-native fallbacks applied around the PowerPoint shape emitter.

Two degradations that keep an export succeeding when the source page cannot be
expressed as native PowerPoint objects: rasterizing only the boxes whose CSS is
unsupported (and suppressing the native items those rasters paint over), and
carrying the source page's background token onto the slide master. Nothing here
touches the shape emitter in ``exports.py`` — it only shapes the item list the
emitter consumes and the presentation-level theme.
"""

from __future__ import annotations

import base64
import io

from .render import viewport_for_ratio
from .style_tokens import StyleTokens


def _raster_fallback_items(html_doc: str, unsupported: list[dict], ratio: str) -> list[dict]:
    """Crop each unsupported bbox out of one full-slide render into a picture item.

    Rasterizing only the offending boxes keeps the rest of the slide native and
    editable, instead of failing the whole export on one unsupported CSS rule.
    """
    from PIL import Image

    from .render import render_slide

    _metrics, png = render_slide(html_doc, ratio=ratio)
    width, _height = viewport_for_ratio(ratio)
    items: list[dict] = []
    with Image.open(io.BytesIO(png)) as image:
        scale = image.width / width
        for entry in unsupported:
            left = max(0, round(entry["x"] * scale))
            top = max(0, round(entry["y"] * scale))
            right = min(image.width, round((entry["x"] + entry["w"]) * scale))
            bottom = min(image.height, round((entry["y"] + entry["h"]) * scale))
            if right <= left or bottom <= top:
                continue
            buffer = io.BytesIO()
            image.crop((left, top, right, bottom)).save(buffer, format="PNG")
            encoded = base64.b64encode(buffer.getvalue()).decode()
            items.append(
                {
                    "kind": "image",
                    "src": "data:image/png;base64," + encoded,
                    "fit": "fill",
                    "x": entry["x"],
                    "y": entry["y"],
                    "w": entry["w"],
                    "h": entry["h"],
                }
            )
    return items


def _item_bounds(item: dict) -> tuple[float, float, float, float]:
    x, y = item["x"], item["y"]
    right = item["x2"] if "x2" in item else x + item.get("w", 0)
    bottom = item["y2"] if "y2" in item else y + item.get("h", 0)
    return min(x, right), min(y, bottom), max(x, right), max(y, bottom)


def _covered_by_raster(item: dict, replacements: list[dict], tolerance: float = 0.5) -> bool:
    """True when every corner of ``item`` falls inside one replacement bbox.

    Partial overlaps are deliberately not covered: dropping a straddling text
    block would delete editable text, while leaving it only loses the part the
    raster paints over.
    """
    left, top, right, bottom = _item_bounds(item)
    return any(
        box["x"] - tolerance <= left
        and box["y"] - tolerance <= top
        and right <= box["x"] + box["w"] + tolerance
        and bottom <= box["y"] + box["h"] + tolerance
        for box in replacements
    )


def _background_first(items: list[dict], width: float, height: float) -> list[dict]:
    """Full-bleed pictures first, so later shapes are never hidden behind them."""

    def covers_slide(item: dict) -> bool:
        return (
            item["kind"] == "image"
            and item["y"] == 0
            and item.get("w", 0) >= width * 0.98
            and item.get("h", 0) >= height * 0.98
        )

    return [i for i in items if covers_slide(i)] + [
        i for i in items if not covers_slide(i)
    ]


def _style_tokens_from_body(body_html: str) -> StyleTokens | None:
    """Re-validated tokens from the slide markup root, or ``None``.

    The attribute value has been through a store round trip, so it is
    untrusted input: bad JSON, a schema violation, or an absent attribute
    all mean "no theme" rather than a failed export.
    """
    import json

    from lxml import html as parser
    from pydantic import ValidationError

    root = next(iter(parser.fragment_fromstring(body_html, create_parent="div")), None)
    raw = root.get("data-style-tokens") if root is not None else None
    if raw is None:
        return None
    try:
        return StyleTokens.model_validate(json.loads(raw))
    except (ValueError, ValidationError):
        return None


def _apply_theme_from_tokens(presentation, tokens: StyleTokens) -> None:
    """Set the slide master's background from the source page's tokens.

    Master default fonts are deliberately not set: ``_add_text_block``
    already records the matched family on every run, so a master default
    would make no observable difference.

    A color the token schema admitted but ``python-pptx`` cannot parse leaves
    the master untouched, keeping the same "no theme, not a failed export"
    contract ``_style_tokens_from_body`` applies to malformed token JSON.
    """
    from pptx.dml.color import RGBColor

    background = tokens.background
    if background is None or background.kind != "solid" or not background.value:
        return
    try:
        rgb = RGBColor.from_string(background.value.lstrip("#"))
    except ValueError:
        return
    fill = presentation.slide_master.background.fill
    fill.solid()
    fill.fore_color.rgb = rgb
