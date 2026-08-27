"""Read an uploaded ``.pptx`` into the deck model the canvas renders.

The twin of :class:`~langchain_canvas.exporters.SlidesPptxExporter`: that
writes a deck out as real shapes, this reads one back in. A deck opened this
way lands on the canvas as editable slides instead of a file card, and the
original stays under ``sources/`` untouched.

The original is also named as the deck's ``template``. That is what carries
everything this model has no field for — masters, layouts, themes, logos,
headers — because the pptx export builds on the skin it points at. So the
reader does not have to capture the whole file to give it back intact; it
captures what a person edits, and the skin restores the rest.

What comes across: slide size, per-shape position and size as percent
geometry, text with its size / bold / colour / alignment, pictures as data
URIs, and rectangles, ellipses and lines.

Honest limits — the reader drops these rather than guessing at them, and each
one stays visible in the original and in the exported file through the skin:

* tables and charts (the deck model has no element type for them)
* grouped shapes
* a text box whose runs disagree takes the first run's formatting, since one
  element carries one set of it
* pictures that are not png / jpeg / gif (the exporter reads no others)
* gradient and theme-referenced backgrounds (the field holds one colour;
  a picture background is laid in as the bottom element instead)
* rotation, animations, transitions, SmartArt
"""

from __future__ import annotations

import base64
from io import BytesIO
from typing import Any

# Pixels per inch used to turn point sizes into the canvas' font scale.
_EMU_PER_INCH = 914400

# Picture formats the pptx exporter can write back out; anything else is
# dropped rather than embedded as bytes no exporter will read.
_IMAGE_TYPES = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg", "gif": "gif"}

# Longest edge a picture background is resampled to before it is inlined.
_BACKGROUND_MAX_PX = 1920

# PowerPoint's default line weight, used when a connector declares none.
_DEFAULT_STROKE_EMU = 12700  # 1pt

# The deck model measures type and spacing in px on a 1280px-wide slide;
# PowerPoint states them in points. Storing a point value in a pixel field
# renders every size a quarter too small and moves every line break.
_PT_TO_PX = 4 / 3

# Autoshape names that map onto the three shapes the deck model draws.
_ELLIPSE_NAMES = ("OVAL", "ELLIPSE", "CIRCLE")
_LINE_NAMES = ("LINE", "STRAIGHT_CONNECTOR", "CONNECTOR")


class PptxImportError(ValueError):
    """The bytes are not a presentation this reader can open."""


def pptx_to_slides(data: bytes) -> dict[str, Any]:
    """Parse presentation bytes into ``SlidesData``-shaped dict.

    Raises :class:`PptxImportError` when the bytes are not a readable
    presentation. Callers that want a file card on failure catch it there.
    """
    try:
        from pptx import Presentation  # type: ignore[import-untyped]
    except ModuleNotFoundError as exc:  # pragma: no cover - install-time path
        raise PptxImportError(
            "reading .pptx needs python-pptx — install langchain-canvas[office]"
        ) from exc

    try:
        deck = Presentation(BytesIO(data))
    except Exception as exc:  # noqa: BLE001 — any malformed file is one failure
        raise PptxImportError(f"could not read the presentation: {exc}") from exc

    width = deck.slide_width or 0
    height = deck.slide_height or 0
    if not width or not height:
        raise PptxImportError("the presentation declares no slide size")

    slides = [_slide(slide, width, height) for slide in deck.slides]
    return {
        "slides": slides,
        "page": {
            "widthIn": round(width / _EMU_PER_INCH, 4),
            "heightIn": round(height / _EMU_PER_INCH, 4),
        },
    }


def _slide(slide: Any, width: int, height: int) -> dict[str, Any]:
    """One slide's elements, in the order they stack on the page."""
    scheme = _scheme(slide)
    elements: list[dict[str, Any]] = []
    for index, shape in enumerate(slide.shapes):
        element = _element(shape, index, width, height, scheme)
        if element is not None:
            elements.append(element)
    picture = _background_picture(slide)
    if picture is not None:
        # Behind everything else, filling the page — a background is what the
        # rest sits on, and the element model has no field for one.
        elements.insert(0, {"id": "bg", "type": "image", "x": 0, "y": 0, "w": 100, "h": 100, "src": picture})
    out: dict[str, Any] = {"elements": elements}
    background = _background(slide)
    if background:
        out["background"] = background
    notes = _notes(slide)
    if notes:
        out["notes"] = notes
    return out


