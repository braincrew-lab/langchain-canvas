"""The ``canvas.commit`` wire event, emitted through a handle."""

from __future__ import annotations

from typing import Any

from langchain_canvas import Canvas


def test_handle_commit_emits_wire_event() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    page = canvas.open_html(title="Coffee history")

    page.set_html("<h1>Hi</h1>")
    page.commit("Create page", revision="v1")

    commit = next(e for e in events if e["type"] == "canvas.commit")
    assert commit == {
        "type": "canvas.commit",
        "id": page.id,
        "description": "Create page",
        "revision": "v1",
    }


def test_commit_without_revision_omits_the_field() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    doc = canvas.open_document(title="Notes")
    doc.commit("Manual edit: 1 change")

    commit = next(e for e in events if e["type"] == "canvas.commit")
    assert "revision" not in commit  # exclude_none keeps the wire lean
    assert commit["description"] == "Manual edit: 1 change"
