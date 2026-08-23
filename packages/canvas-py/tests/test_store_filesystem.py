"""Filesystem-backend specifics beyond the shared contract: durability and
path safety. Behavioral parity lives in ``test_store_contract.py``."""

from __future__ import annotations

from pathlib import Path

import pytest

from langchain_canvas.store import FileCanvasStore
from langchain_canvas.store.base import CanvasStoreError


def test_content_and_history_survive_reopen(tmp_path: Path) -> None:
    store = FileCanvasStore(tmp_path)
    first = store.write("c1", "a.html", "one", "Create")
    store.edit("c1", "a.html", "one", "two", "Fix")

    reopened = FileCanvasStore(tmp_path)
    assert reopened.read("c1", "a.html").content == "two"
    assert [c.description for c in reopened.history("c1")] == ["Fix", "Create"]
    assert reopened.read("c1", "a.html", revision=first.revision).content == "one"


def test_nested_paths_allowed(tmp_path: Path) -> None:
    store = FileCanvasStore(tmp_path)
    store.write("c1", "assets/logo.svg", "<svg/>", "Add asset")
    assert store.read("c1", "assets/logo.svg").content == "<svg/>"
    assert [f.path for f in store.list_files("c1")] == ["assets/logo.svg"]


@pytest.mark.parametrize("bad", ["../escape.html", "/etc/passwd", "a/../../b", ""])
def test_traversal_paths_rejected(tmp_path: Path, bad: str) -> None:
    store = FileCanvasStore(tmp_path)
    with pytest.raises(CanvasStoreError):
        store.write("c1", bad, "x", "nope")


@pytest.mark.parametrize("bad", ["..", "a/b", ""])
def test_bad_canvas_ids_rejected(tmp_path: Path, bad: str) -> None:
    store = FileCanvasStore(tmp_path)
    with pytest.raises(CanvasStoreError):
        store.write(bad, "a.html", "x", "nope")


def test_torn_final_log_line_is_not_a_commit(tmp_path: Path) -> None:
    store = FileCanvasStore(tmp_path)
    store.write("c1", "a.html", "one", "Create")
    log = tmp_path / "c1" / "history" / "commits.jsonl"
    with log.open("a", encoding="utf-8") as fh:
        fh.write('{"revision": "v2", "desc')  # append torn mid-write, no newline

    # Readers skip the torn line: the canvas still has exactly one commit.
    assert [c.revision for c in store.history("c1")] == ["v1"]
    assert store.read("c1", "a.html").content == "one"

    # The retry works: the writer truncates the torn tail before appending,
    # so the new line cannot fuse with the broken one.
    commit = store.write("c1", "a.html", "two", "Fix")
    assert commit.revision == "v2"
    assert log.read_text("utf-8").endswith("\n")
    assert [c.revision for c in store.history("c1")] == ["v2", "v1"]
    assert store.read("c1", "a.html").content == "two"


def test_torn_append_leftover_snapshot_is_replaced(tmp_path: Path) -> None:
    store = FileCanvasStore(tmp_path)
    store.write("c1", "a.html", "one", "Create")
    # Simulate a crash between the snapshot copy and the log append: the v2
    # snapshot directory exists but the log line never landed.
    (tmp_path / "c1" / "history" / "snapshots" / "v2").mkdir(parents=True)
    log = tmp_path / "c1" / "history" / "commits.jsonl"
    with log.open("a", encoding="utf-8") as fh:
        fh.write('{"revision": "v2"')

    commit = store.write("c1", "a.html", "two", "Fix")
    assert commit.revision == "v2"
    assert store.read("c1", "a.html", revision="v2").content == "two"


def test_corrupt_interior_log_line_raises_store_error(tmp_path: Path) -> None:
    store = FileCanvasStore(tmp_path)
    store.write("c1", "a.html", "one", "Create")
    store.write("c1", "b.html", "two", "Add")
    log = tmp_path / "c1" / "history" / "commits.jsonl"
    lines = log.read_text("utf-8").splitlines()
    lines[0] = lines[0][:20]  # corrupt a non-final, newline-terminated line
    log.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Interior corruption is real damage: surface it as a store error, never
    # a raw JSONDecodeError, and never skip it (history must not lie).
    with pytest.raises(CanvasStoreError):
        store.history("c1")
