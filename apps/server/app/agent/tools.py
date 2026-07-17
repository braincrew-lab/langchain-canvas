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

from langchain_canvas import Canvas
from langchain_canvas.protocol import ChartSeries, TableColumn

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


@tool
def build_page(brief: str, runtime: ToolRuntime) -> str:
    """Design a self-contained HTML page from a brief and render it on the canvas.

    Use for landing pages, dashboards, or any visual/interactive UI. The rendered
    page is directly editable — the user can click any element to request changes.
    """
    canvas = Canvas.from_runtime(runtime)
    page = canvas.open_html(title=brief[:60])

    model = init_chat_model(_WRITER_MODEL)
    prompt = (
        "Create a single self-contained HTML document (inline <style>, no external "
        f"resources or scripts) for: {brief}. Return ONLY the HTML."
    )
    page.set_html(_strip_code_fence(_text_of(model.invoke(prompt))))
    page.complete()

    return f"Built a page for “{brief}”. Click any element on the canvas to edit it."


@tool
def edit_page(artifact_id: str, updated_html: str, runtime: ToolRuntime) -> str:
    """Replace an existing page's whole HTML (for large or structural edits).

    Args:
        artifact_id: The id of the page artifact to update (given in the edit request).
        updated_html: The full updated HTML document.
    """
    canvas = Canvas.from_runtime(runtime)
    canvas.html(artifact_id).set_html(_strip_code_fence(updated_html)).complete()
    return "Updated the page on the canvas."


@tool
def patch_element(artifact_id: str, cid: str, html: str, runtime: ToolRuntime) -> str:
    """Replace a SINGLE element (by data-cid) in a page — a surgical, O(1) edit.

    Prefer this over edit_page for targeted element edits: it swaps just the one
    element instead of resending the whole page.

    Args:
        artifact_id: The page artifact id (given in the edit request).
        cid: The data-cid of the element to replace (given in the edit request).
        html: The new outer HTML for that element.
    """
    canvas = Canvas.from_runtime(runtime)
    canvas.html(artifact_id).patch_node(cid, _strip_code_fence(html))
    return "Applied a targeted edit on the canvas."


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


CANVAS_TOOLS = [build_page, edit_page, patch_element, write_report, build_chart, build_table]
