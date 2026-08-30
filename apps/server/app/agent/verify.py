"""Slide verification tools — mechanical layout check and visual screenshot.

Rendering is delegated to ``render.py``'s single-worker, single-Chromium
adapter (the same one ``tools.py``'s ``write_slide``/``convert_slide`` use),
so this module never launches its own browser. ``check_slide_layout`` reports
mechanical problems (overflow, clipped elements, broken images, large empty
areas) as ERROR/WARNING lines the agent can fix; ``screenshot_slide`` returns
the rendered image so the agent can judge the design with its own eyes.

Both tools accept an optional ``slide_id``: without it, the whole saved file
is rendered as-is (a single HTML page, e.g. from ``build_page``). With it,
``file`` is treated as a ``.slides.html`` deck and only that one slide's body
is rendered at the deck's own aspect ratio — rendering the whole multi-
``<template>`` document as-is produces empty metrics, since browsers never
render ``<template>`` content.
"""

from __future__ import annotations

import base64
from typing import Any

from langchain.tools import ToolRuntime, tool
from langchain_canvas.deck import DeckParseError, parse_deck, read_slide
from langchain_canvas.store import CanvasFileNotFoundError

from .render import render_slide, viewport_for_ratio
from .store import DATA_DIR, SLIDE_HEIGHT, SLIDE_WIDTH, STORE
from .tools import thread_id

# The whole-file (no slide_id) path renders at the fixed 1280x720 slide
# canvas the scratch-authoring pipeline (`plan_deck`/`write_slide`) always
# uses — this ratio's viewport in `render.py` is exactly SLIDE_WIDTH x
# SLIDE_HEIGHT, so this stays byte-for-byte the historical behavior.
_WHOLE_FILE_RATIO = "16:9"


def _layout_report(file: str, m: dict[str, Any], *, width: int = SLIDE_WIDTH, height: int = SLIDE_HEIGHT) -> str:
    errors: list[str] = []
    warnings: list[str] = []
    if m["overflowX"] or m["overflowY"]:
        errors.append(
            f"content overflows the {width}x{height} slide by "
            f"{m['overflowX']}px horizontally / {m['overflowY']}px vertically — everything must fit"
        )
    for el in m["offCanvas"]:
        errors.append(f"element extends outside the slide: {el}")
    if m["brokenImages"]:
        warnings.append(f"{m['brokenImages']} image(s) failed to load — slides must be self-contained")
    if m["textLength"] < 20:
        warnings.append("almost no text content rendered")
    elif m["maxBottom"] < height * 0.55:
        warnings.append(
            f"content ends at y={round(m['maxBottom'])}px — the bottom of the slide looks empty; "
            "balance the layout or enlarge the content"
        )
    lines = [f"LAYOUT CHECK {file}: {len(errors)} error(s), {len(warnings)} warning(s)"]
    lines += [f"ERROR: {e}" for e in errors]
    lines += [f"WARNING: {w}" for w in warnings]
    if not errors and not warnings:
        lines.append("All clear.")
    return "\n".join(lines)


def _resolve_render_target(tid: str, file: str, slide_id: str | None) -> tuple[str, str]:
    """The HTML to render and the aspect ratio to render it at.

    Without ``slide_id``, the whole saved file is rendered at the fixed
    1280x720 slide canvas. With ``slide_id``, ``file`` is parsed as a
    ``.slides.html`` deck and only that slide's body is returned, at the
    deck's own ratio.
    """
    content = STORE.read(tid, file).content
    if slide_id is None:
        return content, _WHOLE_FILE_RATIO
    deck = parse_deck(content)
    slide = read_slide(content, slide_id)
    return slide.body_html, deck.ratio


@tool
def check_slide_layout(file: str, runtime: ToolRuntime, slide_id: str | None = None) -> str:
    """Render a saved slide file and report layout problems.

    For a single-page slide file, call with only `file`. For one slide of a
    `.slides.html` deck, also pass `slide_id` (from plan_deck's listing or
    list_deck_slides) — only that slide is rendered, at the deck's own aspect
    ratio, instead of the whole multi-slide document. Run this after every
    write_slide or edit of a slide. Fix every ERROR — deck slide: with
    read_deck_slide + edit_deck_slide; single page: with edit_canvas — and
    re-check until it reports 0 errors. Treat warnings as design advice.
    """
    tid = thread_id(runtime)
    try:
        html, ratio = _resolve_render_target(tid, file, slide_id)
    except CanvasFileNotFoundError:
        return f"No file {file} exists yet. Use plan_deck / write_slide first."
    except DeckParseError as exc:
        return f"Error: {file} is not a valid slide deck: {exc}"

    label = f"{file}#{slide_id}" if slide_id else file
    try:
        metrics, _ = render_slide(html, ratio=ratio)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"
    width, height = viewport_for_ratio(ratio)
    return _layout_report(label, metrics, width=width, height=height)


@tool
def screenshot_slide(file: str, runtime: ToolRuntime, slide_id: str | None = None) -> list[dict[str, Any]]:
    """Render a saved slide file and return its screenshot for visual review.

    For a single-page slide file, call with only `file`. For one slide of a
    `.slides.html` deck, also pass `slide_id` to render just that slide at
    the deck's own aspect ratio. Use after check_slide_layout passes, to
    confirm the slide actually looks good: readable text, balanced
    composition, consistent style with the rest of the deck. If it looks
    wrong, fix it — deck slide: read_deck_slide + edit_deck_slide; single
    page: edit_canvas.
    """
    tid = thread_id(runtime)
    try:
        html, ratio = _resolve_render_target(tid, file, slide_id)
    except CanvasFileNotFoundError:
        return [{"type": "text", "text": f"No file {file} exists yet."}]
    except DeckParseError as exc:
        return [{"type": "text", "text": f"Error: {file} is not a valid slide deck: {exc}"}]

    label = f"{file}#{slide_id}" if slide_id else file
    try:
        _, png = render_slide(html, ratio=ratio)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return [{"type": "text", "text": f"Error: {exc}"}]

    shots_dir = DATA_DIR / tid / "screenshots"
    shots_dir.mkdir(parents=True, exist_ok=True)
    safe_name = label.replace("#", "__")
    (shots_dir / f"{safe_name}.png").write_bytes(png)

    width, height = viewport_for_ratio(ratio)
    return [
        {"type": "text", "text": f"Screenshot of {label} ({width}x{height}):"},
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.b64encode(png).decode("ascii"),
            },
        },
    ]


VERIFY_TOOLS = [check_slide_layout, screenshot_slide]
