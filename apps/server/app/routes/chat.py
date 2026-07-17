"""The chat endpoint — streams the Canvas Wire Protocol over SSE."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from langchain_canvas import sse_from_agent

from ..agent.build import build_agent

router = APIRouter()

# One compiled agent for the process; per-request state is keyed by thread_id.
_agent = build_agent()


class Selection(BaseModel):
    """The element the user selected in an html artifact (camelCase on the wire)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    artifact_id: str
    cid: str
    selector: str
    tag: str
    text: str | None = None
    outer_html: str | None = None


class ChatRequest(BaseModel):
    thread_id: str
    message: str
    selections: list[Selection] = []


def _with_selections(message: str, selections: list[Selection]) -> str:
    """Frame a targeted edit so the agent changes only the selected element(s)."""
    listed = "\n".join(f"- `{s.selector}` (data-cid={s.cid})" for s in selections)
    artifact_id = selections[0].artifact_id
    return (
        f"{message}\n\n"
        f"[Targeted edit] Apply the change to these selected element(s) in artifact "
        f"`{artifact_id}`:\n{listed}\n"
        f"For each, call patch_element with artifact_id `{artifact_id}`, the element's cid, "
        f"and the new outer HTML for just that element (keep its data-cid attribute)."
    )


@router.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    message = request.message
    if request.selections:
        message = _with_selections(message, request.selections)

    inputs = {"messages": [{"role": "user", "content": message}]}
    config = {"configurable": {"thread_id": request.thread_id}}

    return StreamingResponse(
        sse_from_agent(_agent, inputs, config=config),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable proxy buffering (nginx)
        },
    )
