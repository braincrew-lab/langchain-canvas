"""The lines a model reads before it acts: what is on the canvas, and what the
person changed since the agent last wrote."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from langchain_canvas.state import canvas_now, describe_age, last_change_line
from langchain_canvas.store import InMemoryCanvasStore


def test_an_empty_canvas_says_so_and_saves_the_probing_calls() -> None:
    store = InMemoryCanvasStore()
    block = canvas_now(store, "t1")
    assert block.startswith("## Canvas now")
    assert "empty" in block and "write_canvas" in block


def test_files_are_listed_with_size_kind_and_who_touched_them_last() -> None:
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "sources/deck.pptx", b"x" * 2048, "Upload deck.pptx", actor="human")
    store.write("t1", "deck.slides.json", "{}", "Copy sources/deck.pptx", actor="agent")
    store.write_bytes("t1", "assets/deck/a.png", b"p", "Picture", actor="agent")
    store.write_bytes("t1", "exports/deck.pptx", b"e" * 3000, "Export", actor="agent")
    block = canvas_now(store, "t1")
    assert "- sources/deck.pptx (2 KB; upload, read-only; v1 — human" in block
    assert "- deck.slides.json (2 B; v2 — agent" in block
    assert "- exports/deck.pptx (3 KB; export; v4 — agent" in block
    assert "- assets/: 1 picture(s)" in block
    assert "assets/deck/a.png" not in block  # folded, not listed
    assert "Changed by the person" not in block  # uploads are inputs, not edits


def test_a_human_edit_after_the_agents_last_write_is_called_out() -> None:
    """The one fact the model cannot get in time anywhere else."""
    store = InMemoryCanvasStore()
    store.write("t1", "deck.slides.json", "a", "Write", actor="agent")
    store.write("t1", "deck.slides.json", "b", "Manual edit", actor="human")
    store.write("t1", "deck.slides.json", "c", "Manual edit", actor="human")
    store.write("t1", "notes.md", "n", "Manual edit", actor="human")
    block = canvas_now(store, "t1")
    expected = (
        "Changed by the person since your last write: "
        "deck.slides.json (v2, v3); notes.md (v4)"
    )
    assert expected in block
    assert "read those again before writing" in block
    store.write("t1", "deck.slides.json", "d", "Agent again", actor="agent")
    assert "Changed by the person" not in canvas_now(store, "t1")


def test_the_list_folds_past_the_cap() -> None:
    store = InMemoryCanvasStore()
    for n in range(15):
        store.write("t1", f"f{n:02d}.md", "x", "w", actor="agent")
    block = canvas_now(store, "t1", max_files=12)
    assert "- f11.md" in block and "- f12.md" not in block
    assert "… and 3 more" in block


def test_the_read_header_names_the_last_change() -> None:
    store = InMemoryCanvasStore()
    store.write("t1", "a.md", "x", "First cut", actor="agent")
    store.write("t1", "a.md", "y", "Manual edit", actor="human")
    line = last_change_line(store, "t1", "a.md")
    assert line.startswith('last change: v2 by human "Manual edit"')
    assert last_change_line(store, "t1", "missing.md") == ""


def test_ages_read_as_a_person_would_say_them() -> None:
    now = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    assert describe_age(now - timedelta(seconds=5), now) == "just now"
    assert describe_age(now - timedelta(minutes=3), now) == "3 min ago"
    assert describe_age(now - timedelta(hours=2), now) == "2 h ago"
    assert describe_age(now - timedelta(days=4), now) == "4 d ago"
    assert describe_age(None, now) == ""
