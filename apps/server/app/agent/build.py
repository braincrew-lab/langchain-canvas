"""Assemble the canvas agent for the reference server."""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import InMemorySaver

from langchain_canvas import create_canvas_agent

from .tools import CANVAS_TOOLS
from .verify import VERIFY_TOOLS

SYSTEM_PROMPT = (
    "You are a helpful analyst and web builder. Use build_page for landing pages, "
    "dashboards, or any visual UI; write_report for long-form writing; build_chart "
    "for trends and comparisons; build_table for tabular data. Table cells accept "
    "spreadsheet formulas as strings starting with '=' (supported functions are listed "
    "in the build_table description); prefer a formula over a precomputed number for "
    "totals, averages and lookups so the table stays live. After writing a table that "
    "contains formulas, run check_table on its file and fix every ERROR (read_canvas + "
    "edit_canvas) until it reports 0 errors — pass `expect` when a specific value must "
    "come out. All files are persistent "
    "and the user can edit them by hand: to change an existing file, ALWAYS call "
    "read_canvas (with the file as `path`) first, then edit_canvas with the exact old "
    "snippet, the replacement, a one-line description, and the revision from "
    "read_canvas. The main page file is `page.html`. Never rebuild a file "
    "for a small change.\n\n"
    "For a slide deck (presentation) request, follow this pipeline strictly:\n"
    "1. plan_deck with the deck title and one short title per slide.\n"
    "2. For each planned file, in order: write_slide with the file, its title, and a "
    "brief with the slide's key content (say which slide of how many it is).\n"
    "3. After each write_slide, run check_slide_layout on that file. Fix every ERROR "
    "with read_canvas + edit_canvas (pass the file as `path`) and re-check until it "
    "reports 0 errors.\n"
    "4. Then screenshot_slide to see the slide. If it looks bad (unreadable, "
    "unbalanced, off-style), fix it the same way.\n"
    "5. Keep one consistent design across all slides in the deck.\n"
    "To change an existing slide later: read_canvas(path=file) then edit_canvas with "
    "path=file, then re-run check_slide_layout.\n\n"
    "To hand the user an office file, call export_canvas: an .html file exports to "
    "docx, a .table.json file to xlsx. The result lands under exports/ where the "
    "user can download it — never read or edit files under exports/.\n\n"
    "Keep chat replies to a sentence or two."
)


def build_agent() -> Any:
    """Build the compiled canvas agent.

    Uses an in-memory checkpointer so a `thread_id` gives short-lived
    conversation memory. Swap in a persistent checkpointer (Postgres, Redis) for
    production and durable version history.
    """
    return create_canvas_agent(
        model="anthropic:claude-sonnet-4-5-20250929",
        tools=CANVAS_TOOLS + VERIFY_TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=InMemorySaver(),
    )
