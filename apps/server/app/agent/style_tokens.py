"""Structured design tokens extracted from a source page, plus their CSS form.

Models and pure extraction only — no model call, no browser round trip for
:func:`tokens_from_pdf_page`. The CSS :func:`tokens_to_css` emits is a set of
*role defaults*: literal declarations selected by ``[data-text-role="..."]``.
Frame markup owns position through inline styles, and an inline declaration
beats any external selector, so these defaults only reach nodes the writer
created without their own typography — exactly the nodes that would otherwise
lose the original page's look.

Two constraints shape the output and are load-bearing:

* ``sanitize.py::_filter_css_declarations`` drops every declaration outside
  ``ALLOWED_CSS_PROPS``, so CSS custom properties (``--tpl-ink``) never survive
  a stored deck. Only literal values are emitted here.
* Position is never emitted. ``frame_html`` owns it.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field

from .pdf_fonts import contains_hangul, match_open_source_family

if TYPE_CHECKING:  # pragma: no cover - import cycle guard, runtime never needs it
    from .pdf_source import PdfPageSource

# The 1280px-wide coordinate system ``extract_pdf_pages`` reports text/image
# boxes in — the same space the HTML renderer uses.
_CANVAS_WIDTH_PX = 1280.0

# A raster that covers at least this share of the canvas is the page's
# background system, not a figure placed on it.
_BACKGROUND_COVERAGE = 0.98

_LINE_HEIGHT_RATIO = 1.2

_ROLE_ORDER = ("title", "body", "caption", "table-cell")

_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")

# Every consumer of a token color parses it as ``#rrggbb`` (the PPTX export
# hands it straight to ``RGBColor.from_string``), so the schema — not the
# consumer — is where a foreign value has to be rejected.
_HEX_COLOR_PATTERN = r"^#[0-9a-fA-F]{6}$"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ColorToken(_Strict):
    """One observed page color and how much of the page it covers."""

    role: str
    value: str = Field(pattern=_HEX_COLOR_PATTERN)
    coverage: float = Field(ge=0.0, le=1.0)


class TypeToken(_Strict):
    """The typography one text role was drawn with on the source page.

    ``family`` is the family name the original file declared, unconverted.
    ``export_family`` is the license-safe open-source family that stands in
    for it (``pdf_fonts.py::match_open_source_family``), empty when nothing
    was matched. ``color`` is ``None`` when the source stated no fill and no
    reference palette was observed — a guessed color would silently repaint
    the deck.
    """

    role: str
    family: str
    export_family: str = ""
    size_px: float = Field(gt=0.0)
    weight: int = Field(ge=1, le=1000)
    line_height_px: float = Field(gt=0.0)
    color: str | None = None


class BackgroundToken(_Strict):
    """The page's background system: a flat fill or a full-bleed raster."""

    kind: str  # "solid" | "raster"
    # "#rrggbb" when kind == "solid"; absent for a raster background.
    value: str | None = Field(default=None, pattern=_HEX_COLOR_PATTERN)
    asset: str | None = None  # registered assets/... path when kind == "raster"


class StyleTokens(_Strict):
    """One source page's palette, type scale, background, and spacing."""

    colors: list[ColorToken] = []
    type_scale: list[TypeToken] = []
    background: BackgroundToken | None = None
    spacing: dict[str, float] = {}


def _role_sizes(sizes: list[float]) -> dict[str, float]:
    """Assign ``title``/``body``/``caption`` to font sizes, deterministically.

    Largest size is the title, the most frequent size is the body, the
    smallest is the caption. Ties on frequency resolve to the larger size.
    When the body would collide with the title, the title wins and the body
    drops to the next size down; a caption that collides with either role is
    simply not emitted rather than duplicating another role's typography.
    """
    unique = sorted(set(sizes), reverse=True)
    if not unique:
        return {}
    counts = Counter(sizes)
    assigned: dict[str, float] = {"title": unique[0]}
    candidates = [size for size in unique if size != assigned["title"]]
    if candidates:
        assigned["body"] = max(candidates, key=lambda size: (counts[size], size))
    caption = unique[-1]
    if caption not in assigned.values():
        assigned["caption"] = caption
    return assigned


