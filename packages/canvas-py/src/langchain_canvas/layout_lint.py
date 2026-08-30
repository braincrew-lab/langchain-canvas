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
  element completely hidden behind an opaque rectangle. A structured
  slide carries no coordinates of its own, so these run on the boxes it
  will be *drawn* as, named the way the author wrote them
  (``"bullets[3]"``, not ``"bul_2"``).
* **Room** — a slide with more body than the layout can hold at its
  smallest text size, and text smaller than the slide can show.

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

Who a warning is for decides whether it belongs here at all. A finding the
author can act on — too much on one slide, text too small, a reference to a
file that is not there — is a warning. A derived box landing off the page is
*our* defect, not theirs, and belongs in the layout's own tests
(``test_slide_layout.py`` holds every golden case to the page bounds). The
coordinate checks still run on derived boxes as a backstop, but a finding
there means the layout is wrong, not the deck.
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
    SlideTableCell,
)
from langchain_canvas.slide_layout import BULLET_PREFIX, DerivedLayout, derive_layout
from langchain_canvas.slide_table import table_grid
from langchain_canvas.slide_text import (
    PAGE_H_PX,
    PAGE_W_PX,
    fit_scale,
    grown_height_pct,
    wrapped_lines,
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

# Text below this is smaller than anything the layout itself will draw (its
# body ramp bottoms out at 19px) and smaller than the deck preview can show.
# Read off a render ladder: at 13px and below a Hangul glyph loses its
# strokes at the preview's own scale; 14px still reads.
MIN_TEXT_PX = 14.0

# A derived element's id, said the way the author wrote it.
_DERIVED_FIELDS = {"title": "title", "subtitle": "subtitle", "img": "image"}
_DERIVED_LISTS = (("bul2_", "bullets2"), ("bul_", "bullets"))

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
    min_text_px: float | None = None,
    max_overhang: float = 0.0,
) -> list[str]:
    """Certain-only warnings for one deck's ``data`` dict, or ``[]``.

    ``ref_exists`` answers whether a canvas-root-relative reference (from
    ``normalize_asset_reference``) is present on the canvas; omit it to
    skip the broken-reference check (for callers without store access).
    ``min_text_px`` replaces the default readability floor — a deck copied
    from an upload is judged by the sizes its author actually used, so the
    original's footnotes pass and only text set smaller than anything in it
    is called out.
    """
    warnings: list[str] = []
    floor = MIN_TEXT_PX if min_text_px is None else min_text_px
    edge = _EDGE_TOLERANCE + max(0.0, max_overhang)
    _check_schema(data, warnings)
    _check_unknown_fields(data, warnings)
    slides = data.get("slides")
    if not isinstance(slides, list):
        return _capped(warnings)
    page = data.get("page") if isinstance(data.get("page"), dict) else None
    for number, slide in enumerate(slides, start=1):
        if not isinstance(slide, dict):
            continue
        _check_shadowed_content(slide, number, warnings)
        _check_padding(slide, number, warnings)
        own = slide.get("elements")
        own = own if isinstance(own, list) and own else None
        if own is not None:
            elements = [element for element in own if isinstance(element, dict)]
            _check_small_text(elements, number, warnings, floor)
        else:
            # A structured slide is drawn from boxes the layout derives, so
            # that is what the coordinate checks have to look at. Skipping
            # them here is how nine bullets used to run off the page in
            # silence.
            derived = _derived(slide, page)
            if derived is None:
                continue
            if derived.overfull:
                _report_overfull(slide, number, warnings)
            elements = [
                element.model_dump(by_alias=True, exclude_none=True)
                for element in derived.elements
            ]
        boxed = [(element, _box(element)) for element in elements]
        for index, (element, box) in enumerate(boxed):
            label = _label(element, index) if own is not None else _source_label(element)
            if box is None:
                continue
            x, y, w, h = box
            if w <= 0 or h <= 0:
                warnings.append(
                    f'slide {number}, element {label}: w = {_fmt(w)}, h = {_fmt(h)}'
                    " (zero or negative size renders nothing)"
                )
                continue
            _check_off_page(number, label, x, y, w, h, warnings, edge)
            _check_empty_text(element, number, label, warnings)
            _check_text_fit(element, number, label, w, h, warnings)
            _check_autofit(element, number, label, y, w, h, warnings, edge, floor)
            _check_broken_reference(element, number, label, ref_exists, warnings)
            _check_full_cover(number, index, label, box, boxed, warnings)
    return _capped(warnings)


