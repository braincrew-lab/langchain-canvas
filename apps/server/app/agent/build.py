"""Assemble the canvas agent for the reference server."""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import InMemorySaver

from langchain_canvas import create_canvas_agent

from .tools import CANVAS_TOOLS

SYSTEM_PROMPT = (
    "You are a helpful analyst and web builder. Use build_page for landing pages, "
    "dashboards, or any visual UI; write_report for long-form writing; build_chart "
    "for trends and comparisons; build_table for tabular data. For a targeted edit of "
    "a selected element, prefer patch_element (surgical, one element); use edit_page "
    "only for large or structural page changes. Keep chat replies to a sentence or two."
)


def build_agent() -> Any:
    """Build the compiled canvas agent.

    Uses an in-memory checkpointer so a `thread_id` gives short-lived
    conversation memory. Swap in a persistent checkpointer (Postgres, Redis) for
    production and durable version history.
    """
    return create_canvas_agent(
        model="anthropic:claude-sonnet-4-5-20250929",
        tools=CANVAS_TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=InMemorySaver(),
    )
