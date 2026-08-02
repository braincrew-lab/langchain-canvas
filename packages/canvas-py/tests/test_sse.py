"""sse_from_agent — only the agent's own voice becomes chat."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from langchain_canvas import sse_from_agent


@dataclass
class _Chunk:
    """Minimal stand-in for a streamed message chunk."""

    text: str = ""
    content: str = ""


class _FakeAgent:
    """Yields a scripted (mode, chunk) stream like `agent.astream`."""

    def __init__(self, items: list[tuple[str, Any]]) -> None:
        self._items = items

    async def astream(self, inputs: Any, *, stream_mode: Any, config: Any = None):
        for item in self._items:
            yield item


async def _events(agent: _FakeAgent) -> list[dict]:
    frames = [frame async for frame in sse_from_agent(agent, {"messages": []})]
    return [json.loads(f.split("data:", 1)[1]) for f in frames if f.startswith("data:")]


async def test_model_text_streams_and_tool_node_chunks_are_dropped() -> None:
    agent = _FakeAgent(
        [
            ("messages", (_Chunk(text="Hello"), {"langgraph_node": "model"})),
            # A writer model running inside a tool: raw output, not chat.
            ("messages", (_Chunk(text="<html>leak</html>"), {"langgraph_node": "tools"})),
            # A tool result message: also not chat.
            (
                "messages",
                (_Chunk(content="Wrote page.html (revision v1)."), {"langgraph_node": "tools"}),
            ),
            ("custom", {"type": "canvas.commit", "id": "page.html", "description": "d"}),
            ("messages", (_Chunk(text=" world"), {"langgraph_node": "model"})),
        ]
    )
    events = await _events(agent)
    deltas = [e["text"] for e in events if e["type"] == "message.delta"]
    assert deltas == ["Hello", " world"]
    assert [e["type"] for e in events if e["type"].startswith("canvas.")] == ["canvas.commit"]
    assert events[-1]["type"] == "done"


async def test_run_failure_surfaces_as_error_then_done() -> None:
    class _Boom:
        async def astream(self, inputs: Any, *, stream_mode: Any, config: Any = None):
            raise RuntimeError("model exploded")
            yield  # pragma: no cover

    events = await _events(_Boom())  # type: ignore[arg-type]
    assert [e["type"] for e in events] == ["error", "done"]
    assert "model exploded" in events[0]["message"]
