"""`create_canvas_agent` — a thin wrapper over LangChain's `create_agent`.

It adds nothing to the agent's *runtime* behaviour (the canvas is driven purely
by tools calling `Canvas`); its only job is to append guidance that teaches the
model *when* to reach for a canvas-emitting tool instead of answering in prose.
Everything `create_agent` accepts is forwarded verbatim.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from langchain.agents import create_agent

CANVAS_GUIDANCE = """
You can render rich artifacts on a side canvas by calling the appropriate tools
(documents, slide decks, charts, and so on). Prefer the canvas over long inline
answers when the user asks for something substantial or visual:

- Reports, drafts, essays, structured explanations -> a document artifact.
- Slides, decks, presentations, anything with pages -> a slides artifact.
- Comparisons, trends, distributions, anything numeric -> a chart artifact.
- Long tables, sheets, row-by-row data -> a table artifact.

A short answer, a question, or a quick lookup stays in the chat. The canvas is
for something the user will open again.

Keep your chat reply short — a one or two sentence summary that points at the
canvas. Do not paste the full artifact contents back into the chat.

If the canvas tools (read_canvas / write_canvas / edit_canvas / list_canvas_files)
are available, the canvas is persistent and the user may edit it by hand:
always read_canvas a file right before editing it, and prefer a targeted
edit_canvas over rewriting a whole file.

Images already on the canvas (the user's uploads under sources/, assets under
assets/) embed by relative path: `<img src="sources/photo.png">` in an .html
page, `![photo](sources/photo.png)` in a document, `src: "assets/logo.png"`
on a slide image element. They display live and exports inline the bytes.
Use the path exactly as list_canvas_files shows it — never invent one, and
never prefix `../`, even from a file inside a folder.

Uploaded office files are revised through a copy, never rewritten from
scratch — the copy carries the original's formatting, so changing the words
keeps the look:
- PowerPoint (sources/*.pptx): open_deck_for_editing makes <name>.slides.json;
  change its text with edit_canvas (a table's text is its `rows`), then
  export_canvas to pptx.
- Word (sources/*.docx): open_document_for_editing makes an editable copy;
  read it, then edit_canvas with an anchor copied from the read — put the
  address in front ("[p7] title") when the same words appear twice.
- Excel (sources/*.xlsx): the canvas already holds <name>.table.json, the
  editable working copy; read it with sheet="s0", then change cells with
  write_table_cells. Use the sandbox to analyse or chart data; use the canvas
  for the file the person keeps and edits. Never rebuild an uploaded table
  with write_canvas — that drops its formatting and formulas.

The canvas holds what the person asked for. Do not write notes, plans, or
scratch files there (no notes.md, no "getting started" page) — every file
becomes a tab the person has to look past.
""".strip()


def create_canvas_agent(
    model: str | Any,
    tools: Sequence[Callable[..., Any] | Any] | None = None,
    *,
    system_prompt: str | None = None,
    **kwargs: Any,
) -> Any:
    """Build a canvas-aware agent.

    Args:
        model: A provider-prefixed model string (e.g. ``"anthropic:claude-..."``)
            or an initialized ``BaseChatModel``.
        tools: Canvas-emitting (and ordinary) tools the agent may call.
        system_prompt: Your domain instructions. Canvas guidance is appended.
        **kwargs: Forwarded to ``create_agent`` (``middleware``, ``checkpointer``,
            ``response_format``, ``store``, ...).

    Returns:
        A compiled LangGraph agent; stream it with ``langchain_canvas.sse_from_agent``.
    """
    prompt = CANVAS_GUIDANCE if not system_prompt else f"{system_prompt}\n\n{CANVAS_GUIDANCE}"
    return create_agent(
        model=model,
        tools=list(tools or []),
        system_prompt=prompt,
        **kwargs,
    )
