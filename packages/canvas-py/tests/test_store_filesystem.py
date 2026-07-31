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
