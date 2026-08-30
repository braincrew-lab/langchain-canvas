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
