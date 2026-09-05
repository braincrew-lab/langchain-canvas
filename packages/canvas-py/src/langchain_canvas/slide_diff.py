"""What one deck save changed, element by element.

``_changed_slides`` (in :mod:`langchain_canvas.tools`) already tells the model
*which* slides a save touched; this says *what* on them changed, in the same
words a person would use — a shape that only moved reads as "moved", not
"removed and re-added". It rides a deck save the way :mod:`langchain_canvas.
layout_lint` does, so the model sees the edit it just made and can catch an
unintended one on the next turn.

The diff runs on the wire ``data`` dict (camelCase, the shape the store holds),
never on parsed models — a draft that fails validation must still diff. Slides
are matched by position (index), elements by their stable ``id`` (the deck's
reconciliation key). Anything undecidable from the JSON is left unsaid; like
the deck check, a wrong line is worse than a missing one.
"""

from __future__ import annotations

from typing import Any

__all__ = ["diff_slides", "format_slide_diff"]

#: Element fields that read as "style" — everything that is neither geometry
#: (x/y/w/h/rotation), the text itself, nor the element's identity/type. Kept in
#: a stable order so a restyle line reads the same way every time.
_STYLE_FIELDS: tuple[str, ...] = (
    "fontSize", "bold", "color", "align", "shape", "fill", "stroke", "strokeWidth",
    "fontFamily", "lineHeight", "verticalAlign", "highlight", "spaceBefore",
    "spaceAfter", "autofit", "wrap", "header", "colWidths", "rowHeights", "cells", "rows",
)

#: Slide-level fields whose change is worth a line, with the label to show.
_SLIDE_FIELDS: tuple[tuple[str, str], ...] = (
    ("layout", "layout"), ("title", "title"), ("subtitle", "subtitle"),
    ("bullets", "bullets"), ("bullets2", "second column"), ("image", "image"),
    ("background", "background"), ("textColor", "text colour"), ("notes", "notes"),
    ("padding", "padding"),
)

#: Two coordinates this close are the same box to a reader; below it the
#: difference is float noise from a re-projection, not an edit.
_EPS = 0.05


