"""hydrate_events — replaying stored history as wire events."""

from __future__ import annotations

from langchain_canvas import InMemoryCanvasStore, hydrate_events
from langchain_canvas.replay import display_title


def test_empty_canvas_replays_nothing() -> None:
    assert hydrate_events(InMemoryCanvasStore(), "c1") == []


def test_replay_creates_then_patches_and_commits() -> None:
    store = InMemoryCanvasStore()
    first = store.write("c1", "page.html", "<p>v1</p>", "create page")
    store.write("c1", "notes.txt", "not an artifact", "side notes")
    second = store.edit("c1", "page.html", "v1", "v2", "tweak", base_revision=None)

    events = hydrate_events(store, "c1")
    kinds = [e["type"] for e in events]
    # First appearance: create + complete status; later commits patch. The
    # non-artifact file (.txt) is skipped entirely.
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


# --- source previews (uploads) ---------------------------------------------------


def test_markdown_source_previews_as_document() -> None:
    store = InMemoryCanvasStore()
    store.write("c1", "sources/notes.md", "# Notes\nhello", "Upload notes.md", actor="human")
    events = hydrate_events(store, "c1")
    assert [e["type"] for e in events] == ["canvas.create", "canvas.status", "canvas.commit"]
    artifact = events[0]["artifact"]
    assert artifact["type"] == "document"
    assert artifact["title"] == "notes.md"
    assert artifact["data"]["content"] == "# Notes\nhello"


def test_json_source_previews_as_fenced_document() -> None:
    store = InMemoryCanvasStore()
    store.write("c1", "sources/data.json", '{"a": 1}', "Upload data.json", actor="human")
    events = hydrate_events(store, "c1")
    assert events[0]["artifact"]["data"]["content"] == '```json\n{"a": 1}\n```'


def test_html_source_previews_as_html_artifact() -> None:
    store = InMemoryCanvasStore()
    store.write("c1", "sources/page.html", "<p>hi</p>", "Upload page.html", actor="human")
    events = hydrate_events(store, "c1")
    assert events[0]["artifact"]["type"] == "html"


def test_uploaded_deck_stays_a_deck_after_reload() -> None:
    store = InMemoryCanvasStore()
    content = '<html><body><template data-slide-id="s1"><h1>Slide</h1></template></body></html>'
    store.write("c1", "sources/deck.slides.html", content, "Upload deck", actor="human")
    artifact = hydrate_events(store, "c1")[0]["artifact"]
    assert artifact["type"] == "slides"
    assert artifact["data"]["html"] == content


def test_csv_and_binary_sources_replay_as_file_artifacts() -> None:
    # Uploads outside the text-preview set still show on the canvas — as
    # `file` artifacts (a card, plus whatever preview can be derived). The
    # person who uploaded a file always sees it. Details: test_file_preview.py.
    store = InMemoryCanvasStore()
    store.write("c1", "sources/rows.csv", "a,b\n1,2", "Upload rows.csv", actor="human")
    store.write_bytes("c1", "sources/photo.png", b"\x89PNG\x00\xff", "Upload photo.png")
    events = hydrate_events(store, "c1")
    created = [e["artifact"] for e in events if e["type"] == "canvas.create"]
    assert [(a["type"], a["id"]) for a in created] == [
        ("file", "sources/rows.csv"),
        ("file", "sources/photo.png"),
    ]


def test_chart_file_replays_as_chart_artifact() -> None:
    from langchain_canvas import encode_chart

    store = InMemoryCanvasStore()
    data = {
        "chart": "bar",
        "xKey": "quarter",
        "series": [{"key": "value"}],
        "rows": [{"quarter": "Q1", "value": 10}],
        "options": {"title": "Quarterly"},
    }
    store.write("t", "revenue.chart.json", encode_chart("Revenue", data), "Build chart")

    events = hydrate_events(store, "t")
    create = next(e for e in events if e["type"] == "canvas.create")
    assert create["artifact"]["type"] == "chart"
    assert create["artifact"]["title"] == "Revenue"
    assert create["artifact"]["data"]["options"] == {"title": "Quarterly"}