def _background_picture(slide: Any) -> str | None:
    """A picture background as a data URI, scaled down to a screen size.

    ``Slide.background`` holds one colour, so a deck built on photographs
    would come back white. Laying the picture in as the bottom element is
    what the model can express, and it survives the export as a real image.

    Originals are print-sized — one deck's backgrounds measured 25.8 MB
    across four slides, which is not a canvas file. They are resampled to
    1920px JPEG (90 KB for that same deck). Without Pillow there is no
    resampler, and an unshrunk background is worse than none, so it is left
    out and the slide keeps whatever colour it declares.
    """
    blob = _background_blob(slide)
    if blob is None:
        return None
    try:
        from PIL import Image  # type: ignore[import-untyped]
    except ModuleNotFoundError:
        return None
    try:
        image = Image.open(BytesIO(blob))
        image.thumbnail((_BACKGROUND_MAX_PX, _BACKGROUND_MAX_PX), Image.LANCZOS)
        buffer = BytesIO()
        image.convert("RGB").save(buffer, "JPEG", quality=82, optimize=True)
    except Exception:  # noqa: BLE001 — an unreadable background drops out
        return None
    return f"data:image/jpeg;base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"


def _background_blob(slide: Any) -> bytes | None:
    """The bytes of the slide's own picture fill, if it has one."""
    try:
        from pptx.oxml.ns import qn  # type: ignore[import-untyped]
    except ModuleNotFoundError:  # pragma: no cover - install-time path
        return None
    element = getattr(getattr(slide, "background", None), "_element", None)
    if element is None:
        return None
    blip = element.find(f"./{qn('p:bg')}/{qn('p:bgPr')}/{qn('a:blipFill')}/{qn('a:blip')}")
    if blip is None:
        return None
    rid = blip.get(qn("r:embed"))
    if not rid:
        return None
    try:
        return slide.part.related_part(rid).blob
    except (KeyError, AttributeError):
        return None


def _background(slide: Any) -> str | None:
    """The slide's own solid background colour, if it sets one.

    A slide painted a flat colour reads as that colour here, so a dark deck
    stays dark. Three other cases return ``None`` and each is right to:
    a slide that inherits from its layout (the skin paints it on export), a
    picture or gradient fill (the field is one colour, and there is nowhere
    to put the image), and a theme reference (only the skin knows the value).
    """
    fill = getattr(getattr(slide, "background", None), "fill", None)
    if fill is None:
        return None
    try:
        if "SOLID" not in str(fill.type or ""):
            return None
        rgb = fill.fore_color.rgb
    except (AttributeError, ValueError, TypeError):
        return None
    return f"#{rgb}" if rgb is not None else None


# Theme-colour names as the scheme spells them, keyed by the enum member name
# python-pptx reports. ``bg1``/``tx1`` are indirections the master's colour map
# resolves (usually bg1 -> lt1), so they are looked up through it.
_THEME_KEYS = {
    "BACKGROUND_1": "bg1",
    "BACKGROUND_2": "bg2",
    "TEXT_1": "tx1",
    "TEXT_2": "tx2",
    "DARK_1": "dk1",
    "DARK_2": "dk2",
    "LIGHT_1": "lt1",
    "LIGHT_2": "lt2",
    "HYPERLINK": "hlink",
    "FOLLOWED_HYPERLINK": "folHlink",
    **{f"ACCENT_{n}": f"accent{n}" for n in range(1, 7)},
}