def _pdf_text_color(text: dict) -> str | None:
    """The stated fill, else the first observed reference color, else nothing."""
    stated = text.get("color")
    if stated:
        return stated
    palette = text.get("reference_palette") or []
    return palette[0] if palette else None


def tokens_from_pdf_page(source: "PdfPageSource") -> StyleTokens:
    """Derive tokens from the original PDF fields only.

    Reads ``font``/``weight``/``size``/``color``/geometry as ``extract_pdf_pages``
    recorded them. The ``css_top``/``line_height``/``reference_color`` keys
    ``write_pdf_html`` adds in place are deliberately not read: they exist only
    after ``reconstruct_pdf_page`` has run, and that function is injectable, so
    depending on them would make the compile path behave differently under a
    test stub. ``line_height_px`` is derived from the size instead.
    """
    texts = [text for text in source.texts if text.get("size")]
    canvas_height = (
        source.height * _CANVAS_WIDTH_PX / source.width if source.width else 0.0
    )
    canvas_area = _CANVAS_WIDTH_PX * canvas_height

    page_has_hangul = contains_hangul(
        "".join(str(text.get("text") or "") for text in texts)
    )

    type_scale: list[TypeToken] = []
    for role, size in _role_sizes([float(text["size"]) for text in texts]).items():
        matches = [text for text in texts if float(text["size"]) == size]
        representative = min(matches, key=lambda text: text.get("order", 0))
        family = representative.get("font") or ""
        weight = int(representative.get("weight") or 400)
        matched = match_open_source_family(family, weight, has_hangul=page_has_hangul)
        type_scale.append(
            TypeToken(
                role=role,
                family=family,
                export_family="" if matched == family else matched,
                size_px=size,
                weight=weight,
                line_height_px=round(size * _LINE_HEIGHT_RATIO, 2),
                color=_pdf_text_color(representative),
            )
        )
    type_scale.sort(key=lambda token: _ROLE_ORDER.index(token.role))

    ink_coverage: dict[str, float] = {}
    for text in texts:
        color = _pdf_text_color(text)
        if not color:
            continue
        area = float(text.get("w") or 0.0) * float(text.get("h") or 0.0)
        ink_coverage[color] = ink_coverage.get(color, 0.0) + area
    colors = [
        ColorToken(
            role="ink",
            value=color,
            coverage=round(min(area / canvas_area, 1.0), 4) if canvas_area else 0.0,
        )
        for color, area in sorted(ink_coverage.items(), key=lambda item: -item[1])
    ]

    background = _pdf_background(source, canvas_area)
    if background and background.kind == "solid" and background.value:
        colors.insert(0, ColorToken(role="background", value=background.value, coverage=1.0))

    spacing: dict[str, float] = {}
    if texts:
        spacing["page_margin_left"] = round(min(float(t.get("x") or 0.0) for t in texts), 2)
        spacing["page_margin_top"] = round(min(float(t.get("y") or 0.0) for t in texts), 2)

    return StyleTokens(
        colors=colors, type_scale=type_scale, background=background, spacing=spacing
    )


def _pdf_background(source: "PdfPageSource", canvas_area: float) -> BackgroundToken | None:
    """A full-bleed registered raster, else the most-observed reference color."""
    for box in source.image_boxes:
        area = float(box.get("w") or 0.0) * float(box.get("h") or 0.0)
        if canvas_area and area / canvas_area >= _BACKGROUND_COVERAGE:
            return BackgroundToken(kind="raster", asset=box.get("src"))
    palette = Counter(
        color
        for text in source.texts
        for color in (text.get("reference_palette") or [])[:1]
    )
    if not palette:
        return None
    return BackgroundToken(kind="solid", value=palette.most_common(1)[0][0])


