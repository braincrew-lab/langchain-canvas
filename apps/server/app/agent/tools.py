"""Example canvas-emitting tools.

These show the two core patterns:

* ``write_report`` streams a markdown document token-by-token into the canvas
  (the ``open_document(...).append(...)`` fast-path).
* ``build_chart`` opens a chart and fills its rows in one shot (the ``patch``
  path — the same call could be made repeatedly to stream data in).

A tool only ever talks to ``Canvas``; it never sees the wire protocol.
"""

from __future__ import annotations

from langchain.chat_models import init_chat_model
from langchain.tools import ToolRuntime, tool

import json
import re

from langchain_canvas import (
    Canvas,
    create_canvas_tools,
    create_export_tool,
    encode_chart,
    encode_table,
)
from langchain_canvas.protocol import ChartSeries, TableColumn
from langchain_canvas.replay import CHART_SUFFIX, DOCUMENT_SUFFIX, TABLE_SUFFIX

from .store import (
    MANIFEST_PATH,
    PAGE_PATH,
    SLIDE_HEIGHT,
    SLIDE_META,
    SLIDE_WIDTH,
    STORE,
    artifact_path,
    slide_path,
)

_WRITER_MODEL = "anthropic:claude-sonnet-4-5-20250929"


def _text_of(chunk: object) -> str:
    content = getattr(chunk, "content", "")
    return content if isinstance(content, str) else ""


