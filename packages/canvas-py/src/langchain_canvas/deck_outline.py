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
from collections import Counter
from typing import Any

from langchain_canvas.protocol.artifacts import Slide, SlideElement

from .replay import display_title

#: Elements named per slide before the line folds the rest into a count.
MAX_ELEMENTS_PER_SLIDE = 14
_TEXT_HEAD = 36


def _style_lines(slides: list[dict[str, Any]]) -> list[str]:
    """The deck's tone, counted: colours, faces and sizes with usage counts.

    Two lines the model reads before touching anything — a new element that
    picks from these lists lands in the deck's own voice instead of adding a
    ninth colour nobody chose. Counts come from every place a colour lives
    (text, fills, strokes, table cells, slide backgrounds).
    """
    colours: Counter[str] = Counter()
    faces: Counter[str] = Counter()
    sizes: Counter[float] = Counter()
    for slide in slides:
        background = slide.get("background")
        if isinstance(background, str) and background.startswith("#"):
            colours[background.upper()] += 1
        for element in slide.get("elements") or []:
            if not isinstance(element, dict):
                continue
            for key in ("color", "fill", "stroke", "highlight"):
                value = element.get(key)
                if isinstance(value, str) and value.startswith("#"):
                    colours[value.upper()] += 1
            face = element.get("fontFamily")
            if isinstance(face, str) and face:
                faces[face] += 1
            size = element.get("fontSize")
            if isinstance(size, (int, float)) and not isinstance(size, bool) and size > 0:
                sizes[round(float(size), 1)] += 1
            for cell in element.get("cells") or []:
                if isinstance(cell, dict):
                    for key in ("color", "fill"):
                        value = cell.get(key)
                        if isinstance(value, str) and value.startswith("#"):
                            colours[value.upper()] += 1
    lines: list[str] = []
    if colours:
        shown = " ".join(f"{c}×{n}" for c, n in colours.most_common(6))
        extra = len(colours) - 6
        lines.append(f"colors: {shown}" + (f" (+{extra} more)" if extra > 0 else ""))
    ramp = "/".join(f"{s:g}" for s in sorted(sizes)[:10]) if sizes else ""
    face_part = " ".join(f"{f}×{n}" for f, n in faces.most_common(3))
    if ramp or face_part:
        joined = " · ".join(part for part in (
            f"fonts: {face_part}" if face_part else "", f"sizes: {ramp}" if ramp else ""
        ) if part)
        lines.append(joined)
    return lines


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
        fit = element.get("autofit")
        fit_note = " grows" if fit == "shape" else " shrinks" if fit == "text" else ""
        return f"{ident} text{size_note}{fit_note} {box}{shown}"
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
    lines.extend(_style_lines(slides))
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
        "that element's text (a table's text is its rows); keep its fontSize and box unless asked. "
        "`grows` marks a box that takes its text's height; `shrinks` one whose type fits the box."
    )
    return "\n".join(lines)


def deck_projection(content: str, fields: str) -> str:
    """One compact line per element, showing only the requested keys.

    ``fields`` is comma-separated element keys (camelCase, as stored) plus
    slide-level keys; keys an element does not carry are simply left off its
    line. Unknown names are named back with the full vocabulary — a model
    that asks for "colour" learns "color" from the reply instead of assuming
    the capability is missing.
    """
    try:
        envelope = json.loads(content)
    except ValueError:
        return "Error: not a readable deck."
    data = envelope.get("data") if isinstance(envelope, dict) else None
    slides = [s for s in ((data or {}).get("slides") or []) if isinstance(s, dict)]
    wanted = [f.strip() for f in fields.split(",") if f.strip()]
    element_keys = set(SlideElement.model_json_schema(by_alias=True)["properties"])
    slide_keys = set(Slide.model_json_schema(by_alias=True)["properties"]) - {"elements"}
    unknown = [f for f in wanted if f not in element_keys and f not in slide_keys]
    lines: list[str] = []
    if unknown:
        lines.append(
            "unknown field(s) " + ", ".join(unknown) + " — element keys: "
            + ", ".join(sorted(element_keys)) + "; slide keys: " + ", ".join(sorted(slide_keys))
        )
    valid = [f for f in wanted if f not in unknown]
    if not valid:
        return "\n".join(lines) if lines else "Error: no fields given."
    lines.append(f"projection: {', '.join(valid)} — {len(slides)} slide(s)")
    for number, slide in enumerate(slides, start=1):
        slide_bits = [
            f"{key}={_shown(slide.get(key))}"
            for key in valid
            if key in slide_keys and slide.get(key) is not None
        ]
        if slide_bits:
            lines.append(f"[s{number}] " + " ".join(slide_bits))
        for index, element in enumerate(slide.get("elements") or []):
            if not isinstance(element, dict):
                continue
            bits = [
                f"{key}={_shown(element.get(key))}"
                for key in valid
                if key in element_keys and element.get(key) is not None
            ]
            if bits:
                ident = element.get("id", f"#{index}")
                lines.append(f"[s{number}] {ident} " + " ".join(bits))
    return "\n".join(lines)


def _shown(value: Any) -> str:
    """A field value on one projection line: short, and honest about shape."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return f"{value:g}"
    if isinstance(value, str):
        return f'"{_head(value)}"' if (" " in value or len(value) > 24) else value
    if isinstance(value, list):
        return f"[{len(value)}]"
    if isinstance(value, dict):
        return "{…}"
    return str(value)
