"""hydrate_events — replaying stored history as wire events."""

from __future__ import annotations

from langchain_canvas import InMemoryCanvasStore, hydrate_events


def test_empty_canvas_replays_nothing() -> None:
    assert hydrate_events(InMemoryCanvasStore(), "c1") == []


def test_replay_creates_then_patches_and_commits() -> None:
    store = InMemoryCanvasStore()
    first = store.write("c1", "page.html", "<p>v1</p>", "create page")
    store.write("c1", "notes.md", "not html", "side notes")
    second = store.edit("c1", "page.html", "v1", "v2", "tweak", base_revision=None)

    events = hydrate_events(store, "c1")
    kinds = [e["type"] for e in events]
    # First appearance: create + complete status; later commits patch. The
    # non-html file is skipped entirely.
    assert kinds == [
        "canvas.create",
        "canvas.status",
        "canvas.commit",
        "canvas.patch",
        "canvas.commit",
    ]
    assert events[0]["artifact"]["id"] == "page.html"
    assert events[0]["artifact"]["data"]["html"] == "<p>v1</p>"
    assert events[2]["revision"] == first.revision
    assert events[3]["patch"]["html"] == "<p>v2</p>"
    assert events[4]["revision"] == second.revision


def test_replay_applies_host_titles_and_meta() -> None:
    store = InMemoryCanvasStore()
    store.write("c1", "01-intro.html", "<p>hi</p>", "slide 1")

    events = hydrate_events(
        store,
        "c1",
        title_for=lambda path: {"01-intro.html": "Intro"}.get(path, path),
        meta_for=lambda path: {"kind": "slide", "ratio": "16:9"},
    )
    artifact = events[0]["artifact"]
    assert artifact["title"] == "Intro"
    assert artifact["meta"] == {"kind": "slide", "ratio": "16:9"}
