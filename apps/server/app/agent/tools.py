"""Example canvas-emitting tools.

These show the two core patterns:

* ``write_report`` streams a markdown document token-by-token into the canvas
  (the ``open_document(...).append(...)`` fast-path).
* ``build_chart`` opens a chart and fills its rows in one shot (the ``patch``
  path — the same call could be made repeatedly to stream data in).

A tool only ever talks to ``Canvas``; it never sees the wire protocol.
"""

from __future__ import annotations

import html as html_lib
from pathlib import Path

from langchain.chat_models import init_chat_model
from langchain.tools import ToolRuntime, tool
from langchain_canvas import (
    Canvas,
    create_asset_tool,
    create_canvas_tools,
    create_check_table_tool,
    create_deck_tools,
    create_export_tool,
    encode_chart,
    encode_table,
    formula_guidance,
)
from langchain_canvas.converters import UnsafeArchiveError
from langchain_canvas.deck import (
    Deck,
    DeckParseError,
    SlideTemplate,
    TextIntegrityError,
    baseline_slide_html,
    ensure_text_equality,
    extract_slides,
    extracted_text,
    parse_deck,
    read_slide,
    serialize_deck,
)
from langchain_canvas.protocol import ChartSeries, TableColumn
from langchain_canvas.protocol.events import SlideStatus
from langchain_canvas.replay import (
    CHART_SUFFIX,
    DOCUMENT_SUFFIX,
    TABLE_SUFFIX,
    events_for_commit,
)
from langchain_canvas.store import CanvasFileNotFoundError, CanvasStoreError

from .configuration import config
from .render import render_slide
from .store import (
    DECK_PATH,
    DECK_RATIO,
    PAGE_PATH,
    SLIDE_HEIGHT,
    SLIDE_WIDTH,
    STORE,
    artifact_path,
)

# The SDK's slide-granular deck tools (open/read/edit/list) — convert_slide
# and write_slide reuse `edit_deck_slide`'s sanitize -> validate -> patch ->
# write(base_revision=...) -> broadcast pipeline directly (via `.func`,
# passing through the same `runtime`) instead of re-implementing it, so a
# fix to that pipeline in the SDK is not silently missed here.
_DECK_TOOLS = create_deck_tools(STORE)
_DECK_TOOLS_BY_NAME = {t.name: t for t in _DECK_TOOLS}
_edit_deck_slide = _DECK_TOOLS_BY_NAME["edit_deck_slide"]


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
    try:
        tid = thread_id(runtime)
        canvas = Canvas.from_runtime(runtime)
        page = canvas.open_html(title=brief[:60], id=PAGE_PATH)

        model = init_chat_model(config.writer_model)
        prompt = (
            "Create a single self-contained HTML document (inline <style>, no external "
            f"resources or scripts) for: {brief}. Return ONLY the HTML."
        )
        html = _strip_code_fence(_text_of(model.invoke(prompt)))
        description = f"Create page: {brief[:50]}"
        commit = STORE.write(tid, PAGE_PATH, html, description, actor="agent")
        page.set_html(html)
        page.complete()
        page.commit(description, revision=commit.revision)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"

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


def _template_fragment(slide_id: str, title: str | None, body_html: str) -> str:
    """The ``<template data-slide-id="...">...</template>`` fragment
    ``edit_deck_slide`` expects for `template_html`.

    Mirrors the SDK's own slide serialization format (`deck.model`'s private
    `_serialize_slide`) — `edit_deck_slide` re-parses this through
    `parse_deck`, so exact byte-for-byte parity is not required, only a
    well-formed single `<template data-slide-id=...>` fragment.
    """
    attrs = f' data-slide-id="{html_lib.escape(slide_id, quote=True)}"'
    if title:
        attrs += f' data-slide-title="{html_lib.escape(title, quote=True)}"'
    return f"<template{attrs}>\n{body_html}\n</template>"


def _emit_slide_status(runtime: ToolRuntime, path: str, slide_id: str, stage: str) -> None:
    writer = getattr(runtime, "stream_writer", None)
    if writer is None:
        return
    writer(
        SlideStatus(id=path, slide_id=slide_id, stage=stage).model_dump(
            by_alias=True, exclude_none=True
        )
    )


