"""Tests for the standard canvas tools.

Tools are invoked directly (LangChain tools accept an injected ``runtime``
kwarg), with a minimal stand-in runtime — no model, no graph. The important
contracts: canvas-id resolution, line-numbered reads exposing the revision,
and edit_canvas rejecting stale or ambiguous edits with a retry hint instead
of raising.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from langchain_canvas import InMemoryCanvasStore, create_canvas_tools


@dataclass
class _Runtime:
    """The slice of ToolRuntime the canvas tools read."""

    context: Any = None
    config: dict[str, Any] = field(default_factory=dict)


def _runtime(canvas_id: str | None = None, thread_id: str | None = None) -> _Runtime:
    configurable: dict[str, Any] = {}
    if canvas_id:
        configurable["canvas_id"] = canvas_id
    if thread_id:
        configurable["thread_id"] = thread_id
    return _Runtime(config={"configurable": configurable})


def _tools(store: InMemoryCanvasStore) -> dict[str, Any]:
    return {t.name: t for t in create_canvas_tools(store)}


def _invoke(tool_obj: Any, runtime: _Runtime, **kwargs: Any) -> str:
    return tool_obj.func(runtime=runtime, **kwargs)


# --- canvas id resolution --------------------------------------------------------


def test_thread_id_is_the_default_canvas_scope() -> None:
    store = InMemoryCanvasStore()
    tools = _tools(store)
    runtime = _runtime(thread_id="t1")
    _invoke(tools["write_canvas"], runtime, path="a.html", content="x", description="create")
    assert store.read("t1", "a.html").content == "x"


def test_explicit_canvas_id_wins_over_thread_id() -> None:
    store = InMemoryCanvasStore()
    tools = _tools(store)
    _invoke(
        tools["write_canvas"],
        _runtime(canvas_id="c9", thread_id="t1"),
        path="a.html",
        content="x",
        description="create",
    )
    assert store.read("c9", "a.html").content == "x"
    assert store.history("t1") == []


def test_context_dict_canvas_id_wins() -> None:
    store = InMemoryCanvasStore()
    tools = _tools(store)
    runtime = _Runtime(context={"canvas_id": "ctx"}, config={"configurable": {"thread_id": "t1"}})
    _invoke(tools["write_canvas"], runtime, path="a.html", content="x", description="create")
    assert store.read("ctx", "a.html").content == "x"


# --- read ------------------------------------------------------------------------


def test_read_returns_revision_and_line_numbers() -> None:
    store = InMemoryCanvasStore()
    commit = store.write("t1", "a.html", "<h1>Hi</h1>\n<p>Body</p>", "create")
    out = _invoke(_tools(store)["read_canvas"], _runtime(thread_id="t1"), path="a.html")
    assert out.startswith(f"revision: {commit.revision}\n")
    assert "   1\t<h1>Hi</h1>" in out
    assert "   2\t<p>Body</p>" in out


def test_read_missing_file_returns_error_text() -> None:
    out = _invoke(
        _tools(InMemoryCanvasStore())["read_canvas"], _runtime(thread_id="t1"), path="a.html"
    )
    assert out.startswith("Error:")
    assert "list_canvas_files" in out


# --- edit: read-before-update ----------------------------------------------------


def test_edit_with_current_revision_succeeds() -> None:
    store = InMemoryCanvasStore()
    commit = store.write("t1", "a.html", "<h1>[X] Title</h1>", "create")
    out = _invoke(
        _tools(store)["edit_canvas"],
        _runtime(thread_id="t1"),
        path="a.html",
        old="[X] ",
        new="",
        description="Remove marker",
        revision=commit.revision,
    )
    assert out.startswith("Edited a.html")
    assert store.read("t1", "a.html").content == "<h1>Title</h1>"


def test_edit_with_stale_revision_is_rejected_with_retry_hint() -> None:
    store = InMemoryCanvasStore()
    stale = store.write("t1", "a.html", "one", "create")
    store.write("t1", "a.html", "two", "human edit")
    out = _invoke(
        _tools(store)["edit_canvas"],
        _runtime(thread_id="t1"),
        path="a.html",
        old="two",
        new="three",
        description="edit",
        revision=stale.revision,
    )
    assert out.startswith("Error:")
    assert "read_canvas" in out
    assert store.read("t1", "a.html").content == "two"


def test_edit_ambiguous_match_is_rejected() -> None:
    store = InMemoryCanvasStore()
    commit = store.write("t1", "a.html", "dup dup", "create")
    out = _invoke(
        _tools(store)["edit_canvas"],
        _runtime(thread_id="t1"),
        path="a.html",
        old="dup",
        new="x",
        description="edit",
        revision=commit.revision,
    )
    assert out.startswith("Error:")


# --- list / history --------------------------------------------------------------


def test_list_canvas_empty_and_populated() -> None:
    store = InMemoryCanvasStore()
    tools = _tools(store)
    assert _invoke(tools["list_canvas_files"], _runtime(thread_id="t1")) == "The canvas is empty."
    store.write("t1", "a.html", "abc", "create")
    assert _invoke(tools["list_canvas_files"], _runtime(thread_id="t1")) == "a.html (3 bytes)"


def test_tool_writes_produce_described_history() -> None:
    store = InMemoryCanvasStore()
    tools = _tools(store)
    runtime = _runtime(thread_id="t1")
    _invoke(tools["write_canvas"], runtime, path="a.html", content="one", description="Create")
    revision = store.read("t1", "a.html").revision
    _invoke(
        tools["edit_canvas"],
        runtime,
        path="a.html",
        old="one",
        new="two",
        description="Fix wording",
        revision=revision,
    )
    assert [c.description for c in store.history("t1")] == ["Fix wording", "Create"]
