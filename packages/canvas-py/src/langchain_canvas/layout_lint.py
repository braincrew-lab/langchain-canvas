"""Save-time checks for slide decks.

A good share of broken decks is decidable from the saved JSON alone — no
render needed. Three families:

* **Schema** — the deck does not match ``SlidesData``, so the export
  refuses it; or it carries fields the schema has no place for, which
  nothing reads.
* **Shadowed content** — a slide that sets ``elements`` *and* the
  structured fields (``title`` / ``bullets`` / ...). ``elements`` wins
  everywhere, so the structured text is written but never drawn.
* **Coordinates** — an element off the page, a zero-sized box, an empty
  text element, an image pointing at a file the canvas does not have, an
  element completely hidden behind an opaque rectangle.

These run at save time and their findings ride the ``write_canvas``
result, so the model sees a defect the moment it writes one and can fix
it on the next turn.

Design rules, in order of importance:

1. **No false positives.** One wrong warning teaches the model to ignore
   the channel. Every check here is decidable from the data with
   certainty; anything that needs font metrics or taste (text overflow,
   "too crowded", contrast) is deliberately absent — the model has real
   eyes for that (render the exported file via ``read_canvas`` with
   ``pages=``).
2. **Silence is the default.** A clean deck adds nothing to the result.
3. Warnings name **what, where, why, and how to fix it** so the model can
   act without reading a schema it cannot see: ``slide 2, element
   "title": x + w = 118 (off the page)``.

Nothing here blocks a save. A draft in progress is worth more than a
rejected write.

Structured slides (title / bullets, no ``elements``) skip the coordinate
checks: their layout is derived and always in bounds.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any

from pydantic import ValidationError

from langchain_canvas.assets import normalize_asset_reference
from langchain_canvas.protocol.artifacts import (
    Slide,
    SlideElement,
    SlidePage,
    SlidesData,
)

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

# Schema findings arrive as one grouped warning; past this many lines the
# rest are counted, because the same mistake usually repeats per element.
_MAX_SCHEMA_DETAILS = 6

# Structured content a slide draws only when it has no ``elements``. Order
# is the order they are named in a warning.
_SHADOWED_FIELDS = ("title", "subtitle", "bullets", "bullets2", "image")

# Fix advice for the fields models most often leave out. Pydantic's own
# message covers the rest (a literal error already lists the valid values).
_FIX_HINTS = {
    "id": 'give every element a short unique id string, e.g. "title"',
}

# (field, pydantic error type) pairs a dedicated check below already reports
# with a fuller message; listing them twice would say the same thing twice.
# Only the bound errors are skipped — a padding of the wrong *type* still
# needs the schema line, because the dedicated check ignores non-numbers.
_REPORTED_ELSEWHERE = frozenset(
    {("padding", "less_than"), ("padding", "greater_than_equal")}
)


def lint_slides_data(
    data: dict[str, Any],
    *,
    ref_exists: Callable[[str], bool] | None = None,
) -> list[str]:
    """Certain-only warnings for one deck's ``data`` dict, or ``[]``.

    ``ref_exists`` answers whether a canvas-root-relative reference (from
    ``normalize_asset_reference``) is present on the canvas; omit it to
    skip the broken-reference check (for callers without store access).
    """
    warnings: list[str] = []
    _check_schema(data, warnings)
    _check_unknown_fields(data, warnings)
    slides = data.get("slides")
    if not isinstance(slides, list):
        return _capped(warnings)
    for number, slide in enumerate(slides, start=1):
        if not isinstance(slide, dict):
            continue
        _check_shadowed_content(slide, number, warnings)
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
    return _capped(warnings)


def _capped(warnings: list[str]) -> list[str]:
    if len(warnings) <= _MAX_WARNINGS:
        return warnings
    hidden = len(warnings) - _MAX_WARNINGS
    return [*warnings[:_MAX_WARNINGS], f"... and {hidden} more like these"]


def format_layout_warnings(warnings: list[str]) -> str:
    """The warnings as one block to append to a tool result ('' when clean)."""
    if not warnings:
        return ""
    lines = "\n".join(f"- {warning}" for warning in warnings)
    return (
        "\nDeck check:\n"
        f"{lines}\n"
        "These are exact findings read from the file you just saved. To see a "
        'slide as an image, export it and read the pptx with pages="grid".'
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


def _check_schema(data: dict[str, Any], warnings: list[str]) -> None:
    """One grouped warning when the deck does not parse as ``SlidesData``.

    The export validates the same model, so anything reported here is an
    export the model cannot run yet. Findings are grouped under a single
    entry because one mistake (a missing ``id``) usually repeats across
    every element of a deck.
    """
    try:
        SlidesData.model_validate(data)
        return
    except ValidationError as exc:
        errors = exc.errors()
    except Exception:  # noqa: BLE001 - a check must never break the save
        return
    errors = [error for error in errors if not _reported_elsewhere(error)]
    if not errors:
        return
    details = [_schema_detail(error) for error in errors[:_MAX_SCHEMA_DETAILS]]
    hidden = len(errors) - len(details)
    if hidden > 0:
        details.append(f"... and {hidden} more")
    lines = "\n".join(f"  - {detail}" for detail in details)
    warnings.append(
        "this deck does not match the slides schema, so exporting it fails "
        f"until these are fixed:\n{lines}"
    )


def _reported_elsewhere(error: Mapping[str, Any]) -> bool:
    location = error.get("loc") or ()
    field = location[-1] if location and isinstance(location[-1], str) else None
    return (field, error.get("type")) in _REPORTED_ELSEWHERE


def _schema_detail(error: Mapping[str, Any]) -> str:
    """One validation error as 'where: what — how to fix it'."""
    location = error.get("loc") or ()
    field = location[-1] if location and isinstance(location[-1], str) else None
    where = _schema_where(location)
    name = f'"{field}"' if field else "the deck"
    if error.get("type") == "missing":
        hint = _FIX_HINTS.get(field or "", "add it")
        return f"{where}: {name} is required — {hint}"
    got = _schema_input(error.get("input"))
    return f"{where}: {name}{got} — {error.get('msg', 'is not valid')}"


def _schema_where(location: tuple[Any, ...]) -> str:
    """'slide 2, element #1' from a pydantic error location."""
    if location and location[0] == "page":
        return "the deck page"
    parts: list[str] = []
    for index, step in enumerate(location):
        following = location[index + 1] if index + 1 < len(location) else None
        if not isinstance(following, int) or isinstance(following, bool):
            continue
        if step == "slides":
            parts.append(f"slide {following + 1}")
        elif step == "elements":
            parts.append(f"element #{following + 1}")
    return ", ".join(parts) if parts else "the deck"


def _schema_input(value: Any) -> str:
    """The offending value, when it is short enough to name."""
    if isinstance(value, (str, int, float, bool)):
        text = f"{value}"
        if len(text) <= 40:
            return f" = {text!r}" if isinstance(value, str) else f" = {text}"
    return ""


def _check_unknown_fields(data: dict[str, Any], warnings: list[str]) -> None:
    """One grouped warning for fields the schema has no place for.

    Pydantic drops them without complaint, so the export succeeds and the
    canvas renders — just without whatever the field was meant to do. That
    silence is the whole reason this check exists.
    """
    found: list[str] = []
    _collect_unknown(data, _DECK_KEYS, "the deck", found)
    slides = data.get("slides")
    if isinstance(slides, list):
        for number, slide in enumerate(slides, start=1):
            if not isinstance(slide, dict):
                continue
            _collect_unknown(slide, _SLIDE_KEYS, f"slide {number}", found)
            elements = slide.get("elements")
            if not isinstance(elements, list):
                continue
            for index, element in enumerate(elements):
                if isinstance(element, dict):
                    _collect_unknown(
                        element,
                        _ELEMENT_KEYS,
                        f"slide {number}, element {_label(element, index)}",
                        found,
                    )
    page = data.get("page")
    if isinstance(page, dict):
        _collect_unknown(page, _PAGE_KEYS, "the deck page", found)
    if not found:
        return
    details = found[:_MAX_SCHEMA_DETAILS]
    hidden = len(found) - len(details)
    if hidden > 0:
        details.append(f"... and {hidden} more")
    lines = "\n".join(f"  - {detail}" for detail in details)
    warnings.append(
        "these fields are not in the slides schema, so the canvas and the "
        f"export both ignore them — remove them or use a field that exists:\n{lines}"
    )


def _collect_unknown(
    body: dict[str, Any], allowed: frozenset[str], where: str, found: list[str]
) -> None:
    for key in body:
        if isinstance(key, str) and key not in allowed:
            found.append(f'{where}: "{key}"')


def _allowed_keys(model: type[Any]) -> frozenset[str]:
    """Every key the model accepts — declared name and camelCase alias."""
    keys: set[str] = set()
    for name, field in model.model_fields.items():
        keys.add(name)
        if field.alias:
            keys.add(field.alias)
    return frozenset(keys)


_DECK_KEYS = _allowed_keys(SlidesData)
_SLIDE_KEYS = _allowed_keys(Slide)
_ELEMENT_KEYS = _allowed_keys(SlideElement)
_PAGE_KEYS = _allowed_keys(SlidePage)


def _check_shadowed_content(
    slide: dict[str, Any], number: int, warnings: list[str]
) -> None:
    """Structured text on a slide that also carries ``elements``.

    Everything that draws a slide — the editor, the presenter, every
    exporter — takes ``elements`` when it is non-empty and derives from
    the structured fields only when it is empty. So a slide with both
    stores the structured text and never shows it.
    """
    elements = slide.get("elements")
    if not isinstance(elements, list) or not elements:
        return
    shadowed = [field for field in _SHADOWED_FIELDS if slide.get(field)]
    if not shadowed:
        return
    named = ", ".join(f'"{field}"' for field in shadowed)
    verb = "is" if len(shadowed) == 1 else "are"
    warnings.append(
        f'slide {number}: {named} {verb} set next to "elements", and only '
        '"elements" is drawn — move that text into an element, or remove '
        '"elements" so the structured layout draws it'
    )


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
