"""Canvas Wire Protocol v1 — event envelopes.

Mirror of `packages/canvas-react/src/protocol/events.ts`. Every object streamed
to the client is one of these, discriminated by `type`. See `docs/02-protocol.md`
for the full specification.

Two families travel on the same wire:

* **chat** (`message.*`, `tool.*`)  — drives the conversation transcript.
* **canvas** (`canvas.*`)           — drives the canvas panel.

Plus a small **control** family (`error`, `done`).

These models are the *only* place the wire shape is defined on the backend. The
emitter builds them; the SSE bridge serializes them with `to_sse()`.
"""

from __future__ import annotations

import json
from typing import Any, Literal, Union

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from .artifacts import Artifact, ArtifactStatus


class _Event(BaseModel):
    """Base for every wire event.

    Fields are declared in idiomatic snake_case but serialized to camelCase
    (`message_id` -> `messageId`) so the wire matches the TypeScript contract.
    `to_sse()` renders one SSE `data:` frame.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def to_sse(self) -> str:
        payload = self.model_dump(by_alias=True, exclude_none=True)
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


# --- chat family ----------------------------------------------------------------


class MessageDelta(_Event):
    type: Literal["message.delta"] = "message.delta"
    message_id: str
    text: str


class MessageEnd(_Event):
    type: Literal["message.end"] = "message.end"
    message_id: str


class ToolStart(_Event):
    type: Literal["tool.start"] = "tool.start"
    tool_call_id: str
    name: str


class ToolEnd(_Event):
    type: Literal["tool.end"] = "tool.end"
    tool_call_id: str
    ok: bool = True


# --- canvas family --------------------------------------------------------------


class CanvasCreate(_Event):
    type: Literal["canvas.create"] = "canvas.create"
    artifact: Artifact


class CanvasAppend(_Event):
    """Append `text` to the string at `data.<path>` (e.g. a document body)."""

    type: Literal["canvas.append"] = "canvas.append"
    id: str
    path: str
    text: str


class CanvasPatch(_Event):
    """JSON-merge-patch (RFC 7386) `patch` into the artifact's `data`."""

    type: Literal["canvas.patch"] = "canvas.patch"
    id: str
    patch: dict[str, Any]


class CanvasNodePatch(_Event):
    """Replace one element (by its `data-cid` path) in an html artifact.

    An O(1) surgical edit: the client resolves `cid` against the source HTML and
    swaps that element's outer HTML for `html`, instead of resending the page.
    """

    type: Literal["canvas.node_patch"] = "canvas.node_patch"
    id: str
    cid: str
    html: str


class CanvasReplace(_Event):
    """Replace the artifact wholesale — the client snapshots a new version."""

    type: Literal["canvas.replace"] = "canvas.replace"
    id: str
    artifact: Artifact


class CanvasStatus(_Event):
    type: Literal["canvas.status"] = "canvas.status"
    id: str
    status: ArtifactStatus


class CanvasClose(_Event):
    type: Literal["canvas.close"] = "canvas.close"
    id: str


# --- control family -------------------------------------------------------------


class ErrorEvent(_Event):
    type: Literal["error"] = "error"
    message: str


class DoneEvent(_Event):
    type: Literal["done"] = "done"


CanvasEvent = Union[
    CanvasCreate,
    CanvasAppend,
    CanvasPatch,
    CanvasNodePatch,
    CanvasReplace,
    CanvasStatus,
    CanvasClose,
]

StreamEvent = Union[
    MessageDelta,
    MessageEnd,
    ToolStart,
    ToolEnd,
    CanvasEvent,
    ErrorEvent,
    DoneEvent,
]