def _scheme(slide: Any) -> dict[str, str]:
    """The slide master's colour scheme, as ``name -> rrggbb``.

    Half the runs in a real deck name a theme colour instead of a value, and
    a reader that skips those drops half the deck's colour on the floor. The
    scheme is where the values live, and the master's colour map is what
    ``bg1`` and ``tx1`` mean for this deck.
    """
    try:
        from pptx.oxml.ns import qn  # type: ignore[import-untyped]
    except ModuleNotFoundError:  # pragma: no cover - install-time path
        return {}
    try:
        master = slide.slide_layout.slide_master
        theme = master.part.part_related_by(
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
        )
    except (AttributeError, KeyError):
        return {}
    try:
        from lxml import etree  # type: ignore[import-untyped]

        root = etree.fromstring(theme.blob)
    except Exception:  # noqa: BLE001 - an unreadable theme leaves colours alone
        return {}

    values: dict[str, str] = {}
    scheme = root.find(f".//{qn('a:clrScheme')}")
    for child in scheme if scheme is not None else []:
        name = child.tag.split("}")[-1]
        srgb = child.find(qn("a:srgbClr"))
        system = child.find(qn("a:sysClr"))
        if srgb is not None and srgb.get("val"):
            values[name] = srgb.get("val", "")
        elif system is not None and system.get("lastClr"):
            values[name] = system.get("lastClr", "")

    mapping = master._element.find(qn("p:clrMap"))
    if mapping is not None:
        for key, target in mapping.attrib.items():
            if target in values:
                values[key] = values[target]
    return values


def _shade(hex_rgb: str, brightness: float) -> str:
    """Apply PowerPoint's luminance change to a colour.

    Negative brightness is ``lumMod`` (toward black), positive is ``lumOff``
    (toward white) — white at -0.25 is #BFBFBF, which is what the deck shows.
    """
    try:
        red, green, blue = (int(hex_rgb[i : i + 2], 16) for i in (0, 2, 4))
    except (ValueError, IndexError):
        return hex_rgb
    if brightness < 0:
        factor = 1 + brightness
        channels = (round(c * factor) for c in (red, green, blue))
    else:
        channels = (round(c + (255 - c) * brightness) for c in (red, green, blue))
    return "".join(f"{max(0, min(255, c)):02X}" for c in channels)


def _notes(slide: Any) -> str:
    """The speaker notes, which the exporter writes back out."""
    if not getattr(slide, "has_notes_slide", False):
        return ""
    frame = getattr(slide.notes_slide, "notes_text_frame", None)
    return (frame.text or "").strip() if frame is not None else ""


def _element(
    shape: Any, index: int, width: int, height: int, scheme: dict[str, str]
) -> dict[str, Any] | None:
    """One shape as a deck element, or ``None`` when it has no equivalent."""
    frame = _frame(shape, index, width, height)
    if frame is None:
        return None

    if getattr(shape, "has_table", False) or getattr(shape, "has_chart", False):
        return None
    if _is_group(shape):
        return None

    picture = _picture(shape)
    if picture is not None:
        return {**frame, "type": "image", "src": picture}

    text = _text(shape, scheme)
    if text is not None:
        return {**frame, "type": "text", **text}

    drawing = _drawing(shape)
    if drawing is not None:
        if drawing.get("shape") == "line":
            frame = _with_stroke(frame, shape, width, height)
        return {**frame, "type": "shape", **drawing}
    return None


def _with_stroke(
    frame: dict[str, Any], shape: Any, width: int, height: int
) -> dict[str, Any]:
    """Give a connector its stroke as thickness.

    A horizontal connector is zero pixels tall in the file — PowerPoint draws
    it from the line weight, not the box. The deck model has no stroke field
    and paints every shape as a box, so a zero stays invisible. Fill the flat
    side with the weight the line actually declares (or PowerPoint's default
    when it declares none, which is the common case).
    """
    try:
        stroke = shape.line.width or _DEFAULT_STROKE_EMU
    except (AttributeError, ValueError, TypeError):
        stroke = _DEFAULT_STROKE_EMU
    out = dict(frame)
    if not out["h"]:
        out["h"] = round(100 * stroke / height, 3)
    if not out["w"]:
        out["w"] = round(100 * stroke / width, 3)
    return out