def _num(value: Any) -> str:
    """A number without its trailing zeros: ``12.0`` -> ``12``, ``12.50`` -> ``12.5``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return str(value)
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return text or "0"


def _same_number(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(float(a) - float(b)) < _EPS
    return a == b


def _pair(field: str, a: Any, b: Any) -> str:
    """``"x 10→25"`` for one changed field."""
    return f"{field} {_num(a)}→{_num(b)}"


def _short(value: Any, width: int = 24) -> str:
    """A one-line, length-capped preview of a text value for the diff line."""
    text = " ".join(str(value).split())
    return text if len(text) <= width else text[: width - 1] + "…"


def _element_changes(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """The phrases describing how one element changed, e.g. ``["moved (x 10→25)"]``."""
    phrases: list[str] = []

    moved = [_pair(axis, old.get(axis, 0), new.get(axis, 0))
             for axis in ("x", "y") if not _same_number(old.get(axis, 0), new.get(axis, 0))]
    if moved:
        phrases.append(f"moved ({', '.join(moved)})")

    resized = [_pair(dim, old.get(dim, 0), new.get(dim, 0))
               for dim in ("w", "h") if not _same_number(old.get(dim, 0), new.get(dim, 0))]
    if resized:
        phrases.append(f"resized ({', '.join(resized)})")

    if not _same_number(old.get("rotation", 0) or 0, new.get("rotation", 0) or 0):
        turned = _pair('deg', old.get('rotation', 0) or 0, new.get('rotation', 0) or 0)
        phrases.append(f"rotated ({turned.removeprefix('deg ')})")

    if old.get("text") != new.get("text"):
        before, after = old.get("text"), new.get("text")
        if not before:
            phrases.append("text added")
        elif not after:
            phrases.append("text cleared")
        else:
            phrases.append(f'text "{_short(before)}"→"{_short(after)}"')

    restyled = [_pair(field, old.get(field), new.get(field))
                for field in _STYLE_FIELDS
                if _style_changed(field, old.get(field), new.get(field))]
    if restyled:
        # cells/rows/colWidths are lists; naming the field is enough, the
        # before→after of a whole grid would bury the line.
        readable = [
            phrase if "→" in phrase and len(phrase) <= 40
            else phrase.split(" ", 1)[0] + " changed"
            for phrase in restyled
        ]
        phrases.append(f"restyled ({', '.join(dict.fromkeys(readable))})")

    return phrases


def _style_changed(field: str, a: Any, b: Any) -> bool:
    if field in ("fontSize", "strokeWidth", "lineHeight", "spaceBefore", "spaceAfter"):
        return a != b and not _same_number(a, b)
    return a != b


def _slide_changes(index: int, old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """Every change on one slide, each already prefixed with its slide number."""
    prefix = f"slide {index}"
    lines: list[str] = []

    for field, label in _SLIDE_FIELDS:
        before, after = old.get(field), new.get(field)
        if before == after:
            continue
        if isinstance(before, list) or isinstance(after, list):
            lines.append(f"{prefix}: {label} changed")
        elif not before:
            lines.append(f"{prefix}: {label} added")
        elif not after:
            lines.append(f"{prefix}: {label} cleared")
        else:
            lines.append(f'{prefix}: {label} "{_short(before)}"→"{_short(after)}"')

    lines.extend(_element_diff(prefix, old.get("elements") or [], new.get("elements") or []))
    return lines


def _element_diff(prefix: str, old_els: list[Any], new_els: list[Any]) -> list[str]:
    """Added / removed / changed / reordered elements, matched by ``id``."""
    old_by_id = {
        el["id"]: (i, el) for i, el in enumerate(old_els) if isinstance(el, dict) and "id" in el
    }
    new_by_id = {
        el["id"]: (i, el) for i, el in enumerate(new_els) if isinstance(el, dict) and "id" in el
    }
    lines: list[str] = []

    for el_id, (_, el) in new_by_id.items():
        if el_id not in old_by_id:
            lines.append(f'{prefix}, element "{el_id}" ({el.get("type", "?")}): added')
    for el_id, (_, el) in old_by_id.items():
        if el_id not in new_by_id:
            lines.append(f'{prefix}, element "{el_id}" ({el.get("type", "?")}): removed')

    for el_id, (old_index, old_el) in old_by_id.items():
        found = new_by_id.get(el_id)
        if found is None:
            continue
        new_index, new_el = found
        phrases = _element_changes(old_el, new_el)
        # Reorder only counts when the element's rank among the *surviving*
        # elements moved — an add or remove elsewhere shifts raw indices
        # without anyone having reordered this one.
        if old_index != new_index and _rank(el_id, old_by_id, new_by_id) != 0:
            a, b = _rank_positions(el_id, old_by_id, new_by_id)
            phrases.append(f"reordered (z {a}→{b})")
        if phrases:
            kind = new_el.get("type", "?")
            lines.append(f'{prefix}, element "{el_id}" ({kind}): {"; ".join(phrases)}')

    return lines


def _rank(el_id: str, old_by_id: dict, new_by_id: dict) -> int:
    a, b = _rank_positions(el_id, old_by_id, new_by_id)
    return b - a


def _rank_positions(el_id: str, old_by_id: dict, new_by_id: dict) -> tuple[int, int]:
    """1-based draw order of ``el_id`` among the elements common to both saves.

    Ranking over the shared set (not raw indices) means an add or remove
    elsewhere on the slide does not read as this element being reordered.
    """
    common = old_by_id.keys() & new_by_id.keys()
    old_order = sorted(common, key=lambda k: old_by_id[k][0])
    new_order = sorted(common, key=lambda k: new_by_id[k][0])
    return old_order.index(el_id) + 1, new_order.index(el_id) + 1


def _page_change(old: dict[str, Any], new: dict[str, Any]) -> str | None:
    old_page, new_page = old.get("page"), new.get("page")
    if old_page == new_page:
        return None

    def describe(page: Any) -> str:
        if not isinstance(page, dict):
            return "16:9 (default)"
        width, height = page.get("widthIn"), page.get("heightIn")
        numeric = isinstance(width, (int, float)) and isinstance(height, (int, float))
        shape = "portrait" if numeric and height > width else "landscape"
        return f"{_num(width)}x{_num(height)} in ({shape})"

    return f"page: {describe(old_page)} → {describe(new_page)}"


def diff_slides(old: Any, new: Any) -> list[str]:
    """A human-readable list of what changed between two deck ``data`` dicts.

    ``old`` / ``new`` are the wire ``data`` (each with a ``slides`` list and an
    optional ``page``). Returns ``[]`` when nothing decidable changed, or when
    either side is unreadable — a diff is a bonus on a save, never its gate.
    """
    if not isinstance(old, dict) or not isinstance(new, dict):
        return []
    old_slides = old.get("slides")
    new_slides = new.get("slides")
    if not isinstance(old_slides, list) or not isinstance(new_slides, list):
        return []

    lines: list[str] = []
    page_line = _page_change(old, new)
    if page_line:
        lines.append(page_line)

    for index in range(max(len(old_slides), len(new_slides))):
        number = index + 1
        before = old_slides[index] if index < len(old_slides) else None
        after = new_slides[index] if index < len(new_slides) else None
        if before is None:
            count = len(after.get("elements") or []) if isinstance(after, dict) else 0
            lines.append(f"slide {number}: added" + (f" ({count} elements)" if count else ""))
        elif after is None:
            lines.append(f"slide {number}: removed")
        elif isinstance(before, dict) and isinstance(after, dict):
            lines.extend(_slide_changes(number, before, after))

    return lines


def format_slide_diff(changes: list[str]) -> str:
    """The diff lines under one heading, or ``''`` when there is nothing to say.

    Mirrors :func:`langchain_canvas.layout_lint.format_layout_warnings` so a
    deck save's notes read as one voice.
    """
    if not changes:
        return ""
    body = "\n".join(f"- {line}" for line in changes)
    return f"Changed since last save:\n{body}"