# The keys a stored ``.slides.json`` envelope carries. The deck itself —
# ``slides``, ``page``, ``template`` — lives one level down, under ``data``.
_ENVELOPE_SHAPE = '{"type": "slides", "title": "...", "data": {"slides": [...]}}'


def blocking_deck_findings(envelope: Any, path: str = "the deck") -> list[str]:
    """Findings that stop a save, or ``[]`` when the deck may land.

    The layout warnings are advice: a footnote at 9pt or a box near the edge
    is the author's call, so they follow a save. These are not calls. A deck
    key written outside ``data`` (the export silently loses the template and
    the canvas ignores the rest), a deck that does not parse as ``SlidesData``
    (no exporter can run it), and structured text beside ``elements`` (stored
    and never drawn) each put a broken file in front of the person while the
    tool reports success. So the save is refused with the fix named, and
    nothing lands.
    """
    if not isinstance(envelope, dict):
        return [f"{path} is not a JSON object of the form {_ENVELOPE_SHAPE}"]
    findings: list[str] = []
    misplaced = [key for key in envelope if isinstance(key, str) and key in _DECK_KEYS]
    if misplaced:
        named = ", ".join(f'"{key}"' for key in misplaced)
        verb = "is" if len(misplaced) == 1 else "are"
        findings.append(
            f"{named} {verb} written at the top level, where the canvas ignores it; "
            'deck keys go inside "data" — {"type": "slides", "title": "...", '
            '"data": {"template": "sources/brand.pptx", "slides": [...]}}'
        )
    data = envelope.get("data")
    if not isinstance(data, dict):
        findings.append(f'"data" is missing or not an object; a deck is {_ENVELOPE_SHAPE}')
        return findings
    _check_schema(data, findings)
    slides = data.get("slides")
    if isinstance(slides, list):
        for number, slide in enumerate(slides, start=1):
            if isinstance(slide, dict):
                _check_shadowed_content(slide, number, findings)
    return findings


def _derived(slide: dict[str, Any], page: dict[str, Any] | None) -> DerivedLayout | None:
    """The boxes a structured slide will be drawn as, or None if it cannot parse.

    A slide the schema rejects is already reported by :func:`_check_schema`;
    deriving it would repeat that finding in different words.
    """
    try:
        model = Slide.model_validate(slide)
        page_model = SlidePage.model_validate(page) if page else None
    except ValidationError:
        return None
    except Exception:  # noqa: BLE001 - a check must never break the save
        return None
    return derive_layout(model, page_model)


def _source_label(element: dict[str, Any]) -> str:
    """A derived element named the way its author wrote it."""
    identifier = element.get("id")
    if not isinstance(identifier, str):
        return '"?"'
    field = _DERIVED_FIELDS.get(identifier)
    if field is not None:
        return f'"{field}"'
    for prefix, name in _DERIVED_LISTS:
        index = identifier.removeprefix(prefix)
        if index != identifier and index.isdigit():
            return f'"{name}[{int(index) + 1}]"'
    return f'"{identifier}"'


def _report_overfull(slide: dict[str, Any], number: int, warnings: list[str]) -> None:
    """The body did not fit at the smallest text size, so the lines overlap."""
    count = sum(
        len(slide.get(field) or [])
        for field in ("bullets", "bullets2")
        if isinstance(slide.get(field), list)
    )
    warnings.append(
        f"slide {number}: {count} bullets do not fit — the layout ran out of "
        "room at its smallest text size and had to close the lines up, so "
        "they now overlap. Split this across two slides, or shorten them."
    )