def _frame(shape: Any, index: int, width: int, height: int) -> dict[str, Any] | None:
    """Percent geometry, or ``None`` when the shape declares no box.

    A placeholder that inherits its position from the layout reports ``None``
    for left/top; the layout is the skin's business, so such a shape is left
    to the skin rather than pinned at a guessed spot.
    """
    left, top = getattr(shape, "left", None), getattr(shape, "top", None)
    box_w, box_h = getattr(shape, "width", None), getattr(shape, "height", None)
    if left is None or top is None or box_w is None or box_h is None:
        return None
    return {
        "id": f"e{index}",
        "x": round(100 * left / width, 3),
        "y": round(100 * top / height, 3),
        "w": round(100 * box_w / width, 3),
        "h": round(100 * box_h / height, 3),
    }


def _is_group(shape: Any) -> bool:
    return "GROUP" in str(getattr(shape, "shape_type", "") or "")


def _picture(shape: Any) -> str | None:
    """A picture as a ``data:`` URI the exporter can place back."""
    image = getattr(shape, "image", None)
    if image is None:
        return None
    kind = _IMAGE_TYPES.get((getattr(image, "ext", "") or "").lower())
    if kind is None:
        return None
    try:
        blob = image.blob
    except Exception:  # noqa: BLE001 - an unreadable part drops the picture
        return None
    return f"data:image/{kind};base64,{base64.b64encode(blob).decode('ascii')}"


def _text(shape: Any, scheme: dict[str, str]) -> dict[str, Any] | None:
    """Text plus the first run's formatting, or ``None`` when there is none.

    One element carries one set of formatting, so a box whose runs disagree
    is represented by its first — the words all survive, the variation does
    not. The original keeps it either way.
    """
    if not getattr(shape, "has_text_frame", False):
        return None
    body = (shape.text_frame.text or "").strip()
    if not body:
        return None

    out: dict[str, Any] = {"text": shape.text_frame.text}
    paragraphs = list(shape.text_frame.paragraphs)
    runs = [run for paragraph in paragraphs for run in paragraph.runs]
    if runs:
        font = runs[0].font
        if font.size is not None:
            out["fontSize"] = round(font.size.pt * _PT_TO_PX, 1)
        if font.bold is not None:
            out["bold"] = bool(font.bold)
        colour = _colour(font, scheme)
        if colour:
            out["color"] = colour
    align = _align(paragraphs)
    if align:
        out["align"] = align
    if runs and runs[0].font.name:
        out["fontFamily"] = runs[0].font.name
    spacing = _line_height(paragraphs)
    if spacing:
        out["lineHeight"] = spacing
    anchor = _vertical_align(shape.text_frame)
    if anchor:
        out["verticalAlign"] = anchor
    if runs:
        band = _highlight(runs[0])
        if band:
            out["highlight"] = band
    before, after = _paragraph_spacing(paragraphs)
    if before is not None:
        out["spaceBefore"] = before
    if after is not None:
        out["spaceAfter"] = after
    return out


def _highlight(run: Any) -> str | None:
    """The colour band behind a run, if it is highlighted.

    python-pptx exposes no accessor for ``a:highlight``, so this reads the run
    properties directly. A highlighted heading is a coloured bar in the deck;
    without it the heading reads as plain text and the slide looks unlike the
    file it came from.
    """
    try:
        from pptx.oxml.ns import qn  # type: ignore[import-untyped]
    except ModuleNotFoundError:  # pragma: no cover - install-time path
        return None
    properties = getattr(run, "_r", None)
    properties = properties.find(qn("a:rPr")) if properties is not None else None
    if properties is None:
        return None
    band = properties.find(qn("a:highlight"))
    if band is None:
        return None
    srgb = band.find(qn("a:srgbClr"))
    value = srgb.get("val") if srgb is not None else None
    return f"#{value}" if value else None


def _paragraph_spacing(paragraphs: list[Any]) -> tuple[float | None, float | None]:
    """Space above and below the text, in points, when the paragraphs agree."""

    def agreed(attr: str) -> float | None:
        values = {
            round(getattr(p, attr).pt * _PT_TO_PX, 2)
            for p in paragraphs
            if getattr(p, attr, None) is not None
        }
        return values.pop() if len(values) == 1 else None

    return agreed("space_before"), agreed("space_after")


