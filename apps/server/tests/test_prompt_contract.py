"""Contract tests for `SYSTEM_PROMPT`: every bound tool must be named, and
slide fixes must route through the deck tools, never read_canvas/edit_canvas.
"""

from __future__ import annotations

from app.agent.prompt import SYSTEM_PROMPT
from app.agent.tools import CANVAS_TOOLS
from app.agent.verify import VERIFY_TOOLS


def test_every_bound_tool_is_named_in_the_system_prompt() -> None:
    for bound_tool in CANVAS_TOOLS + VERIFY_TOOLS:
        assert bound_tool.name in SYSTEM_PROMPT, (
            f"{bound_tool.name} is bound to the agent but never named in SYSTEM_PROMPT"
        )


def test_system_prompt_documents_the_slide_id_form() -> None:
    assert "slide_id" in SYSTEM_PROMPT


def test_system_prompt_routes_slide_fixes_through_deck_tools() -> None:
    assert "read_deck_slide" in SYSTEM_PROMPT
    assert "edit_deck_slide" in SYSTEM_PROMPT


def test_system_prompt_documents_write_slides_batching() -> None:
    assert "write_slides" in SYSTEM_PROMPT
    assert "batches" in SYSTEM_PROMPT


def test_system_prompt_orders_write_slides_before_write_slide_only() -> None:
    assert SYSTEM_PROMPT.index("write_slides") < SYSTEM_PROMPT.index(
        "write_slide only"
    )


def test_system_prompt_names_the_four_template_tools() -> None:
    for tool_name in (
        "inspect_deck_patterns",
        "define_deck_template",
        "write_deck_from_template",
        "verify_template_deck",
    ):
        assert tool_name in SYSTEM_PROMPT


def test_system_prompt_orders_intent_priority_before_scratch_pipeline() -> None:
    """Reproduction -> editing -> new-template priority precedes the scratch
    plan_deck/write_slides pipeline guidance (plan U5's routing contract)."""
    reproduction_index = SYSTEM_PROMPT.index("Exact reproduction of the uploaded document")
    editing_index = SYSTEM_PROMPT.index("Editing or restyling content already on an existing deck")
    new_template_index = SYSTEM_PROMPT.index(
        "Reusing the source's page layout and writing style for a NEW topic"
    )
    scratch_pipeline_index = SYSTEM_PROMPT.index("For a new slide deck (presentation)")

    assert reproduction_index < editing_index < new_template_index < scratch_pipeline_index
