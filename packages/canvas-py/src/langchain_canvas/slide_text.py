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

# The px canvas the deck model measures type on: a 1280 x 720 page, so a box
# of w% x h% is (w * 12.8) by (h * 7.2) px.
PAGE_W_PX, PAGE_H_PX = 1280.0, 720.0
# Rough glyph widths as a fraction of the font size.
WIDE_GLYPH = 1.0  # CJK, full-width
NARROW_GLYPH = 0.55  # Latin, digits, punctuation
SPACE_GLYPH = 0.3
DEFAULT_LINE_HEIGHT = 1.2
# PowerPoint stops shrinking at a quarter of the set size; so does this.
MIN_FIT_SCALE = 0.25


def glyph_width(char: str) -> float:
    if char.isspace():
        return SPACE_GLYPH
    return WIDE_GLYPH if ord(char) > 0x2E7F else NARROW_GLYPH


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
    text: str, size: float, w: float, h: float, line_height: float | None = None
) -> float:
    """The box height (percent of the page) once it has grown to hold ``text``.

    Never less than ``h``: a box that grows with its text does not shrink
    below the size its author gave it.
    """
    needed = needed_height(text, size, w / 100.0 * PAGE_W_PX, line_height)
    return max(h, round(needed / PAGE_H_PX * 100.0, 3))


def fit_scale(
    text: str, size: float, w: float, h: float, line_height: float | None = None
) -> float:
    """How far the type shrinks so ``text`` stays inside a w% x h% box (1 = not at all)."""
    needed = needed_height(text, size, w / 100.0 * PAGE_W_PX, line_height)
    box_h = h / 100.0 * PAGE_H_PX
    if needed <= 0 or box_h <= 0 or needed <= box_h:
        return 1.0
    return max(MIN_FIT_SCALE, round(box_h / needed, 3))
