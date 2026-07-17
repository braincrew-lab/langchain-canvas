"""Bridge a LangChain agent run to a Canvas Wire Protocol SSE stream.

The agent exposes two streams we care about, and we interleave them onto one
wire in arrival order:

* ``stream_mode="messages"`` -> assistant token chunks -> ``message.delta`` events.
* ``stream_mode="custom"``   -> whatever tools wrote via ``runtime.stream_writer``.
  Because the emitter already writes *wire-shaped* canvas events, custom payloads
  pass straight through.

Tool lifecycle (``tool.start`` / ``tool.end``) is intentionally not emitted here
to keep the reference bridge small; add ``"updates"`` to ``stream_mode`` and map
node transitions if you want it (the protocol already defines those events).
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from ..protocol.events import DoneEvent, ErrorEvent, MessageDelta


def _delta_text(message: Any) -> str:
    """Extract the plain-text delta from a streamed message chunk, if any.

    Handles both the string-content providers and the block-content providers
    (where `.content` is a list of typed blocks). Returns "" for chunks that
    carry only tool-call args or metadata — those are skipped.
    """
    text = getattr(message, "text", None)
    if callable(text):  # older LangChain exposed `.text()` as a method
        text = text()
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
    try:
        async for mode, chunk in agent.astream(
            inputs,
            stream_mode=["messages", "custom"],
            config=config,
        ):
            if mode == "messages":
                message, _meta = chunk
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
