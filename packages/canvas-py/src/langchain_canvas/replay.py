"""Replay a canvas's stored history as wire events.

A client that reloads mid-conversation has an empty canvas; the server answers
its hydrate request by replaying the store's commit log as the same wire
events a live run would have produced (create → status → patch → commit).
:func:`hydrate_events` is that replay, shared by every server that persists
through a :class:`~langchain_canvas.store.CanvasStore`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .protocol import Artifact, CanvasCommit, CanvasCreate, CanvasPatch, CanvasStatus
from .store import CanvasStore


def hydrate_events(
    store: CanvasStore,
    canvas_id: str,
    *,
    title_for: Callable[[str], str] | None = None,
    meta_for: Callable[[str], dict[str, Any] | None] | None = None,
) -> list[dict]:
    """Wire events reconstructing a canvas from its history, oldest commit first.

    Every ``.html`` file in the commit log becomes a ``canvas.create`` (first
    appearance, followed by a ``complete`` status) or a ``canvas.patch``
    (later appearances), and each commit emits its ``canvas.commit`` so the
    client rebuilds the version history too.

    ``title_for`` maps a file path to a display title (default: the path);
    ``meta_for`` maps a file path to renderer hints for its artifact
    (default: none). Both let the host app apply its own conventions — for
    example titling slide files from a deck manifest.
    """
    events: list[dict] = []
    seen: set[str] = set()
    for commit in reversed(store.history(canvas_id)):  # oldest first
        for path in commit.paths:
            if not path.endswith(".html"):
                continue
            content = store.read(canvas_id, path, revision=commit.revision).content
            if path not in seen:
                seen.add(path)
                events.append(
                    CanvasCreate(
                        artifact=Artifact(
                            id=path,
                            type="html",
                            title=title_for(path) if title_for else path,
                            data={"html": content},
                            meta=meta_for(path) if meta_for else None,
                        )
                    ).model_dump(by_alias=True, exclude_none=True)
                )
                events.append(
                    CanvasStatus(id=path, status="complete").model_dump(
                        by_alias=True, exclude_none=True
                    )
                )
            else:
                events.append(
                    CanvasPatch(id=path, patch={"html": content}).model_dump(
                        by_alias=True, exclude_none=True
                    )
                )
            events.append(
                CanvasCommit(
                    id=path, description=commit.description, revision=commit.revision
                ).model_dump(by_alias=True, exclude_none=True)
            )
    return events
