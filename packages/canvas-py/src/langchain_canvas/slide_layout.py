"""Where a structured slide's text goes.

A slide is either free-form — an explicit ``elements`` array someone dragged
into place — or structured: a ``title``, some ``bullets``, a ``layout`` name.
Structured slides are laid out here, and the result is what the canvas draws,
what the presenter shows, and what every exporter writes. So a deck written
without a single coordinate still arrives composed.

This is the twin of ``toElements`` in
``canvas-react/src/client/slideElements.ts``. Both sides reproduce
``canvas-react/src/client/derivedLayout.golden.json``, and both test suites
hold their side to it, so the two cannot drift apart unnoticed.

Type scale
    One ~1.25 geometric run, so a deck never carries a size picked at
    random:

    ==========  ====  ====================================================
    display     48    the cover line, and a section break
    title       38    a slide heading
    body        30    the first step of the body ramp
    body        24    ...
    body        19    ...the last step, before a slide is simply too full
    ==========  ====  ====================================================

The body block
    Bullets are not stamped at a fixed pitch. Each is measured — how many
    lines it wraps to at the size being tried — the largest body step whose
    block fits the content band wins, and the room left over becomes the
    space between them. Three short lines breathe, ten stay on the page,
    and neither needs the agent to have thought about it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .protocol.artifacts import Slide, SlideElement, SlidePage

# The classic deck page: 16:9 at 96 dpi (10 x 5.625 in). Geometry is percent
# of the page and ``fontSize`` is px inside it, so a line box converts to
# percent through the page's own pixel size — which is why the page travels
# with the slide instead of being assumed here.
DEFAULT_PAGE_IN = (10.0, 5.625)
_DPI = 96.0

FONT_DISPLAY = 48.0
FONT_TITLE = 38.0
#: Largest first — the layout takes the first step whose block fits.
BODY_RAMP = (30.0, 24.0, 19.0)
#: A heading shrinks before it eats the slide it is heading.
TITLE_RAMP = (FONT_TITLE, 30.0, 24.0)
#: A cover line shrinks the same way.
DISPLAY_RAMP = (FONT_DISPLAY, FONT_TITLE, 30.0)

#: Line box over font size. The renderer, the print sheet, and PowerPoint all
#: sit near this, so a box this tall holds its text at every destination.
LINE_HEIGHT = 1.35
#: Space between bullets, as a multiple of the line box. The floor is what
#: makes a body step count as comfortable; the ceiling stops a two-bullet
#: slide from reading as two unrelated slides.
GAP_MIN = 0.35
GAP_MAX = 3.0

# The content band, in percent of the page: below the heading, above a bottom
# margin a little deeper than the top one, which is what stops a deck from
# looking like it starts at the very edge.
BODY_TOP = 28.0
BODY_BOTTOM = 88.0
BODY_LEFT = 8.0
BODY_WIDTH = 84.0

_TITLE_TOP = 7.0
_TITLE_LEFT = 6.0
_TITLE_WIDTH = 88.0
# How far down the page a heading may reach. Past this the body band would
# collapse, and a collapsed band is how a slide starts placing its bullets
# below the page — or, with a negative band, in reverse order.
_TITLE_BOTTOM = 46.0
# A subtitle on a content slide gets a couple of lines, no more.
_SUBTITLE_BUDGET = 12.0
# The cover's safe area, and how the two lines share it.
_COVER_TOP = 6.0
_COVER_BOTTOM = 94.0
_COVER_TITLE_SHARE = 0.66
_COVER_SUBTITLE_SHARE = 0.22
_COLUMN_WIDTH = 42.0
_COLUMN_RIGHT_LEFT = 52.0

#: What a derived bullet line starts with. The pptx export reads it back
#: off the line to draw a real list bullet instead of a literal glyph.
BULLET_PREFIX = "• "
#: Above this code point a glyph is about an em wide (Hangul, CJK, kana,
#: fullwidth forms, emoji); below it, about half. Crude next to a real font
#: metric, but it only has to decide *how many lines*, and both twins have to
#: agree on the answer.
_WIDE_CHAR_FLOOR = 0x2E7F


def _page_px(page: SlidePage | None) -> tuple[float, float]:
    """The page in pixels, falling back to the classic canvas."""
    if page is None:
        return DEFAULT_PAGE_IN[0] * _DPI, DEFAULT_PAGE_IN[1] * _DPI
    width, height = page.width_in, page.height_in
    if not (width > 0 and height > 0):
        return DEFAULT_PAGE_IN[0] * _DPI, DEFAULT_PAGE_IN[1] * _DPI
    return width * _DPI, height * _DPI


def _display_width(text: str) -> int:
    """Text width in half-em units."""
    return sum(2 if ord(ch) > _WIDE_CHAR_FLOOR else 1 for ch in text)


def line_percent(font_px: float, page_height_px: float) -> float:
    """One line box as a percent of the page height."""
    return font_px * LINE_HEIGHT / page_height_px * 100.0


def line_count(text: str, width_percent: float, font_px: float, page_width_px: float) -> int:
    """How many lines ``text`` takes in a box that wide, at that size."""
    if not text:
        return 1
    per_line = (width_percent / 100.0) * page_width_px / (font_px / 2.0)
    if per_line < 1.0:
        return 1  # a box too narrow for one glyph; one line, and let it clip
    return max(1, math.ceil(_display_width(text) / per_line))


def _fit(
    texts: list[str], width: float, band: float, page_px: tuple[float, float]
) -> tuple[float, list[int]]:
    """The largest body step whose block fits the band, and its line counts.

    Falls back to the smallest step: past that the block no longer fits at
    any size, and :func:`_place` tiles the band instead of running off it.
    """
    page_w, page_h = page_px
    counts: list[int] = []
    size = BODY_RAMP[-1]
    for size in BODY_RAMP:
        counts = [line_count(t, width, size, page_w) for t in texts]
        line = line_percent(size, page_h)
        ink = sum(counts) * line
        floor_gap = GAP_MIN * line * max(0, len(texts) - 1)
        if ink + floor_gap <= band:
            return size, counts
    return size, counts


def _headline(
    text: str, width: float, budget: float, page_px: tuple[float, float],
    ramp: tuple[float, ...],
) -> tuple[float, float]:
    """(font size, height) for one headline, inside a vertical budget.

    Steps down the ramp until the wrapped text fits the budget, and clamps
    the box if even the smallest step does not. The clamp is what keeps a
    runaway title from pushing the body band to zero — or below zero, where
    the bullets came out reversed and off the page.
    """
    page_w, page_h = page_px
    size = ramp[-1]
    height = 0.0
    for size in ramp:
        height = line_count(text, width, size, page_w) * line_percent(size, page_h)
        if height <= budget:
            return size, height
    return size, min(height, budget)


@dataclass(frozen=True)
class DerivedLayout:
    """What a structured slide turns into, and whether it fitted.

    ``overfull`` is the one thing about a structured slide the layout cannot
    fix and the author can: the body did not fit even at the smallest body
    step, so the band was tiled and the lines now sit closer together than
    they are tall.
    """

    elements: list[SlideElement]
    overfull: bool


def _place(
    texts: list[str],
    counts: list[int],
    size: float,
    *,
    top: float,
    bottom: float,
    left: float,
    width: float,
    page_height_px: float,
) -> tuple[list[tuple[float, float, float, float, float]], bool]:
    """The boxes for a band, and whether the band had to be tiled to hold them.

    The room left over is shared out between the bullets up to a ceiling;
    past that the block is centred, so a slide of two points sits on the
    band's middle instead of hanging from its top.
    """
    n = len(texts)
    if n == 0:
        return [], False
    band = bottom - top
    line = line_percent(size, page_height_px)
    ink = sum(counts) * line

    if ink > band:
        # Too full for the smallest step. Tile the band evenly: the text may
        # crowd, but every bullet keeps a box on the page — the fixed pitch
        # this replaced simply walked off the bottom and took the last
        # bullets with it.
        pitch = band / n
        return [(left, top + i * pitch, width, pitch, size) for i in range(n)], True

    gap = 0.0
    if n > 1:
        # Never let the floor push the block past the band — a tight slide
        # closes up rather than walking off the page.
        gap = min(max((band - ink) / (n - 1), 0.0), GAP_MAX * line)
    boxes = []
    y = top + max(band - (ink + gap * (n - 1)), 0.0) / 2.0
    for count in counts:
        height = count * line
        boxes.append((left, y, width, height, size))
        y += height + gap
    return boxes, False


def _bullets(
    texts: list[str],
    *,
    top: float,
    bottom: float,
    left: float,
    width: float,
    page_px: tuple[float, float],
    size: float | None = None,
) -> tuple[list[tuple[float, float, float, float, float]], bool]:
    """Lay bulleted lines into a band."""
    if not texts:
        return [], False
    lines = [BULLET_PREFIX + t for t in texts]
    if size is None:
        size, counts = _fit(lines, width, bottom - top, page_px)
    else:
        counts = [line_count(t, width, size, page_px[0]) for t in lines]
    return _place(
        lines, counts, size,
        top=top, bottom=bottom, left=left, width=width, page_height_px=page_px[1],
    )


def derive_elements(slide: Slide, page: SlidePage | None = None) -> list[SlideElement]:
    """The elements a structured slide turns into."""
    return derive_layout(slide, page).elements


def derive_layout(slide: Slide, page: SlidePage | None = None) -> DerivedLayout:
    """The elements a structured slide turns into, and whether they fitted."""
    page_px = _page_px(page)
    page_w, page_h = page_px
    layout = slide.layout or "content"
    elements: list[SlideElement] = []

    def push(element_id: str, **kwargs: object) -> None:
        kwargs.setdefault("color", slide.text_color)
        elements.append(SlideElement(id=element_id, **kwargs))  # type: ignore[arg-type]

    if layout in ("title", "section"):
        # A cover and a section break are the same gesture: one line, centred,
        # at the display size — with the pair sitting on the page's middle.
        budget = _COVER_BOTTOM - _COVER_TOP
        title_size, title_h = (
            _headline(
                slide.title, _TITLE_WIDTH, budget * _COVER_TITLE_SHARE, page_px, DISPLAY_RAMP
            )
            if slide.title
            else (FONT_DISPLAY, 0.0)
        )
        sub_size, sub_h = (
            _headline(
                slide.subtitle, _TITLE_WIDTH, budget * _COVER_SUBTITLE_SHARE, page_px, BODY_RAMP
            )
            if slide.subtitle
            else (BODY_RAMP[0], 0.0)
        )
        spacer = line_percent(sub_size, page_h) if (title_h and sub_h) else 0.0
        # The shares leave the block inside the safe area, so the centred
        # pair cannot reach either edge however long the text runs.
        y = max(_COVER_TOP, (100.0 - (title_h + spacer + sub_h)) / 2.0)
        if slide.title:
            push(
                "title", type="text", x=_TITLE_LEFT, y=y, w=_TITLE_WIDTH, h=title_h,
                text=slide.title, font_size=title_size, bold=True, align="center",
            )
            y += title_h + spacer
        if slide.subtitle:
            push(
                "subtitle", type="text", x=_TITLE_LEFT, y=y, w=_TITLE_WIDTH, h=sub_h,
                text=slide.subtitle, font_size=sub_size, align="center",
            )
        return DerivedLayout(elements, False)

    body_top = BODY_TOP
    if slide.title:
        size, height = _headline(
            slide.title, _TITLE_WIDTH, _TITLE_BOTTOM - _TITLE_TOP, page_px, TITLE_RAMP
        )
        push(
            "title", type="text", x=_TITLE_LEFT, y=_TITLE_TOP, w=_TITLE_WIDTH,
            h=height, text=slide.title, font_size=size, bold=True,
        )
        body_top = max(body_top, _TITLE_TOP + height + line_percent(size, page_h) * 0.9)

    if layout == "image":
        if slide.image:
            elements.append(
                SlideElement(
                    id="img", type="image", x=14.0, y=body_top,
                    w=72.0, h=max(BODY_BOTTOM - body_top, 0.0), src=slide.image,
                )
            )
        return DerivedLayout(elements, False)

    if slide.subtitle:
        # A subtitle on a content slide used to vanish — the layout drew the
        # title and the bullets and nothing else. It sits under the heading.
        size, height = _headline(
            slide.subtitle, _TITLE_WIDTH, _SUBTITLE_BUDGET, page_px, BODY_RAMP
        )
        push(
            "subtitle", type="text", x=_TITLE_LEFT, y=body_top, w=_TITLE_WIDTH,
            h=height, text=slide.subtitle, font_size=size,
        )
        body_top = body_top + height + line_percent(size, page_h) * 0.9

    if layout == "two-column":
        # One size for both columns, so the two halves read as one slide.
        band = BODY_BOTTOM - body_top
        def column_size(texts: list[str]) -> float:
            return _fit([BULLET_PREFIX + t for t in texts], _COLUMN_WIDTH, band, page_px)[0]

        size = min(column_size(slide.bullets), column_size(slide.bullets2))
        overfull = False
        for prefix, texts, left in (
            ("bul", slide.bullets, BODY_LEFT - 2.0),
            ("bul2", slide.bullets2, _COLUMN_RIGHT_LEFT),
        ):
            boxes, tiled = _bullets(
                list(texts), top=body_top, bottom=BODY_BOTTOM, left=left,
                width=_COLUMN_WIDTH, page_px=page_px, size=size,
            )
            overfull = overfull or tiled
            for i, (x, y, w, h, font) in enumerate(boxes):
                push(f"{prefix}_{i}", type="text", x=x, y=y, w=w, h=h,
                     text=BULLET_PREFIX + texts[i], font_size=font)
        return DerivedLayout(elements, overfull)

    boxes, overfull = _bullets(
        list(slide.bullets), top=body_top, bottom=BODY_BOTTOM,
        left=BODY_LEFT, width=BODY_WIDTH, page_px=page_px,
    )
    for i, (x, y, w, h, font) in enumerate(boxes):
        push(f"bul_{i}", type="text", x=x, y=y, w=w, h=h,
             text=BULLET_PREFIX + slide.bullets[i], font_size=font)
    return DerivedLayout(elements, overfull)


def resolve_elements(slide: Slide, page: SlidePage | None = None) -> list[SlideElement]:
    """What is actually on the slide: explicit edits win, else derive."""
    return slide.elements if slide.elements else derive_elements(slide, page)