def _strip_code_fence(text: str) -> str:
    """Drop a leading ```html / trailing ``` fence if the model wrapped its output."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1]
        if stripped.endswith("```"):
            stripped = stripped[: stripped.rfind("```")]
    return stripped.strip()


def thread_id(runtime: ToolRuntime) -> str:
    """The demo scopes one canvas per conversation thread."""
    configurable = (runtime.config or {}).get("configurable", {})
    thread_id = configurable.get("thread_id")
    if not thread_id:
        raise ValueError("no thread_id in run config")
    return str(thread_id)


@tool
def build_page(brief: str, runtime: ToolRuntime) -> str:
    """Design a self-contained HTML page from a brief and render it on the canvas.

    Use for landing pages, dashboards, or any visual/interactive UI. The page is
    saved to the canvas store (it survives reloads) and the user can edit it by
    hand; always read_canvas before editing it later.
    """
    canvas = Canvas.from_runtime(runtime)
    page = canvas.open_html(title=brief[:60], id=PAGE_PATH)

    model = init_chat_model(_WRITER_MODEL)
    prompt = (
        "Create a single self-contained HTML document (inline <style>, no external "
        f"resources or scripts) for: {brief}. Return ONLY the HTML."
    )
    html = _strip_code_fence(_text_of(model.invoke(prompt)))
    description = f"Create page: {brief[:50]}"
    commit = STORE.write(thread_id(runtime), PAGE_PATH, html, description, actor="agent")
    page.set_html(html)
    page.complete()
    page.commit(description, revision=commit.revision)

    return (
        f"Built and saved the page (revision {commit.revision}). "
        "Click any element on the canvas to edit it."
    )


# The deck's shared design language. Every slide prompt embeds this so the deck
# looks like one designed artifact, not N unrelated pages.
DECK_STYLE = f"""The slide is a fixed {SLIDE_WIDTH}x{SLIDE_HEIGHT} canvas. Hard rules:
- <body> is exactly {SLIDE_WIDTH}x{SLIDE_HEIGHT} px (margin 0, overflow hidden). Everything must fit — no scrolling, nothing clipped.
- Generous margins: at least 64px of padding on every side. Leave breathing room; do not fill every pixel.
- Typography: a large display serif for the headline (Georgia, 'Times New Roman', serif) and a clean sans-serif for body text ('Helvetica Neue', Arial, sans-serif). Strong size contrast: headline 56-88px, body 20-26px.
- One accent color, used sparingly and consistently (kicker label, rules, highlights) on a calm near-white or near-black background. The whole deck shares one palette.
- Structure per slide: a small uppercase kicker label, one strong headline, then at most 3-4 supporting points OR one focused visual block. Less is more.
- Self-contained: inline <style> only. No external resources, no scripts, no network images. Use CSS (gradients, borders, simple shapes) for visual interest.
- Return ONLY the HTML document."""


@tool
def plan_deck(title: str, slide_titles: list[str], runtime: ToolRuntime) -> str:
    """Start a slide deck: save its manifest (title + one file per slide).

    Call this once before writing slides. It assigns each slide a file name
    (01-....html, 02-....html, ...) and saves manifest.json. Then call
    write_slide for each file, in order.
    """
    slides = [
        {"file": slide_path(i, slide_title), "title": slide_title}
        for i, slide_title in enumerate(slide_titles, start=1)
    ]
    manifest = {"title": title, "slides": slides}
    commit = STORE.write(
        thread_id(runtime),
        MANIFEST_PATH,
        json.dumps(manifest, ensure_ascii=False, indent=2),
        f"Plan deck: {title} ({len(slides)} slides)",
        actor="agent",
    )
    listing = "\n".join(f"- {s['file']}: {s['title']}" for s in slides)
    return f"Deck planned (revision {commit.revision}). Write these slides in order:\n{listing}"


@tool
def write_slide(file: str, title: str, brief: str, runtime: ToolRuntime) -> str:
    """Write one slide of the deck as a self-contained HTML file and show it.

    `file` must be a file name from plan_deck. `brief` is what the slide should
    say — include the key content, and note it is slide N of M so the design
    fits its role (cover, content, closing). After writing, run
    check_slide_layout on the file and fix any problems before moving on.
    """
    canvas = Canvas.from_runtime(runtime)
    slide = canvas.open_html(title=title, id=file, meta=SLIDE_META)

    model = init_chat_model(_WRITER_MODEL)
    prompt = f"Create one presentation slide as a single HTML document.\n\n{DECK_STYLE}\n\nSlide content: {brief}"
    html = _strip_code_fence(_text_of(model.invoke(prompt)))
    description = f"Write slide: {title[:50]}"
    commit = STORE.write(thread_id(runtime), file, html, description, actor="agent")
    slide.set_html(html)
    slide.complete()
    slide.commit(description, revision=commit.revision)
    return f"Wrote {file} (revision {commit.revision}). Now run check_slide_layout('{file}')."


@tool
def write_report(topic: str, runtime: ToolRuntime) -> str:
    """Write a markdown report on a topic and render it live on the canvas.

    Use this for anything long-form: reports, drafts, explanations, summaries.
    """
    path = artifact_path(topic, DOCUMENT_SUFFIX)
    canvas = Canvas.from_runtime(runtime)
    doc = canvas.open_document(title=f"Report: {topic}", id=path)

    model = init_chat_model(_WRITER_MODEL)
    prompt = f"Write a well-structured markdown report about: {topic}. Use headings and bullet points."
    chunks: list[str] = []
    for chunk in model.stream(prompt):
        text = _text_of(chunk)
        chunks.append(text)
        doc.append(text)
    doc.complete()

    description = f"Write report: {topic[:50]}"
    commit = STORE.write(thread_id(runtime), path, "".join(chunks), description, actor="agent")
    doc.commit(description, revision=commit.revision)
    return f"Drafted a report on “{topic}” — saved as {path} (revision {commit.revision})."


@tool
def build_chart(
    title: str,
    categories: list[str],
    values: list[float],
    runtime: ToolRuntime,
    series_label: str = "Value",
    chart: str = "bar",
) -> str:
    """Render a chart on the canvas from category/value pairs.

    Args:
        title: Chart title.
        categories: X-axis category labels.
        values: One numeric value per category.
        series_label: Legend label for the plotted series.
        chart: One of "bar", "line", "area", "pie".
    """
    path = artifact_path(title, CHART_SUFFIX)
    canvas = Canvas.from_runtime(runtime)
    handle = canvas.open_chart(
        title=title,
        chart=chart,
        x_key="category",
        series=[ChartSeries(key="value", label=series_label)],
        id=path,
    )
    rows = [{"category": c, "value": v} for c, v in zip(categories, values, strict=False)]
    handle.set_rows(rows)
    handle.complete()

    data = {
        "chart": chart,
        "xKey": "category",
        "series": [{"key": "value", "label": series_label}],
        "rows": rows,
    }
    description = f"Build chart: {title[:50]}"
    commit = STORE.write(thread_id(runtime), path, encode_chart(title, data), description, actor="agent")
    handle.commit(description, revision=commit.revision)
    return f"Rendered a {chart} chart “{title}” — saved as {path} (revision {commit.revision})."


@tool
def build_table(
    title: str,
    columns: list[str],
    rows: list[dict],
    runtime: ToolRuntime,
) -> str:
    """Render a data table on the canvas.

    Args:
        title: Table title.
        columns: Column keys, in display order.
        rows: One dict per row, keyed by column.
    """
    path = artifact_path(title, TABLE_SUFFIX)
    norm_columns = [{"key": c, "label": c.replace("_", " ").title()} for c in columns]
    canvas = Canvas.from_runtime(runtime)
    handle = canvas.open_table(
        title=title,
        columns=[TableColumn(**col) for col in norm_columns],
        id=path,
    )
    handle.set_rows(rows)
    handle.complete()

    description = f"Build table: {title[:50]}"
    commit = STORE.write(
        thread_id(runtime),
        path,
        encode_table(title, {"columns": norm_columns, "rows": rows}),
        description,
        actor="agent",
    )
    handle.commit(description, revision=commit.revision)
    return f"Rendered a table “{title}” with {len(rows)} rows — saved as {path} (revision {commit.revision})."


def _slide_meta_for(path: str) -> dict | None:
    # Deck slide files follow the NN-slug.html naming from slide_path().
    return SLIDE_META if re.fullmatch(r"\d{2}-.+\.html", path) else None


# Domain tools (LLM-assisted authoring) plus the SDK's standard canvas tools
# (read/write/edit_canvas + list_canvas_files) — the reference server runs on
# the same primitives it ships, so a break in them shows up here first.
CANVAS_TOOLS = [
    build_page,
    *create_canvas_tools(STORE, meta_for=_slide_meta_for),
    create_export_tool(STORE),
    plan_deck,
    write_slide,
    write_report,
    build_chart,
    build_table,
]