def _check_small_text(
    elements: list[dict[str, Any]],
    number: int,
    warnings: list[str],
    floor: float = MIN_TEXT_PX,
) -> None:
    """Text an author sized smaller than the slide can show.

    Grouped: a slide that sets one tiny size usually sets several, and eight
    separate lines would crowd out every other finding.
    """
    sizes = sorted(
        float(size)
        for element in elements
        if element.get("type") in ("text", "table")
        and isinstance(size := element.get("fontSize"), (int, float))
        and not isinstance(size, bool)
        and 0 < float(size) < floor
    )
    if not sizes:
        return
    listed = ", ".join(f"{_fmt(size)}px" for size in sizes)
    basis = (
        "too small to read on the canvas or a projector. The layout's own sizes "
        "are 48 / 38 / 30 / 24 / 19."
        if floor == MIN_TEXT_PX
        else f"smaller than anything the original deck uses ({_fmt(floor)}px is its smallest)."
    )
    warnings.append(
        f"slide {number}: {len(sizes)} text element(s) below {_fmt(floor)}px ({listed}) — {basis}"
    )


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
                    where = f"slide {number}, element {_label(element, index)}"
                    _collect_unknown(element, _ELEMENT_KEYS, where, found)
                    for cell in element.get("cells") or []:
                        if isinstance(cell, dict):
                            _collect_unknown(cell, _CELL_KEYS, f"{where}, cell", found)
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
_CELL_KEYS = _allowed_keys(SlideTableCell)
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
    edge: float = _EDGE_TOLERANCE,
) -> None:
    """``edge`` is how far past 0/100 a box may reach before it is a finding —
    the rounding slack alone, or that plus what the deck's own skin does."""
    findings = []
    if x < -edge:
        findings.append(f"x = {_fmt(x)}")
    if y < -edge:
        findings.append(f"y = {_fmt(y)}")
    if x + w > 100.0 + edge:
        findings.append(f"x + w = {_fmt(x + w)}")
    if y + h > 100.0 + edge:
        findings.append(f"y + h = {_fmt(y + h)}")
    if findings:
        warnings.append(
            f"slide {number}, element {label}: {', '.join(findings)} "
            "(off the page — the page runs 0 to 100)"
        )


# The text estimate lives in slide_text (shared with the exporter and, as a
# twin, the renderer); the check keeps only its own margin.
_PAGE_W_PX, _PAGE_H_PX = PAGE_W_PX, PAGE_H_PX
_FIT_SLACK = 1.25  # the box may be up to a quarter too small before we say so


def _check_text_fit(
    element: dict[str, Any],
    number: int,
    label: str,
    w: float,
    h: float,
    warnings: list[str],
) -> None:
    """Text that needs clearly more height than its box has.

    A title rewritten at the same size as before but twice as long wraps to
    a second line the box has no room for, and the canvas draws the overflow
    on top of whatever sits below — or clips it. Neither is visible in the
    JSON, and neither is caught by the page-edge check. The estimate is
    coarse (glyph widths by script, no kerning) and runs with a quarter of
    slack, so a box that is merely snug stays quiet.
    """
    if element.get("type") == "table":
        _check_table_fit(element, number, label, w, h, warnings)
        return
    if element.get("type") != "text":
        return
    text = element.get("text")
    size = element.get("fontSize")
    if not isinstance(text, str) or not text.strip():
        return
    if not isinstance(size, (int, float)) or isinstance(size, bool) or size <= 0:
        return
    # A box that grows with its text, or text that shrinks to its box, does
    # not run past anything; what those can do wrong is checked by
    # _check_autofit.
    if element.get("autofit") in ("shape", "text"):
        return
    box_w = w / 100.0 * _PAGE_W_PX
    box_h = h / 100.0 * _PAGE_H_PX
    if box_w <= 0 or box_h <= 0:
        return
    line_height = element.get("lineHeight")
    leading = (
        float(line_height)
        if isinstance(line_height, (int, float)) and line_height > 0
        else 1.2
    )
    lines = _wrapped_lines(text, float(size), box_w)
    needed = lines * float(size) * leading
    # One line in a short box is the importer's rounding or PowerPoint's own
    # autofit, not an overflow the canvas will draw wrong; the finding is for
    # text that wraps past what the box can show.
    if lines >= 2 and needed > box_h * _FIT_SLACK:
        warnings.append(
            f"slide {number}, element {label}: the text needs about {lines} line(s) "
            f"(~{_fmt(needed)}px) but the box is {_fmt(box_h)}px tall — it will run "
            "past the box. Shorten the text, lower fontSize, or make the box taller."
        )


_wrapped_lines = wrapped_lines


