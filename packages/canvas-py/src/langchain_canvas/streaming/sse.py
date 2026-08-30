"""Bridge a LangChain agent run to a Canvas Wire Protocol SSE stream.

The agent exposes two streams we care about, and we interleave them onto one
wire in arrival order:

* ``stream_mode="messages"`` -> assistant token chunks -> ``message.delta`` events,
  plus tool lifecycle -> ``tool.start`` (first chunk carrying a given tool call id)
  and ``tool.end`` (the matching ``ToolMessage`` chunk).
* ``stream_mode="custom"``   -> whatever tools wrote via ``runtime.stream_writer``.
  Because the emitter already writes *wire-shaped* canvas events, custom payloads
  pass straight through.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from ..protocol.events import DoneEvent, ErrorEvent, MessageDelta, ToolEnd, ToolStart


def _delta_text(message: Any) -> str:
    """Extract the plain-text delta from a streamed message chunk, if any.

    Handles both the string-content providers and the block-content providers
    (where `.content` is a list of typed blocks). Returns "" for chunks that
    carry only tool-call args or metadata — those are skipped.
    """
    text = getattr(message, "text", None)
    if isinstance(text, str) and text:
        return text

    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


async def sse_from_agent(
    agent: Any,
    inputs: dict[str, Any],
    *,
    config: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """Yield SSE frames (``"data: {...}\\n\\n"``) for one agent run.

    Args:
        agent: A compiled agent from ``create_canvas_agent``.
        inputs: The agent input, e.g. ``{"messages": [{"role": "user", ...}]}``.
        config: Optional LangGraph config (``configurable.thread_id`` for memory).
    """
    started_tool_call_ids: set[str] = set()

    try:
        async for mode, chunk in agent.astream(
            inputs,
            stream_mode=["messages", "custom"],
            config=config,
        ):
            if mode == "messages":
                message, meta = chunk

                tool_call_id = getattr(message, "tool_call_id", None)
                if isinstance(tool_call_id, str):
                    # A ToolMessage chunk carrying the executed tool's result.
                    status = getattr(message, "status", None)
                    yield ToolEnd(tool_call_id=tool_call_id, ok=status != "error").to_sse()
                    continue

                for call in getattr(message, "tool_call_chunks", None) or []:
                    call_id = call.get("id") if isinstance(call, dict) else None
                    call_name = call.get("name") if isinstance(call, dict) else None
                    if (
                        isinstance(call_id, str)
                        and isinstance(call_name, str)
                        and call_id not in started_tool_call_ids
                    ):
                        started_tool_call_ids.add(call_id)
                        yield ToolStart(tool_call_id=call_id, name=call_name).to_sse()

                # Only the agent's own voice is chat. Chunks from the tools
                # node are tool results and tool-internal model calls (e.g. a
                # writer model inside a tool) — relaying them would dump raw
                # tool output into the transcript.
                if isinstance(meta, dict) and meta.get("langgraph_node") == "tools":
                    continue
                text = _delta_text(message)
                if text:
                    message_id = getattr(message, "id", None) or "assistant"
                    yield MessageDelta(message_id=message_id, text=text).to_sse()

            elif mode == "custom":
                # Already a wire-shaped canvas event dict from the emitter.
                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

    except Exception as exc:  # surface run failures to the client, then close cleanly
        yield ErrorEvent(message=str(exc)).to_sse()
    finally:
        yield DoneEvent().to_sse()