@tool
def plan_deck(title: str, slide_titles: list[str], runtime: ToolRuntime) -> str:
    """Start a slide deck: create an empty canonical deck with one slide per title.

    Call this once before writing slides. Creates `deck.slides.html` with
    `len(slide_titles)` empty slides, ids `slide-001`, `slide-002`, ... in
    order. Then call write_slide for each slide id, in order.
    """
    try:
        tid = thread_id(runtime)
        if any(info.path == DECK_PATH for info in STORE.list_files(tid)):
            return (
                f"Error: {DECK_PATH} already exists on this canvas. Edit it with "
                "read_deck_slide/edit_deck_slide, or export it before starting a new one."
            )
        slides = [
            SlideTemplate(
                slide_id=f"slide-{i:03d}",
                title=slide_title,
                style_css="",
                body_html='<section class="slide"></section>',
            )
            for i, slide_title in enumerate(slide_titles, start=1)
        ]
        content = serialize_deck(Deck(title=title, ratio=DECK_RATIO, source=None, slides=slides))
        description = f"Plan deck: {title} ({len(slides)} slides)"
        commit = STORE.write(tid, DECK_PATH, content, description, actor="agent")

        writer = getattr(runtime, "stream_writer", None)
        if writer is not None:
            for event in events_for_commit(
                DECK_PATH, content, is_new=True, revision=commit.revision, description=description
            ):
                writer(event)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"

    listing = "\n".join(f"- {s.slide_id}: {s.title}" for s in slides)
    return (
        f"Deck planned at {DECK_PATH} (revision {commit.revision}). "
        f"Write these slides in order:\n{listing}"
    )


@tool
def write_slide(path: str, slide_id: str, title: str, brief: str, runtime: ToolRuntime) -> str:
    """Write one slide of the deck as canonical slide HTML and check its layout.

    `path` and `slide_id` come from plan_deck's listing (or list_deck_slides
    for a deck already on the canvas). `brief` is what the slide should say —
    include the key content, and note it is slide N of M so the design fits
    its role (cover, content, closing). Fix any ERROR the layout check below
    reports with read_deck_slide + edit_deck_slide before moving on.
    """
    try:
        tid = thread_id(runtime)
    except ValueError as exc:
        return f"Error: {exc}"
    try:
        got = STORE.read(tid, path)
    except CanvasFileNotFoundError:
        return f"No deck {path} exists yet. Call plan_deck first."
    except CanvasStoreError as exc:
        return f"Error: {exc}."
    try:
        deck = parse_deck(got.content)
    except DeckParseError as exc:
        return f"Error: {exc}."

    try:
        model = init_chat_model(config.writer_model)
        prompt = (
            "Create one presentation slide's markup as a single "
            '<section class="slide">...</section> fragment — no <html>/<body>/'
            f"<style> wrapper.\n\n{DECK_STYLE}\n\nSlide content: {brief}"
        )
        body_html = _strip_code_fence(_text_of(model.invoke(prompt)))
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"
    fragment = _template_fragment(slide_id, title, body_html)

    result = _edit_deck_slide.func(
        path=path, slide_id=slide_id, template_html=fragment, revision=got.revision, runtime=runtime
    )
    if result.startswith("Error:"):
        return result

    try:
        slide = read_slide(STORE.read(tid, path).content, slide_id)
    except (DeckParseError, CanvasStoreError) as exc:
        return f"{result}\n(layout check skipped: {exc})"
    try:
        metrics, _ = render_slide(slide.body_html, ratio=deck.ratio)
        report = _slide_layout_report(f"{path}#{slide_id}", metrics)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"{result}\n(layout check skipped: {exc})"
    return f"{result}\n{report}"


@tool
def convert_slide(path: str, slide_id: str, runtime: ToolRuntime) -> str:
    """Convert one imported deck slide from its raw extracted layout into a
    polished slide, verifying the result once it lands.

    Re-extracts the deck's source `.pptx`, rebuilds `slide_id`'s baseline
    markup, and asks the writer model to improve it in one shot: reposition,
    restyle, and rebalance the layout, but never add, remove, or reword any
    of the extracted text. If the model's revision fails that check, the
    slide's current (baseline) content is left untouched and reported
    degraded — call convert_slide again to retry; it always re-corrects from
    the same baseline, so repeated calls are idempotent. On success the
    slide is saved (edit_deck_slide) and checked once for layout problems.
    """
    try:
        tid = thread_id(runtime)
    except ValueError as exc:
        return f"Error: {exc}"
    try:
        got = STORE.read(tid, path)
    except CanvasFileNotFoundError:
        return f"No deck {path} exists yet. Use open_deck_for_editing first."
    except CanvasStoreError as exc:
        return f"Error: {exc}."

    try:
        deck = parse_deck(got.content)
    except DeckParseError as exc:
        return f"Error: {exc}."
    if not deck.source:
        return f"Error: {path} has no source .pptx — convert_slide only applies to imported decks."

    index = next((i for i, s in enumerate(deck.slides) if s.slide_id == slide_id), None)
    if index is None:
        return f"Error: {path} has no slide {slide_id!r}."

    try:
        source_bytes = STORE.read_bytes(tid, deck.source).data
    except CanvasFileNotFoundError as exc:
        return f"Error: {exc}."
    except CanvasStoreError as exc:
        return f"Error: {exc}."

    try:
        extractions = extract_slides(source_bytes, path=deck.source)
    except UnsafeArchiveError as exc:
        return f"Error: {exc}."
    if index >= len(extractions):
        return f"Error: {deck.source} no longer has a slide matching {slide_id!r}."
    extraction = extractions[index]

    baseline_html = baseline_slide_html(extraction, slide_id=slide_id, ratio=deck.ratio)
    baseline_texts = extracted_text(extraction)

    try:
        model = init_chat_model(config.writer_model)
        prompt = (
            "Improve this presentation slide's layout — reposition, restyle, and "
            "rebalance the boxes below — without adding, removing, or rewording "
            f"any of its text.\n\n{DECK_STYLE}\n\nBaseline markup:\n{baseline_html}\n\n"
            'Return ONLY the corrected <section class="slide">...</section> markup.'
        )
        corrected_html = _strip_code_fence(_text_of(model.invoke(prompt)))
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"

    try:
        ensure_text_equality(baseline_texts, corrected_html)
    except TextIntegrityError:
        _emit_slide_status(runtime, path, slide_id, "degraded")
        return (
            f"Slide {slide_id} is degraded: the model's revision dropped or reworded "
            "extracted text, so it was rejected and the slide's current content was kept. "
            "Call convert_slide again to retry."
        )

    fragment = _template_fragment(slide_id, deck.slides[index].title, corrected_html)
    result = _edit_deck_slide.func(
        path=path, slide_id=slide_id, template_html=fragment, revision=got.revision, runtime=runtime
    )
    if result.startswith("Error:"):
        return result

    try:
        metrics, _ = render_slide(corrected_html, ratio=deck.ratio)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"
    report = _slide_layout_report(f"{path}#{slide_id}", metrics)
    return f"{result}\n{report}"


