"""The chat endpoint — streams the Canvas Wire Protocol over SSE."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from langchain_canvas import sse_from_agent

from ..agent.schema import ChatRequest, Selection

router = APIRouter()


def get_agent(request: Request) -> Any:
    """The process-wide compiled agent built by `main.py`'s lifespan."""
    return request.app.state.agent


def _with_selections(message: str, selections: list[Selection]) -> str:
    """Frame a targeted edit so the agent changes only the selected element(s)."""
    listed = "\n".join(f"- `{s.selector}` (data-cid={s.cid})" for s in selections)
    artifact_id = selections[0].artifact_id
    return (
        f"{message}\n\n"
        f"[Targeted edit] Apply the change to these selected element(s) in artifact "
        f"`{artifact_id}`:\n{listed}\n"
        f"First call read_canvas with `path=\"{artifact_id}\"` to get the current content "
        f"and revision, then call edit_canvas with the element's exact current outer HTML "
        f"as `old` and your replacement as `new` (keep the data-cid attribute), "
        f"plus a one-line description."
    )


@router.post("/api/chat")
async def chat(
    request: ChatRequest, agent: Any = Depends(get_agent)  # noqa: B008 — FastAPI DI idiom
) -> StreamingResponse:
    message = request.message
    if request.selections:
        message = _with_selections(message, request.selections)

    inputs = {"messages": [{"role": "user", "content": message}]}
    config = {"configurable": {"thread_id": request.thread_id}}

    return StreamingResponse(
        sse_from_agent(agent, inputs, config=config),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable proxy buffering (nginx)
        },
    )
