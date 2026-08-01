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

from langchain_canvas import Canvas
from langchain_canvas.protocol import ChartSeries, TableColumn
from langchain_canvas.store import CanvasFileNotFoundError, EditConflictError, RevisionMismatchError

from .store import (
    MANIFEST_PATH,
    PAGE_PATH,
    SLIDE_HEIGHT,
    SLIDE_META,
    SLIDE_WIDTH,
    STORE,
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
    hand; always read_page before editing it later.
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
    commit = STORE.write(thread_id(runtime), PAGE_PATH, html, description)
    page.set_html(html)
    page.complete()
    page.commit(description, revision=commit.revision)

    return (
        f"Built and saved the page (revision {commit.revision}). "
        "Click any element on the canvas to edit it."
    )


@tool
def read_page(runtime: ToolRuntime, path: str = PAGE_PATH) -> str:
    """Read a saved file's current content (line-numbered) plus its revision.

    Always call this right before edit_page — the user may have edited the file
    by hand, and edit_page needs the current revision. `path` defaults to the
    single page; pass a slide file (e.g. "01-intro.html") for decks.
    """
    try:
        got = STORE.read(thread_id(runtime), path)
    except CanvasFileNotFoundError:
        return f"No file {path} exists yet. Use build_page or plan_deck first."
    numbered = "\n".join(
        f"{i:>4}\t{line}" for i, line in enumerate(got.content.split("\n"), start=1)
    )
    return f"revision: {got.revision}\n{numbered}"


@tool
def edit_page(
    old: str,
    new: str,
    description: str,
    revision: str,
    runtime: ToolRuntime,
    path: str = PAGE_PATH,
) -> str:
    """Replace exactly one occurrence of `old` with `new` in a saved file.

    `revision` must come from your most recent read_page of the same `path` —
    if the file changed since (e.g. the user edited it by hand), the call is
    rejected and you must read again. `old` must match exactly once; include
    enough surrounding HTML to make it unique. `description` is one short
    sentence for the version history. `path` defaults to the single page; pass
    a slide file for decks.
    """
    tid = thread_id(runtime)
    try:
        commit = STORE.edit(tid, path, old, new, description, base_revision=revision)
    except (RevisionMismatchError, EditConflictError) as exc:
        return f"Error: {exc}. Call read_page again and retry with the fresh revision."
    except CanvasFileNotFoundError:
        return f"No file {path} exists yet. Use build_page or plan_deck first."
    content = STORE.read(tid, path).content
    page = Canvas.from_runtime(runtime).html(path)
    page.set_html(content)
    page.commit(description, revision=commit.revision)
    return f"Edited and saved {path} (revision {commit.revision})."


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
    commit = STORE.write(thread_id(runtime), file, html, description)
    slide.set_html(html)
    slide.complete()
    slide.commit(description, revision=commit.revision)
    return f"Wrote {file} (revision {commit.revision}). Now run check_slide_layout('{file}')."


@tool
def write_report(topic: str, runtime: ToolRuntime) -> str:
    """Write a markdown report on a topic and render it live on the canvas.

    Use this for anything long-form: reports, drafts, explanations, summaries.
    """
    canvas = Canvas.from_runtime(runtime)
    doc = canvas.open_document(title=f"Report: {topic}")

    model = init_chat_model(_WRITER_MODEL)
    prompt = f"Write a well-structured markdown report about: {topic}. Use headings and bullet points."
    for chunk in model.stream(prompt):
        doc.append(_text_of(chunk))
    doc.complete()

    return f"Drafted a report on “{topic}” — it's on the canvas."


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
    canvas = Canvas.from_runtime(runtime)
    handle = canvas.open_chart(
        title=title,
        chart=chart,
        x_key="category",
        series=[ChartSeries(key="value", label=series_label)],
    )
    rows = [{"category": c, "value": v} for c, v in zip(categories, values, strict=False)]
    handle.set_rows(rows)
    handle.complete()

    return f"Rendered a {chart} chart “{title}” on the canvas."


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
    canvas = Canvas.from_runtime(runtime)
    handle = canvas.open_table(
        title=title,
        columns=[TableColumn(key=c, label=c.replace("_", " ").title()) for c in columns],
    )
    handle.set_rows(rows)
    handle.complete()

    return f"Rendered a table “{title}” with {len(rows)} rows on the canvas."


CANVAS_TOOLS = [
    build_page,
    read_page,
    edit_page,
    plan_deck,
    write_slide,
    write_report,
    build_chart,
    build_table,
]