def _slide_layout_report(label: str, metrics: dict) -> str:
    # Deferred import: verify.py imports `thread_id` from this module at its
    # own module scope, so importing verify.py back at this module's top
    # level would be circular. By call time both modules are already fully
    # loaded (build.py imports both), so this import is a cheap cache hit.
    from .verify import _layout_report

    return _layout_report(label, metrics)


@tool
def write_report(topic: str, runtime: ToolRuntime) -> str:
    """Write a markdown report on a topic and render it live on the canvas.

    Use this for anything long-form: reports, drafts, explanations, summaries.
    """
    try:
        tid = thread_id(runtime)
        path = artifact_path(topic, DOCUMENT_SUFFIX)
        canvas = Canvas.from_runtime(runtime)
        doc = canvas.open_document(title=f"Report: {topic}", id=path)

        model = init_chat_model(config.writer_model)
        prompt = f"Write a well-structured markdown report about: {topic}. Use headings and bullet points."
        chunks: list[str] = []
        for chunk in model.stream(prompt):
            text = _text_of(chunk)
            chunks.append(text)
            doc.append(text)
        doc.complete()

        description = f"Write report: {topic[:50]}"
        commit = STORE.write(tid, path, "".join(chunks), description, actor="agent")
        doc.commit(description, revision=commit.revision)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"
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
    try:
        tid = thread_id(runtime)
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
        commit = STORE.write(tid, path, encode_chart(title, data), description, actor="agent")
        handle.commit(description, revision=commit.revision)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"
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
    try:
        tid = thread_id(runtime)
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
            tid,
            path,
            encode_table(title, {"columns": norm_columns, "rows": rows}),
            description,
            actor="agent",
        )
        handle.commit(description, revision=commit.revision)
    except Exception as exc:  # noqa: BLE001 - tool boundary: never let a raise abort the run
        return f"Error: {exc}"
    return f"Rendered a table “{title}” with {len(rows)} rows — saved as {path} (revision {commit.revision})."


# The formula contract comes from the same constant the engine tests cover,
# so this promise cannot drift from what actually evaluates.
build_table.description += "\n\n" + formula_guidance()


# The check_table evaluator: the formula CLI built next to the client's
# formula modules (pnpm build in packages/canvas-react) — same engine, same
# registered functions, so the check matches what the canvas displays.
_FORMULA_CLI = (
    Path(__file__).resolve().parents[4]  # repo root
    / "packages"
    / "canvas-react"
    / "dist"
    / "formula-cli.js"
)

# Domain tools (LLM-assisted authoring) plus the SDK's standard canvas tools
# (read/write/edit_canvas + list_canvas_files) — the reference server runs on
# the same primitives it ships, so a break in them shows up here first.
CANVAS_TOOLS = [
    build_page,
    *create_canvas_tools(STORE),
    *_DECK_TOOLS,
    create_asset_tool(STORE),
    create_export_tool(STORE),
    create_check_table_tool(
        STORE, evaluator=("node", str(_FORMULA_CLI)) if _FORMULA_CLI.exists() else None
    ),
    plan_deck,
    write_slide,
    convert_slide,
    write_report,
    build_chart,
    build_table,
]
