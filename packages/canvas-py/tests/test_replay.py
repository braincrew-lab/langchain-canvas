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


# --- table artifact files (.table.json) ------------------------------------------


def _table_content(title: str, rows: list[dict]) -> str:
    from langchain_canvas import encode_table

    return encode_table(title, {"columns": [{"key": "a", "label": "A"}], "rows": rows})


def test_table_file_replays_as_table_artifact() -> None:
    store = InMemoryCanvasStore()
    store.write("c1", "compare.table.json", _table_content("Compare", [{"a": 1}]), "create table")
    second = store.write(
        "c1", "compare.table.json", _table_content("Compare", [{"a": 2}]), "hand edit"
    )

    events = hydrate_events(store, "c1")
    kinds = [e["type"] for e in events]
    assert kinds == [
        "canvas.create",
        "canvas.status",
        "canvas.commit",
        "canvas.patch",
        "canvas.commit",
    ]
    artifact = events[0]["artifact"]
    assert artifact["type"] == "table"
    assert artifact["title"] == "Compare"
    assert artifact["data"]["rows"] == [{"a": 1}]
    # Later commits patch every TableData key (null deletes stale state client-side).
    assert events[3]["patch"]["rows"] == [{"a": 2}]
    assert events[3]["patch"]["sheet"] is None
    assert events[4]["revision"] == second.revision


def test_malformed_table_file_is_skipped_until_repaired() -> None:
    store = InMemoryCanvasStore()
    store.write("c1", "broken.table.json", "not json {", "corrupt")
    assert hydrate_events(store, "c1") == []

    store.write("c1", "broken.table.json", _table_content("Fixed", [{"a": 1}]), "repair")
    events = hydrate_events(store, "c1")
    # The repaired file replays as a first appearance, not a patch.
    assert [e["type"] for e in events] == ["canvas.create", "canvas.status", "canvas.commit"]
    assert events[0]["artifact"]["title"] == "Fixed"


def test_table_title_from_file_beats_host_path_fallback() -> None:
    # Hosts' title_for conventions typically fall back to the path (like the
    # deck-manifest lambda); a table file's own title must still win.
    store = InMemoryCanvasStore()
    store.write("c1", "models.table.json", _table_content("Model compare", [{"a": 1}]), "create")
    events = hydrate_events(store, "c1", title_for=lambda path: path)
    assert events[0]["artifact"]["title"] == "Model compare"