def tokens_from_measured_layout(layout: dict) -> StyleTokens:
    """Derive tokens from a ``measure_slide`` result (the PPTX compile path).

    Each measured text block reports the computed typography the renderer
    actually resolved, so role assignment reuses the same size ranking as the
    PDF path over ``textBlocks``.
    """
    blocks = [block for block in layout.get("textBlocks", []) if block.get("size")]
    type_scale: list[TypeToken] = []
    for role, size in _role_sizes([float(block["size"]) for block in blocks]).items():
        matches = [block for block in blocks if float(block["size"]) == size]
        representative = min(matches, key=lambda block: (block.get("y", 0.0), block.get("x", 0.0)))
        paragraphs = representative.get("paragraphs") or []
        line_height = paragraphs[0].get("lineHeight") if paragraphs else None
        type_scale.append(
            TypeToken(
                role=role,
                family=_first_family(representative.get("font") or ""),
                size_px=size,
                weight=_weight(representative.get("weight")),
                line_height_px=float(line_height or round(size * _LINE_HEIGHT_RATIO, 2)),
                color=_hex_color(representative.get("color")),
            )
        )
    type_scale.sort(key=lambda token: _ROLE_ORDER.index(token.role))

    colors = [
        ColorToken(role="ink", value=token.color, coverage=0.0)
        for token in type_scale
        if token.color
    ]
    return StyleTokens(colors=colors, type_scale=type_scale)


def _first_family(font: str) -> str:
    """The first family of a computed ``font-family`` list, unquoted."""
    return font.split(",")[0].strip().strip("\"'")


def _weight(value: object) -> int:
    try:
        weight = int(float(str(value)))
    except (TypeError, ValueError):
        return 400
    return weight if 1 <= weight <= 1000 else 400


def _hex_color(value: object) -> str | None:
    """``rgb()``/``rgba()`` as reported by ``getComputedStyle`` to ``#rrggbb``."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.startswith("#"):
        # A shorthand such as "#abc" is dropped rather than expanded: the
        # token schema admits "#rrggbb" only, and a value the browser never
        # reports is not worth a conversion path.
        return text if _HEX_COLOR.fullmatch(text) else None
    if not text.startswith(("rgb(", "rgba(")):
        return None
    parts = text[text.index("(") + 1 : text.rindex(")")].replace("/", " ").split(",")
    channels = [part.strip() for part in " ".join(parts).split() if part.strip()]
    if len(channels) < 3:
        return None
    try:
        rgb = [max(0, min(255, int(float(channel)))) for channel in channels[:3]]
    except ValueError:
        return None
    return "#" + "".join(f"{channel:02x}" for channel in rgb)


def tokens_to_css(tokens: StyleTokens) -> str:
    """Role-default declarations for the token type scale.

    Literal values only, one ``[data-text-role="..."]`` rule per role, and no
    positional property — see this module's docstring for why both hold.
    """
    rules: list[str] = []
    for token in tokens.type_scale:
        if token.role not in _ROLE_ORDER:
            continue
        declarations = []
        family = _css_family(token.family)
        if family:
            # The original name first (it resolves when the viewer has the
            # font installed), then the matched open-source family, then the
            # generic — never a silent single substitute.
            fallbacks = [f'"{family}"']
            export_family = _css_family(token.export_family)
            if export_family and export_family != family:
                fallbacks.append(f'"{export_family}"')
            declarations.append("font-family:" + ",".join([*fallbacks, "sans-serif"]))
        declarations.append(f"font-size:{_px(token.size_px)}px")
        declarations.append(f"font-weight:{token.weight}")
        declarations.append(f"line-height:{_px(token.line_height_px)}px")
        if token.color and _HEX_COLOR.fullmatch(token.color):
            declarations.append(f"color:{token.color}")
        rules.append(f'[data-text-role="{token.role}"]{{{";".join(declarations)}}}')
    return "".join(rules)


def _css_family(family: str) -> str:
    """A family name safe to place inside a quoted CSS string.

    The name comes from an uploaded file, so characters that could close the
    quote or the ``<style>`` element are dropped rather than escaped.
    """
    return "".join(char for char in family if char not in '"\\<>{};').strip()


def _px(value: float) -> str:
    """Trim a trailing ``.0`` so emitted CSS reads like hand-written CSS."""
    rounded = round(value, 2)
    return str(int(rounded)) if rounded == int(rounded) else str(rounded)
