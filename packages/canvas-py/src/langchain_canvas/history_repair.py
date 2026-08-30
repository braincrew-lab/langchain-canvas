"""Repair message histories with orphaned tool calls.

When a run is interrupted after the model emitted tool calls but before the
tool node wrote its results (user stop, tool exception, process restart), the
checkpointed thread keeps an ``AIMessage`` whose ``tool_calls`` have no
matching ``ToolMessage``. Anthropic rejects every later request on that thread
with ``tool_use ids were found without tool_result blocks immediately after``.

``repair_orphaned_tool_calls`` inserts a synthetic error ``ToolMessage`` for
each unanswered call, directly after its ``AIMessage``, so the transcript is
valid again and the model knows the earlier call never ran.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from langchain.agents.middleware import ModelRequest, ModelResponse, wrap_model_call
from langchain_core.messages import AIMessage, AnyMessage, ToolMessage

INTERRUPTED_RESULT = (
    "Tool call was interrupted before it produced a result; call it again if still needed."
)


def repair_orphaned_tool_calls(messages: Sequence[AnyMessage]) -> list[AnyMessage]:
    """Return ``messages`` with a ``ToolMessage`` filled in for every unanswered tool call.

    The input is never mutated; when nothing is missing the same list is returned.
    """
    repaired: list[AnyMessage] = []
    changed = False
    index = 0
    while index < len(messages):
        message = messages[index]
        repaired.append(message)
        index += 1
        if not isinstance(message, AIMessage) or not message.tool_calls:
            continue
        # Keep the results that did arrive, then fill in the ones that did not.
        answered: set[str] = set()
        while index < len(messages) and isinstance(messages[index], ToolMessage):
            result = messages[index]
            answered.add(str(result.tool_call_id))
            repaired.append(result)
            index += 1
        for call in message.tool_calls:
            call_id = call.get("id")
            if call_id and call_id not in answered:
                repaired.append(
                    ToolMessage(
                        content=INTERRUPTED_RESULT,
                        tool_call_id=call_id,
                        name=call.get("name"),
                        status="error",
                    )
                )
                changed = True
    return repaired if changed else list(messages)


@wrap_model_call
def repair_tool_history(
    request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]
) -> ModelResponse:
    """Middleware: hand the model a transcript with no orphaned tool calls."""
    return handler(request.override(messages=repair_orphaned_tool_calls(request.messages)))
