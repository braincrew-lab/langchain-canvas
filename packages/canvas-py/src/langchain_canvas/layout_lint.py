"""Coordinate-level layout checks for slide decks.

A good share of broken layouts is decidable from the numbers alone — no
render needed: an element off the page, a zero-sized box, an empty text
element, an image pointing at a file the canvas does not have, an element
completely hidden behind an opaque rectangle. These checks run at save
time and their findings ride the ``write_canvas`` result, so the model
sees a defect the moment it writes one and can fix it on the next turn.

Design rules, in order of importance:

1. **No false positives.** One wrong warning teaches the model to ignore
   the channel. Every check here is decidable from coordinates and fields
   with certainty; anything that needs font metrics or taste (text
   overflow, "too crowded", contrast) is deliberately absent — the model
   has real eyes for that (render the exported file via ``read_canvas``
   with ``pages=``).
2. **Silence is the default.** A clean deck adds nothing to the result.
3. Warnings name **what, where, and why** so the model can jump straight
   to the element: ``slide 2, element "title": x + w = 118 (off the
   page)``.

Structured slides (title / bullets, no ``elements``) are skipped: their
layout is derived and always in bounds.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from langchain_canvas.assets import normalize_asset_reference

# Percent-point slack so the 4-decimal rounding the re-fit writes can never
# trip the boundary checks.
_EDGE_TOLERANCE = 0.01

# Warnings beyond this are summarized — a deck with dozens of defects needs
# the pattern named, not every instance listed.
_MAX_WARNINGS = 8

# A solid hex fill (3/6 digits) is opaque; 4/8-digit hex carries alpha and
# anything else (gradients, named colors) is not certain — those never count
# as cover.
_OPAQUE_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

# The half-open padding range the schema enforces: pad >= 50 leaves span <= 0
# (no content area at all).
PADDING_MAX_EXCLUSIVE = 50.0


def lint_slides_data(
    data: dict[str, Any],
    *,
    ref_exists: Callable[[str], bool] | None = None,
) -> list[str]:
    """Certain-only layout warnings for one deck's ``data`` dict, or ``[]``.

    ``ref_exists`` answers whether a canvas-root-relative reference (from
    ``normalize_asset_reference``) is present on the canvas; omit it to
    skip the broken-reference check (for callers without store access).
    """
    warnings: list[str] = []
    slides = data.get("slides")
    if not isinstance(slides, list):
        return warnings
    for number, slide in enumerate(slides, start=1):
        if not isinstance(slide, dict):
            continue
        _check_padding(slide, number, warnings)
        elements = slide.get("elements")
        if not isinstance(elements, list):
            continue
        boxed = [
            (element, _box(element))
            for element in elements
            if isinstance(element, dict)
        ]
        for index, (element, box) in enumerate(boxed):
            label = _label(element, index)
            if box is None:
                continue
            x, y, w, h = box
            if w <= 0 or h <= 0:
                warnings.append(
                    f'slide {number}, element {label}: w = {_fmt(w)}, h = {_fmt(h)}'
                    " (zero or negative size renders nothing)"
                )
                continue
            _check_off_page(number, label, x, y, w, h, warnings)
            _check_empty_text(element, number, label, warnings)
            _check_broken_reference(element, number, label, ref_exists, warnings)
            _check_full_cover(number, index, label, box, boxed, warnings)
    if len(warnings) > _MAX_WARNINGS:
        hidden = len(warnings) - _MAX_WARNINGS
        warnings = warnings[:_MAX_WARNINGS]
        warnings.append(f"... and {hidden} more like these")
    return warnings


def format_layout_warnings(warnings: list[str]) -> str:
    """The warnings as one block to append to a tool result ('' when clean)."""
    if not warnings:
        return ""
    lines = "\n".join(f"- {warning}" for warning in warnings)
    return (
        "\nLayout check:\n"
        f"{lines}\n"
        "These are exact coordinate findings. To see the slide as an image, "
        'export it and read the pptx with pages="grid".'
    )


def _box(element: dict[str, Any]) -> tuple[float, float, float, float] | None:
    values = []
    for key in ("x", "y", "w", "h"):
        value = element.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return None  # malformed geometry — the exporter reports it later
        values.append(float(value))
    return values[0], values[1], values[2], values[3]


def _label(element: dict[str, Any], index: int) -> str:
    identifier = element.get("id")
    if isinstance(identifier, str) and identifier:
        return f'"{identifier}"'
    return f"#{index + 1}"


def _fmt(value: float) -> str:
    return f"{value:g}"


def _check_padding(slide: dict[str, Any], number: int, warnings: list[str]) -> None:
    padding = slide.get("padding")
    if not isinstance(padding, (int, float)) or isinstance(padding, bool):
        return
    if padding < 0 or padding >= PADDING_MAX_EXCLUSIVE:
        warnings.append(
            f"slide {number}: padding = {_fmt(float(padding))} leaves no content "
            "area (must be 0 to below 50)"
        )


def _check_off_page(
    number: int,
    label: str,
    x: float,
    y: float,
    w: float,
    h: float,
    warnings: list[str],
) -> None:
    findings = []
    if x < -_EDGE_TOLERANCE:
        findings.append(f"x = {_fmt(x)}")
    if y < -_EDGE_TOLERANCE:
        findings.append(f"y = {_fmt(y)}")
    if x + w > 100.0 + _EDGE_TOLERANCE:
        findings.append(f"x + w = {_fmt(x + w)}")
    if y + h > 100.0 + _EDGE_TOLERANCE:
        findings.append(f"y + h = {_fmt(y + h)}")
    if findings:
        warnings.append(
            f"slide {number}, element {label}: {', '.join(findings)} "
            "(off the page — the page runs 0 to 100)"
        )


def _check_empty_text(
    element: dict[str, Any], number: int, label: str, warnings: list[str]
) -> None:
    if element.get("type") != "text":
        return
    text = element.get("text")
    if text is None or (isinstance(text, str) and not text.strip()):
        warnings.append(
            f"slide {number}, element {label}: a text element with no text "
            "(renders an empty box)"
        )


def _check_broken_reference(
    element: dict[str, Any],
    number: int,
    label: str,
    ref_exists: Callable[[str], bool] | None,
    warnings: list[str],
) -> None:
    if ref_exists is None or element.get("type") != "image":
        return
    src = element.get("src")
    if not isinstance(src, str):
        return
    reference = normalize_asset_reference(src)
    if reference is not None and not ref_exists(reference):
        warnings.append(
            f"slide {number}, element {label}: src \"{src}\" is not on the "
            "canvas (use list_canvas_files to see what is)"
        )


def _check_full_cover(
    number: int,
    index: int,
    label: str,
    box: tuple[float, float, float, float],
    boxed: list[tuple[dict[str, Any], tuple[float, float, float, float] | None]],
    warnings: list[str],
) -> None:
    """A later opaque rectangle that fully contains this element hides it.

    Paint order is array order (end = front). Only a rect-shaped element
    with a solid hex fill (or the default fill) counts as cover — an
    ellipse does not fill its bounding box, and image transparency is
    unknowable from coordinates.
    """
    x, y, w, h = box
    for cover_index in range(index + 1, len(boxed)):
        cover, cover_box = boxed[cover_index]
        if cover_box is None or not _is_opaque_rect(cover):
            continue
        cx, cy, cw, ch = cover_box
        if (
            cx <= x + _EDGE_TOLERANCE
            and cy <= y + _EDGE_TOLERANCE
            and cx + cw >= x + w - _EDGE_TOLERANCE
            and cy + ch >= y + h - _EDGE_TOLERANCE
        ):
            warnings.append(
                f"slide {number}, element {label} is completely covered by "
                f"element {_label(cover, cover_index)} "
                "(an opaque rectangle drawn in front of it)"
            )
            return


def _is_opaque_rect(element: dict[str, Any]) -> bool:
    if element.get("type") != "shape":
        return False
    shape = element.get("shape")
    if shape in ("ellipse", "line"):
        return False
    fill = element.get("fill")
    if fill is None:
        return True  # the default fill is a solid color
    return isinstance(fill, str) and bool(_OPAQUE_HEX.match(fill))