def _check_autofit(
    element: dict[str, Any],
    number: int,
    label: str,
    y: float,
    w: float,
    h: float,
    warnings: list[str],
    edge: float,
    floor: float,
) -> None:
    """What an autofit box can still do wrong.

    A box that grows with its text (``autofit: "shape"``) never clips, but it
    can grow past the bottom of the page. Text that shrinks to its box
    (``autofit: "text"``) never overflows, but it can shrink below what a
    projector shows. Both are as certain as the estimate behind them, and
    both are named with the number the author has to move.
    """
    fit = element.get("autofit")
    if element.get("type") != "text" or fit not in ("shape", "text"):
        return
    text = element.get("text")
    size = element.get("fontSize")
    if not isinstance(text, str) or not text.strip():
        return
    if not isinstance(size, (int, float)) or isinstance(size, bool) or size <= 0:
        return
    line_height = element.get("lineHeight")
    leading = (
        float(line_height)
        if isinstance(line_height, (int, float)) and line_height > 0
        else None
    )
    if fit == "shape":
        grown = grown_height_pct(text, float(size), w, h, leading)
        # A box that has not grown is the off-page check's to name, once.
        if grown > h and y + grown > 100.0 + edge:
            lines = wrapped_lines(text, float(size), w / 100.0 * _PAGE_W_PX)
            warnings.append(
                f"slide {number}, element {label}: the box grows with its text to about "
                f"{lines} line(s), and grown it reaches y + h = {_fmt(y + grown)} (off the "
                "page — the page runs 0 to 100). Shorten the text or move the box up."
            )
        return
    scale = fit_scale(text, float(size), w, h, leading)
    shown = float(size) * scale
    if scale < 1.0 and shown < floor:
        warnings.append(
            f"slide {number}, element {label}: the text shrinks to fit its box — about "
            f"{_fmt(shown)}px, below the {_fmt(floor)}px the deck can show. Shorten the "
            "text or make the box taller."
        )


# The cell inset PowerPoint applies (0.1in sides, 0.05in top and bottom at
# 96dpi); the canvas draws the same, so the rows the check counts are the
# rows the person sees.
_CELL_PAD_X, _CELL_PAD_Y = 9.6, 4.8
_TABLE_FONT_PX = 24.0


def _font_px(value: Any, fallback: float) -> float:
    """A positive font size in px, or ``fallback``."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return float(value)
    return fallback


def _check_table_fit(
    element: dict[str, Any],
    number: int,
    label: str,
    w: float,
    h: float,
    warnings: list[str],
) -> None:
    """A table whose rows need clearly more height than its box has.

    Rows are as tall as their tallest cell's wrapped text; a table given a
    box for four short rows and written with eight long ones runs past it
    on the canvas and in the exported file alike. Same estimate and slack
    as the text check.
    """
    grid = table_grid(element)
    if grid is None:
        return
    box_w = w / 100.0 * _PAGE_W_PX
    box_h = h / 100.0 * _PAGE_H_PX
    if box_w <= 0 or box_h <= 0:
        return
    table_size = _font_px(element.get("fontSize"), _TABLE_FONT_PX)
    row_needed = [0.0] * grid.n_rows
    for r, row in enumerate(grid.rows):
        for c, text in enumerate(row):
            if (r, c) in grid.covered:
                continue
            row_span, col_span = grid.spans.get((r, c), (1, 1))
            if row_span > 1:
                continue  # a tall merged cell spreads over rows it does not size
            own = grid.styles.get((r, c), {})
            size = _font_px(own.get("fontSize"), table_size)
            cell_w = sum(grid.col_widths[c : c + col_span]) / 100.0 * box_w - 2 * _CELL_PAD_X
            lines = _wrapped_lines(text, size, max(cell_w, size)) if text.strip() else 1
            row_needed[r] = max(row_needed[r], lines * size * 1.2 + 2 * _CELL_PAD_Y)
    needed = sum(row_needed)
    if needed > box_h * _FIT_SLACK:
        warnings.append(
            f"slide {number}, element {label}: the table's {grid.n_rows} row(s) need about "
            f"{_fmt(round(needed))}px but the box is {_fmt(box_h)}px tall — it will run past "
            "the box. Make the box taller, lower fontSize, or shorten the cells."
        )


def _check_empty_text(
    element: dict[str, Any], number: int, label: str, warnings: list[str]
) -> None:
    if element.get("type") != "text":
        return
    text = element.get("text")
    if isinstance(text, str):
        # A bare bullet marker is not content — it draws one dot and nothing
        # else, which is what an empty string in `bullets` turns into.
        text = text.strip().removeprefix(BULLET_PREFIX.strip())
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
