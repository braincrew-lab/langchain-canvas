"""Contract tests every CanvasStore implementation must pass.

New backends register a factory in ``STORE_FACTORIES`` (or reuse this module
from their own test suite) and must pass unmodified — that is the acceptance
bar for the abstraction. The tests only speak the protocol: no backend
internals, no revision-format assumptions beyond opacity.
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable

import pytest

from langchain_canvas.store import (
    CanvasFileNotFoundError,
    CanvasStore,
    EditConflictError,
    FileCanvasStore,
    InMemoryCanvasStore,
    RevisionMismatchError,
)

STORE_FACTORIES: dict[str, Callable[[], CanvasStore]] = {
    "memory": InMemoryCanvasStore,
    "filesystem": lambda: FileCanvasStore(tempfile.mkdtemp(prefix="canvas-store-")),
}


@pytest.fixture(params=sorted(STORE_FACTORIES))
def store(request: pytest.FixtureRequest) -> CanvasStore:
    return STORE_FACTORIES[request.param]()


HTML_V1 = "<h1>Coffee history</h1>\n<p>From Ethiopia to Yemen.</p>\n"


# --- write / read ----------------------------------------------------------------


def test_write_creates_canvas_and_commit(store: CanvasStore) -> None:
    commit = store.write("c1", "01-origin.html", HTML_V1, "Create slide 1")
    assert commit.description == "Create slide 1"
    assert commit.paths == ["01-origin.html"]
    assert commit.revision

    got = store.read("c1", "01-origin.html")
    assert got.content == HTML_V1
    assert got.revision == commit.revision


def test_write_replaces_whole_file(store: CanvasStore) -> None:
    store.write("c1", "a.html", "old", "create")
    store.write("c1", "a.html", "new", "replace")
    assert store.read("c1", "a.html").content == "new"


def test_read_unknown_canvas_or_path_raises(store: CanvasStore) -> None:
    with pytest.raises(CanvasFileNotFoundError):
        store.read("nope", "a.html")
    store.write("c1", "a.html", "x", "create")
    with pytest.raises(CanvasFileNotFoundError):
        store.read("c1", "missing.html")


def test_read_historical_revision(store: CanvasStore) -> None:
    first = store.write("c1", "a.html", "one", "v1")
    store.write("c1", "a.html", "two", "v2")
    assert store.read("c1", "a.html", revision=first.revision).content == "one"
    assert store.read("c1", "a.html").content == "two"


def test_read_unknown_revision_raises(store: CanvasStore) -> None:
    store.write("c1", "a.html", "x", "create")
    with pytest.raises(CanvasFileNotFoundError):
        store.read("c1", "a.html", revision="not-a-revision")


# --- edit ------------------------------------------------------------------------


def test_edit_replaces_unique_occurrence(store: CanvasStore) -> None:
    store.write("c1", "a.html", "<h1>[TEST] Title</h1>", "create")
    commit = store.edit("c1", "a.html", "[TEST] ", "", "Remove test marker")
    assert store.read("c1", "a.html").content == "<h1>Title</h1>"
    assert commit.description == "Remove test marker"


def test_edit_missing_old_string_raises(store: CanvasStore) -> None:
    store.write("c1", "a.html", "hello", "create")
    with pytest.raises(EditConflictError):
        store.edit("c1", "a.html", "absent", "x", "edit")


def test_edit_ambiguous_old_string_raises(store: CanvasStore) -> None:
    store.write("c1", "a.html", "dup dup", "create")
    with pytest.raises(EditConflictError):
        store.edit("c1", "a.html", "dup", "x", "edit")


def test_edit_unknown_file_raises(store: CanvasStore) -> None:
    with pytest.raises(CanvasFileNotFoundError):
        store.edit("c1", "missing.html", "a", "b", "edit")


# --- optimistic concurrency ------------------------------------------------------


def test_stale_base_revision_rejected(store: CanvasStore) -> None:
    first = store.write("c1", "a.html", "one", "v1")
    store.write("c1", "a.html", "two", "v2")
    with pytest.raises(RevisionMismatchError):
        store.edit("c1", "a.html", "two", "three", "stale edit", base_revision=first.revision)
    with pytest.raises(RevisionMismatchError):
        store.write("c1", "a.html", "three", "stale write", base_revision=first.revision)


def test_current_base_revision_accepted(store: CanvasStore) -> None:
    head = store.write("c1", "a.html", "one", "v1")
    store.edit("c1", "a.html", "one", "two", "edit", base_revision=head.revision)
    assert store.read("c1", "a.html").content == "two"


# --- listing / history -----------------------------------------------------------


def test_list_files(store: CanvasStore) -> None:
    assert store.list_files("nope") == []
    store.write("c1", "b.html", "bb", "create b")
    store.write("c1", "a.html", "a", "create a")
    infos = store.list_files("c1")
    assert [f.path for f in infos] == ["a.html", "b.html"]
    assert [f.size for f in infos] == [1, 2]


def test_history_newest_first_including_human_style_edits(store: CanvasStore) -> None:
    assert store.history("nope") == []
    store.write("c1", "a.html", "one", "Create slide 1")
    store.write("c1", "a.html", "one edited", "Manual edit: 1 change")
    store.edit("c1", "a.html", "edited", "polished", "Polish wording")
    descriptions = [c.description for c in store.history("c1")]
    assert descriptions == ["Polish wording", "Manual edit: 1 change", "Create slide 1"]


def test_revisions_are_unique_and_advance(store: CanvasStore) -> None:
    a = store.write("c1", "a.html", "1", "c1")
    b = store.write("c1", "a.html", "2", "c2")
    assert a.revision != b.revision
    assert store.read("c1", "a.html").revision == b.revision


def test_canvases_are_isolated(store: CanvasStore) -> None:
    store.write("c1", "a.html", "one", "create")
    store.write("c2", "a.html", "two", "create")
    assert store.read("c1", "a.html").content == "one"
    assert store.read("c2", "a.html").content == "two"
    assert len(store.history("c1")) == 1
