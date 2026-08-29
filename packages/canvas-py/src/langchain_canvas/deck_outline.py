"""A deck as addressed lines — the map a model reads before it opens the JSON.

A six-slide deck copied from an upload is 850 lines of JSON; a model given
the first 400 saw three slides and left the placeholder on slide five
untouched, and one that read every line still could not tell that a title
had grown past its box. The outline is one line per slide: every element
with its id, kind, size and the head of its text, so the whole deck fits on
a screen and an id points at the JSON below it.
"""

from __future__ import annotations

import json
from typing import Any

from .replay import display_title

#: Elements named per slide before the line folds the rest into a count.
MAX_ELEMENTS_PER_SLIDE = 14
_TEXT_HEAD = 36


def _head(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= _TEXT_HEAD else flat[: _TEXT_HEAD - 1] + "…"


def _element_line(element: dict[str, Any]) -> str:
    kind = element.get("type", "?")
    ident = element.get("id", "?")
    w, h = element.get("w"), element.get("h")
    sized = isinstance(w, (int, float)) and isinstance(h, (int, float))
    box = f"{w:.0f}x{h:.0f}" if sized else "?"
    if kind == "text":
        size = element.get("fontSize")
        size_note = f" {size:g}px" if isinstance(size, (int, float)) else ""
        text = element.get("text")
        shown = f' "{_head(text)}"' if isinstance(text, str) and text.strip() else " (empty)"
        return f"{ident} text{size_note} {box}{shown}"
    if kind == "table":
        rows = element.get("rows")
        if isinstance(rows, list) and rows and isinstance(rows[0], list):
            first = " | ".join(str(v) for v in rows[0] if str(v).strip())
            return f'{ident} table {len(rows)}x{len(rows[0])} {box} "{_head(first)}"'
        return f"{ident} table {box} (no rows)"
    if kind == "image":
        src = element.get("src")
        where = src if isinstance(src, str) and not src.startswith("data:") else "inline"
        return f"{ident} image {box} {where}"
    shape = element.get("shape", "shape")
    return f"{ident} {shape} {box}"


def deck_outline(content: str) -> str | None:
    """The map of a ``.slides.json`` deck, or ``None`` when it is not one."""
    try:
        envelope = json.loads(content)
    except ValueError:
        return None
    if not isinstance(envelope, dict) or envelope.get("type") != "slides":
        return None
    data = envelope.get("data")
    if not isinstance(data, dict):
        return None
    slides = [s for s in (data.get("slides") or []) if isinstance(s, dict)]
    title = envelope.get("title")
    name = title if isinstance(title, str) and title else display_title("deck")
    head = f"deck: {name} — {len(slides)} slide(s)"
    template = data.get("template")
    if isinstance(template, str):
        head += f", template {template}"
    lines = [head]
    for number, slide in enumerate(slides, start=1):
        elements = [e for e in (slide.get("elements") or []) if isinstance(e, dict)]
        if elements:
            shown = " · ".join(_element_line(e) for e in elements[:MAX_ELEMENTS_PER_SLIDE])
            hidden = len(elements) - MAX_ELEMENTS_PER_SLIDE
            more = f" · +{hidden} more" if hidden > 0 else ""
            lines.append(f"[s{number}] {len(elements)} elements: {shown}{more}")
            continue
        parts = []
        layout = slide.get("layout")
        if isinstance(layout, str):
            parts.append(f"layout {layout}")
        for field in ("title", "subtitle"):
            value = slide.get(field)
            if isinstance(value, str) and value.strip():
                parts.append(f'{field} "{_head(value)}"')
        for field in ("bullets", "bullets2"):
            value = slide.get(field)
            if isinstance(value, list) and value:
                parts.append(f"{len(value)} {field}")
        lines.append(f"[s{number}] structured: {', '.join(parts) if parts else 'empty'}")
    lines.append(
        "Each id above is the element's \"id\" in the JSON below — search for it to edit "
        "that element's text (a table's text is its rows); keep its fontSize and box unless asked."
    )
    return "\n".join(lines)