def test_legacy_slides_json_hydrates_as_readonly_file_card() -> None:
    """An existing thread's `.slides.json` deck must not vanish on reload.

    The pre-dialect `{slides, page, template}` shape has no renderer left —
    it now hydrates as a plain read-only ``file`` card (see
    :mod:`langchain_canvas.replay`'s module docstring), the same shape a
    binary upload gets, instead of the old `slides` artifact type.
    """
    store = InMemoryCanvasStore()
    legacy = '{"type": "slides", "title": "Pitch", "data": {"slides": [{"title": "Hello"}]}}'
    store.write("t", "deck.slides.json", legacy, "Build deck")

    events = hydrate_events(store, "t")
    create = next(e for e in events if e["type"] == "canvas.create")
    assert create["artifact"]["type"] == "file"
    assert create["artifact"]["id"] == "deck.slides.json"
    assert create["artifact"]["data"]["name"] == "deck.slides.json"
    assert create["artifact"]["data"]["detail"] == "legacy slide deck — read-only"

    # A later edit still patches the file card — never re-emits a `slides`
    # artifact with the old shape.
    store.write(
        "t", "deck.slides.json", legacy.replace("Hello", "Hi"), "Edit deck", base_revision="v1"
    )
    events = hydrate_events(store, "t")
    patch = next(e for e in events if e["type"] == "canvas.patch")
    assert patch["patch"]["name"] == "deck.slides.json"


def test_markdown_file_replays_as_document_with_heading_title() -> None:
    store = InMemoryCanvasStore()
    store.write("t", "report.md", "# Renewable Energy\n\nBody text.", "Write report")
    store.write("t", "report.md", "# Renewable Energy\n\nBody text, edited.", "Edit")

    events = hydrate_events(store, "t")
    create = next(e for e in events if e["type"] == "canvas.create")
    assert create["artifact"]["type"] == "document"
    assert create["artifact"]["title"] == "Renewable Energy"
    assert create["artifact"]["data"] == {
        "format": "markdown",
        "content": "# Renewable Energy\n\nBody text.",
    }
    patch = next(e for e in events if e["type"] == "canvas.patch")
    assert patch["patch"] == {"content": "# Renewable Energy\n\nBody text, edited."}


def test_markdown_without_heading_is_named_after_its_file() -> None:
    store = InMemoryCanvasStore()
    store.write("t", "notes.md", "just prose, no heading", "Write notes")

    events = hydrate_events(store, "t")
    create = next(e for e in events if e["type"] == "canvas.create")
    assert create["artifact"]["title"] == "notes"


def test_a_tab_is_named_without_the_suffix_that_says_what_the_file_is() -> None:
    """The suffix is for the store and the exporters, not for the person.

    A tab reading ``deck.slides.json`` tells someone editing their
    presentation that they are editing a JSON file.
    """
    assert display_title("reports/q3.slides.json") == "q3"
    assert display_title("inventory.table.json") == "inventory"
    assert display_title("01-hello.html") == "01-hello"
    # An upload is the person's own file — its name is already the right one.
    assert display_title("sources/memo.txt") == "memo.txt"

    store = InMemoryCanvasStore()
    store.write("t", "reports/page.html", "<p>hi</p>", "Write page")
    create = next(e for e in hydrate_events(store, "t") if e["type"] == "canvas.create")
    assert create["artifact"]["id"] == "reports/page.html"
    assert create["artifact"]["title"] == "page"


def test_malformed_chart_envelope_is_skipped() -> None:
    store = InMemoryCanvasStore()
    store.write("t", "bad.chart.json", "not json at all", "Corrupt")

    assert hydrate_events(store, "t") == []


def test_encode_artifact_validates_type_data_and_suffix() -> None:
    import pytest

    from langchain_canvas import encode_artifact

    ok = encode_artifact(
        {"type": "chart", "title": "Rev", "data": {"chart": "bar"}}, "rev.chart.json"
    )
    assert '"type": "chart"' in ok

    with pytest.raises(ValueError, match="JSON envelopes"):
        encode_artifact({"type": "document", "data": {}}, "doc.md")
    with pytest.raises(ValueError, match="JSON envelopes"):
        encode_artifact({"type": "slides", "data": {"slides": []}}, "deck.slides.json")
    with pytest.raises(ValueError, match="data object"):
        encode_artifact({"type": "chart"}, "rev.chart.json")
    with pytest.raises(ValueError, match=r"must end with \.chart\.json"):
        encode_artifact({"type": "chart", "data": {"chart": "bar"}}, "rev.json")
