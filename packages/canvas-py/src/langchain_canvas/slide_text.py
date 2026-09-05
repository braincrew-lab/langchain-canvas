"""Text metrics shared by the deck check, the exporter and the renderer.

How many lines a text takes in its box, how tall the box has to be to hold
them, and how far the type has to shrink to stay inside — estimated the
same way on both sides of the wire (``canvas-react/src/client/slideText.ts``
is the twin, held to the same golden cases), so the frame the editor draws,
the finding the check names and the box the exporter writes agree without
anyone measuring pixels. The estimate is coarse (glyph widths by script, no
kerning) and is only ever used with a margin.
"""

from __future__ import annotations

import math

# Px per inch the deck model measures type on — 1280px across a 10in page.
# Type sizes are px at this density; a taller or narrower page measures on a
# proportionally taller or narrower canvas, so autofit follows the page shape
# instead of a fixed 16:9.
METRIC_DPI = 128.0
# The px canvas for the classic 16:9 page (10 x 5.625 in) — the default when a
# caller passes no page, so a box of w% x h% is (w * 12.8) by (h * 7.2) px and
# every page-less measurement is unchanged.
PAGE_W_PX, PAGE_H_PX = 1280.0, 720.0
# Rough glyph widths as a fraction of the font size.
WIDE_GLYPH = 1.0  # CJK, full-width
NARROW_GLYPH = 0.55  # Latin, digits, punctuation
SPACE_GLYPH = 0.3
DEFAULT_LINE_HEIGHT = 1.2
# PowerPoint stops shrinking at a quarter of the set size; so does this.
MIN_FIT_SCALE = 0.25


def metrics_page_px(page: tuple[float, float] | None = None) -> tuple[float, float]:
    """The px canvas ``page`` (``(width_in, height_in)``) measures type on.

    Defaults to the classic 16:9 canvas when the page is absent or malformed,
    so a page-less deck measures exactly as it did before this was page-aware.
    """
    if page is None:
        return PAGE_W_PX, PAGE_H_PX
    width_in, height_in = page
    if not (width_in > 0 and height_in > 0):
        return PAGE_W_PX, PAGE_H_PX
    return width_in * METRIC_DPI, height_in * METRIC_DPI


def glyph_width(char: str) -> float:
    if char.isspace():
        return SPACE_GLYPH
    return WIDE_GLYPH if ord(char) > 0x2E7F else NARROW_GLYPH


def widest_line_px(text: str, size: float) -> float:
    """The px width of the text's widest typed line — what a no-wrap box has
    to hold. A wrap="none" box never folds, so its overflow runs sideways and
    the wrapped-height estimate says nothing about it."""
    return max(
        (sum(glyph_width(ch) for ch in line) * size for line in text.split("\n")),
        default=0.0,
    )


def wrapped_lines(text: str, size: float, box_w: float) -> int:
    """How many lines ``text`` takes at ``size`` px in a box ``box_w`` px wide."""
    lines = 0
    for paragraph in text.split("\n"):
        width = sum(glyph_width(ch) for ch in paragraph) * size
        lines += max(1, math.ceil(width / box_w)) if paragraph else 1
    return lines


def needed_height(text: str, size: float, box_w: float, line_height: float | None = None) -> float:
    """The px height ``text`` needs at ``size`` px in a box ``box_w`` px wide."""
    leading = line_height if line_height and line_height > 0 else DEFAULT_LINE_HEIGHT
    return wrapped_lines(text, size, box_w) * size * leading


def grown_height_pct(
    text: str, size: float, w: float, h: float, line_height: float | None = None,
    page: tuple[float, float] | None = None,
) -> float:
    """The box height (percent of the page) once it has grown to hold ``text``.

    Never less than ``h``: a box that grows with its text does not shrink
    below the size its author gave it. ``page`` shapes the px canvas so a
    portrait box grows by the right amount; absent, it is the classic 16:9.
    """
    page_w, page_h = metrics_page_px(page)
    needed = needed_height(text, size, w / 100.0 * page_w, line_height)
    return max(h, round(needed / page_h * 100.0, 3))


def fit_scale(
    text: str, size: float, w: float, h: float, line_height: float | None = None,
    page: tuple[float, float] | None = None,
) -> float:
    """How far the type shrinks so ``text`` stays inside a w% x h% box (1 = not at all)."""
    page_w, page_h = metrics_page_px(page)
    needed = needed_height(text, size, w / 100.0 * page_w, line_height)
    box_h = h / 100.0 * page_h
    if needed <= 0 or box_h <= 0 or needed <= box_h:
        return 1.0
    return max(MIN_FIT_SCALE, round(box_h / needed, 3))