def _line_height(paragraphs: list[Any]) -> float | None:
    """Line spacing as a multiple, when the paragraphs agree on one.

    python-pptx reports a float for a multiple and a Length for an exact
    height; only the multiple maps onto the model's field, and an exact height
    without the font size to divide by would be a guess.
    """
    values = {p.line_spacing for p in paragraphs if isinstance(p.line_spacing, float)}
    return round(values.pop(), 3) if len(values) == 1 else None


def _vertical_align(frame: Any) -> str | None:
    """Where text sits in its box, when the file says."""
    anchor = getattr(frame, "vertical_anchor", None)
    if anchor is None:
        return None
    name = str(getattr(anchor, "name", "")).lower()
    return {"top": "top", "middle": "middle", "bottom": "bottom"}.get(name)


def _colour(font: Any, scheme: dict[str, str]) -> str | None:
    """The run's colour as ``#rrggbb``, theme references resolved.

    A run either names a value or names a theme slot. Both end up here as one
    colour, because the deck model has one field and the renderer needs a
    value to paint. A slot the scheme does not carry stays ``None`` rather
    than becoming a guess.
    """
    colour = getattr(font, "color", None)
    if colour is None:
        return None
    try:
        rgb = colour.rgb
        if rgb is not None:
            return f"#{rgb}"
    except (AttributeError, ValueError):
        pass
    try:
        name = _THEME_KEYS.get(str(getattr(colour.theme_color, "name", "")))
    except (AttributeError, ValueError):
        return None
    if not name or name not in scheme:
        return None
    brightness = getattr(colour, "brightness", 0) or 0
    return f"#{_shade(scheme[name], float(brightness))}"


def _align(paragraphs: list[Any]) -> str | None:
    """The alignment the paragraphs agree on, if they agree."""
    names = {
        str(p.alignment).split()[0].lower()
        for p in paragraphs
        if p.alignment is not None and (p.text or "").strip()
    }
    if len(names) != 1:
        return None
    name = names.pop()
    return name if name in {"left", "center", "right"} else None


def _drawing(shape: Any) -> dict[str, Any] | None:
    """A rectangle, ellipse or line, with its solid fill if it has one."""
    kind = str(getattr(shape, "shape_type", "") or "").upper()
    name = str(getattr(shape, "name", "") or "").upper()
    if not kind or "PICTURE" in kind:
        return None

    if any(word in kind or word in name for word in _LINE_NAMES):
        drawn = "line"
    elif any(word in kind or word in name for word in _ELLIPSE_NAMES):
        drawn = "ellipse"
    elif "AUTO_SHAPE" in kind or "TEXT_BOX" in kind or "FREEFORM" in kind:
        drawn = "rect"
    else:
        return None

    out: dict[str, Any] = {"shape": drawn}
    fill = _fill(shape, drawn)
    if fill:
        out["fill"] = fill
    stroke, weight = _outline(shape)
    if stroke:
        out["stroke"] = stroke
    if weight:
        out["strokeWidth"] = weight
    return out


def _outline(shape: Any) -> tuple[str | None, float | None]:
    """A shape's outline colour and weight in points.

    Boxes drawn by their border alone — an empty rectangle around content — are
    the common annotation in a real deck, and they carry no fill at all. Read
    separately from ``fill`` so both can be present, or just one.
    """
    line = getattr(shape, "line", None)
    if line is None:
        return None, None
    colour = None
    try:
        rgb = line.color.rgb
        colour = f"#{rgb}" if rgb is not None else None
    except (AttributeError, ValueError, TypeError):
        colour = None
    weight = None
    try:
        if line.width:
            weight = round(line.width / 12700 * _PT_TO_PX, 2)  # EMU -> px
    except (AttributeError, ValueError, TypeError):
        weight = None
    return colour, weight


def _fill(shape: Any, drawn: str) -> str | None:
    """The solid fill (or, for a line, its stroke colour)."""
    holder = shape.line if drawn == "line" else getattr(shape, "fill", None)
    if holder is None:
        return None
    try:
        colour = holder.color if drawn == "line" else holder.fore_color
        rgb = colour.rgb
    except (AttributeError, ValueError, TypeError):
        return None
    return f"#{rgb}" if rgb is not None else None
