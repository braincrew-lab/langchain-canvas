"""Request/response models for the chat route.

Moved out of ``routes/chat.py`` so the route module only wires the request
into the agent and the streaming response — see ``routes/chat.py``.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


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
    """One chat turn: the thread to run in, the user's message, and any
    selected canvas elements to target the edit at."""

    thread_id: str = Field(min_length=1)
    message: str = Field(min_length=1)
    selections: list[Selection] = []
