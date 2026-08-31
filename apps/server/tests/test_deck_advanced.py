"""Advanced tools keep source designs and batch changes atomic."""

from types import SimpleNamespace

from app.agent.deck_advanced import create_deck_advanced_tools
from langchain_canvas.deck import Deck, SlideTemplate, parse_deck, serialize_deck
from langchain_canvas.store import InMemoryCanvasStore


def setup(body=None, second=None, store=None):
    store = store or InMemoryCanvasStore()
    body = (
        body
        or '<section><h1 data-node-id="title" data-text-role="title" style="margin:0;font:32px Arial;color:red">Original</h1><p data-node-id="body" style="margin:0;font:24px Arial;color:blue">Body</p></section>'
    )
    second = (
        second
        or '<section><p data-node-id="other" style="margin:0;color:red">Untouched</p></section>'
    )
    source = serialize_deck(
        Deck(
            "Template",
            "16:9",
            "sources/original.pptx",
            [
                SlideTemplate("one", "One", "", body),
                SlideTemplate("two", "Two", "", second),
            ],
        )
    )
    revision = store.write("thread", "deck.slides.html", source, "Seed").revision
    events = []
    runtime = SimpleNamespace(
        config={"configurable": {"thread_id": "thread"}},
        context=None,
        stream_writer=events.append,
    )
    return (
        store,
        revision,
        runtime,
        {t.name: t for t in create_deck_advanced_tools(store)},
        events,
    )


def test_roles_map_without_mutation_and_ambiguous_slots_stay_unresolved():
    store, rev, runtime, tools, events = setup()
    result = tools["map_content_slots"].func(
        path="deck.slides.html",
        runtime=runtime,
        requests=[
            {"key": "headline", "role": "title", "text": "New"},
            {"key": "copy", "role": "body"},
        ],
    )
    assert result["status"] == "ok", result
    assert result["proposals"][0]["node_id"] == "title"
    assert result["unresolved"][0]["key"] == "copy"
    assert store.read("thread", "deck.slides.html").revision == rev and not events


def test_theme_is_simultaneous_atomic_and_retains_unselected_slide():
    store, rev, runtime, tools, events = setup()
    source = store.read("thread", "deck.slides.html").content
    args = {
        "path": "deck.slides.html",
        "revision": rev,
        "runtime": runtime,
        "slide_ids": ["one"],
        "mappings": [
            {"property": "color", "source": "red", "target": "blue"},
            {"property": "color", "source": "blue", "target": "green"},
        ],
    }
    dry = tools["apply_deck_theme"].func(**args, dry_run=True)
    assert dry["status"] == "dry_run", dry
    assert not events and store.read("thread", "deck.slides.html").content == source
    changed = tools["apply_deck_theme"].func(**args)
    assert changed["status"] == "committed", changed
    current = parse_deck(store.read("thread", "deck.slides.html").content)
    assert current.slides[1] == parse_deck(source).slides[1]
    assert (
        "color: blue" in current.slides[0].body_html
        and "color: green" in current.slides[0].body_html
    )
    assert sum(e["type"] == "canvas.commit" for e in events) == 1
    assert tools["apply_deck_theme"].func(**args)["status"] == "error"


def test_table_preserves_rich_cell_and_rejects_partial_dimensions():
    body = '<section><table data-node-id="table" style="border-collapse:collapse"><tr><th data-node-id="a" style="color:red">Header</th><th data-node-id="b">Other</th></tr><tr><td data-node-id="c">Old <strong>bold</strong></td><td data-node-id="d">Value</td></tr></table></section>'
    store, rev, runtime, tools, events = setup(body)
    args = {
        "path": "deck.slides.html",
        "slide_id": "one",
        "revision": rev,
        "node_id": "table",
        "runtime": runtime,
    }
    assert (
        tools["replace_table_data"].func(**args, rows=[[{"text": "Bad"}]])["status"]
        == "error"
    )
    assert not events
    result = tools["replace_table_data"].func(
        **args,
        rows=[
            [{"text": "Name"}, {"text": "Count"}],
            [{"slots": ["New ", "rich"]}, {"text": "10"}],
        ],
    )
    assert result["status"] == "committed", result
    current = store.read("thread", "deck.slides.html").content
    assert "New <strong>rich</strong>" in current and "color:red" in current


def test_native_table_style_changes_reject_before_saving_but_content_can_change():
    from app.agent.deck_editing import create_deck_editing_tools

    body = '<section class="slide" data-node-id="root" style="font-family:Arial"><table data-node-id="table" data-pptx-shape-id="e0" style="position:absolute;left:40px;top:40px;width:300px;height:80px"><tr><td data-node-id="cell" style="color:red">Old</td></tr></table></section>'
    store, rev, runtime, advanced, events = setup(body)
    legacy = {t.name: t for t in create_deck_editing_tools(store)}
    themed = advanced["apply_deck_theme"].func(
        path="deck.slides.html",
        revision=rev,
        runtime=runtime,
        mappings=[{"property": "font-family", "source": "Arial", "target": "Verdana"}],
    )
    assert themed["status"] == "error" and "native_table" in themed["error"]
    styled = legacy["style_slide_elements"].func(
        path="deck.slides.html",
        slide_id="one",
        revision=rev,
        runtime=runtime,
        node_ids=["cell"],
        styles={"color": "blue"},
    )
    assert styled["status"] == "error" and "native_table" in styled["error"]
    assert store.read("thread", "deck.slides.html").revision == rev and not events
    replaced = advanced["replace_table_data"].func(
        path="deck.slides.html",
        slide_id="one",
        node_id="table",
        revision=rev,
        runtime=runtime,
        rows=[[{"text": "New content"}]],
    )
    assert replaced["status"] == "committed", replaced
    moved = legacy["position_slide_elements"].func(
        path="deck.slides.html",
        slide_id="one",
        revision=replaced["revision"],
        runtime=runtime,
        boxes=[{"node_id": "table", "x": 80, "y": 80, "width": 300, "height": 80}],
    )
    assert moved["status"] == "committed", moved
    resized = legacy["position_slide_elements"].func(
        path="deck.slides.html",
        slide_id="one",
        revision=moved["revision"],
        runtime=runtime,
        boxes=[{"node_id": "table", "width": 400}],
    )
    assert resized["status"] == "error" and "native_table" in resized["error"]
    assert store.read("thread", "deck.slides.html").revision == moved["revision"]


def test_native_table_guard_rejects_stylesheet_changes_and_structural_rewrites():
    import pytest
    from app.agent.deck_editing import _guard_native_table_edits

    before = '<style>td{color:red}</style><table data-pptx-shape-id="e0"><tr><td>Old</td></tr></table>'
    for after in (
        before.replace("color:red", "color:blue"),
        before.replace("<td>Old</td>", "<td>New</td><td>Extra</td>"),
        before.replace('data-pptx-shape-id="e0"', ""),
    ):
        with pytest.raises(ValueError, match="unsupported_native_table_style"):
            _guard_native_table_edits(before, after)


def test_repair_fits_multiple_overflows_before_final_validation():
    body = (
        "<section>"
        + "".join(
            f'<p data-node-id="{ident}" style="position:absolute;left:40px;top:{y}px;width:190px;height:48px;margin:0;font:40px Arial;white-space:nowrap;color:red">Hello world!</p>'
            for ident, y in [("a", 40), ("b", 140)]
        )
        + "</section>"
    )
    store, rev, runtime, tools, events = setup(body)
    result = tools["repair_slide_layout"].func(
        path="deck.slides.html", revision=rev, runtime=runtime
    )
    assert result["status"] == "committed", result
    assert len(result["repairs"]) == 2
    assert sum(e["type"] == "canvas.commit" for e in events) == 1
    report = tools["verify_deck_consistency"].func(
        path="deck.slides.html",
        runtime=runtime,
        baseline_revision=rev,
        allowed_style_properties=["font-size", "line-height"],
    )
    assert report["passed"] and report["complete"], report
    assert store.read("thread", "deck.slides.html").revision == result["revision"]


def test_verifier_rejects_expected_text_outside_selected_slides():
    store, rev, runtime, tools, events = setup()
    result = tools["verify_deck_consistency"].func(
        path="deck.slides.html",
        runtime=runtime,
        slide_ids=["one"],
        expected_text=[{"slide_id": "two", "node_id": "other", "text": "Untouched"}],
    )
    assert not result["passed"] and result["status"] == "error"
    assert store.read("thread", "deck.slides.html").revision == rev and not events


def test_chart_replacement_uses_native_metadata_and_reports_preview_limits():
    import json

    from langchain_canvas.deck import baseline_slide_html, extract_slides
    from lxml import html
    from test_structured_deck import source_presentation

    body = baseline_slide_html(
        extract_slides(source_presentation(), path="s.pptx")[0],
        slide_id="s1",
        ratio="16:9",
    )
    node = html.fromstring(body).xpath(".//*[@data-chart-data]")[0]
    ident = node.get("data-node-id")
    original = json.loads(node.get("data-chart-data"))
    store, rev, runtime, tools, events = setup(body)
    args = {
        "path": "deck.slides.html",
        "slide_id": "one",
        "revision": rev,
        "node_id": ident,
        "runtime": runtime,
        "categories": ["2025", "2026"],
        "series": [{"name": "Revenue", "values": [25, 40]}],
    }
    result = tools["replace_chart_data"].func(**args)
    assert result["status"] == "committed", result
    current = (
        parse_deck(store.read("thread", "deck.slides.html").content).slides[0].body_html
    )
    chart = html.fromstring(current).xpath(".//*[@data-chart-data]")[0]
    data = json.loads(chart.get("data-chart-data"))
    assert data["categories"] == ["2025", "2026"] and data["series"][0]["values"] == [
        25,
        40,
    ]
    assert data["series"][0]["color"] == original["series"][0]["color"]
    mapped = tools["map_content_slots"].func(path="deck.slides.html", runtime=runtime)
    descriptor = next(s for s in mapped["slots"] if s["role"] == "chart")
    assert "simplified" in descriptor["limitations"][0]
    bad = {
        **args,
        "revision": result["revision"],
        "categories": ["Only"],
        "series": [{"name": "Revenue", "values": [30]}],
    }
    assert tools["replace_chart_data"].func(**bad)["status"] == "error"
    theme = tools["apply_deck_theme"].func(
        path="deck.slides.html",
        revision=result["revision"],
        runtime=runtime,
        mappings=[{"property": "color", "source": data["color"], "target": "red"}],
    )
    assert theme["status"] == "error" and "unsupported_chart_theme" in theme["error"]
    assert sum(e["type"] == "canvas.commit" for e in events) == 1


def test_theme_affects_rich_inline_runs_and_normalizes_css_without_cascading():
    body = '<section><p data-node-id="p" style="font-family:Arial;color:#ff0000;margin:0">A <strong style="color:blue">B</strong><span>C</span></p></section>'
    store, rev, runtime, tools, _ = setup(body)
    result = tools["apply_deck_theme"].func(
        path="deck.slides.html",
        revision=rev,
        runtime=runtime,
        slide_ids=["one"],
        mappings=[
            {"property": "color", "source": "rgb(255, 0, 0)", "target": "blue"},
            {"property": "color", "source": "blue", "target": "green"},
            {"property": "font-family", "source": "'Arial'", "target": "Verdana"},
        ],
    )
    assert result["status"] == "committed", result
    body = (
        parse_deck(store.read("thread", "deck.slides.html").content).slides[0].body_html
    )
    assert (
        "advanced-temporary" not in body
        and "color: green" in body
        and "font-family: Verdana" in body
    )
    assert "A " in body and ">B</strong>" in body


def test_theme_no_match_or_identical_value_is_noop():
    store, rev, runtime, tools, events = setup()
    for source, target in [("purple", "yellow"), ("red", "#ff0000")]:
        result = tools["apply_deck_theme"].func(
            path="deck.slides.html",
            revision=rev,
            runtime=runtime,
            mappings=[{"property": "color", "source": source, "target": target}],
        )
        assert result["status"] == "noop", result
    assert not events and store.read("thread", "deck.slides.html").revision == rev


def test_atomic_theme_rolls_back_if_later_slide_has_unsupported_css_or_assets():
    for second in [
        '<p data-node-id="bad" style="color:red;--unsafe:red">Bad</p>',
        '<p data-node-id="bad" style="color:red">Bad</p><img src="assets/missing.png">',
        '<p data-node-id="bad" style="position:absolute;left:1300px;color:red">Outside</p>',
    ]:
        store, rev, runtime, tools, events = setup(second=second)
        before = store.read("thread", "deck.slides.html").content
        result = tools["apply_deck_theme"].func(
            path="deck.slides.html",
            revision=rev,
            runtime=runtime,
            mappings=[{"property": "color", "source": "red", "target": "blue"}],
        )
        assert result["status"] == "error", result
        assert store.read("thread", "deck.slides.html").content == before and not events


def test_concurrent_store_write_is_preserved_and_emits_no_failed_edit_event():
    class RacingStore(InMemoryCanvasStore):
        armed = False

        def write(
            self,
            canvas_id,
            path,
            content,
            description,
            base_revision=None,
            actor="agent",
            **kwargs,
        ):
            if self.armed:
                self.armed = False
                previous = self.read(canvas_id, path).content
                super().write(
                    canvas_id,
                    path,
                    previous.replace("Original", "Concurrent"),
                    "Concurrent human edit",
                )
            return super().write(
                canvas_id,
                path,
                content,
                description,
                base_revision=base_revision,
                actor=actor,
                **kwargs,
            )

    store, rev, runtime, tools, events = setup(store=RacingStore())
    store.armed = True
    result = tools["apply_deck_theme"].func(
        path="deck.slides.html",
        revision=rev,
        runtime=runtime,
        mappings=[{"property": "color", "source": "red", "target": "blue"}],
    )
    assert result["status"] == "error", result
    current = store.read("thread", "deck.slides.html").content
    assert "Concurrent" in current and "color:red" in current and not events


def test_mapping_keeps_unsupported_tables_uneditable_and_rejects_duplicate_targets():
    body = '<section><table data-node-id="t"><tr><td data-node-id="c" colspan="2">Merged</td></tr></table><img data-node-id="image" style="display:none"><li data-node-id="bullet">Point</li><div data-node-id="text" data-text-block="true">Text</div></section>'
    store, rev, runtime, tools, events = setup(body)
    result = tools["map_content_slots"].func(
        path="deck.slides.html",
        runtime=runtime,
        requests=[{"key": "x", "role": "bullet"}, {"key": "y", "role": "bullet"}],
    )
    assert result["status"] == "ok", result
    assert not next(s for s in result["slots"] if s["role"] == "table")["editable"]
    assert len(result["proposals"]) == 1 and len(result["unresolved"]) == 1
    assert any(s["role"] == "text" for s in result["slots"])
    assert not events and store.read("thread", "deck.slides.html").revision == rev


def test_table_rejects_nested_merged_missing_ids_non_table_and_rich_flattening():
    cases = [
        (
            '<table data-node-id="t"><tr><td data-node-id="c" rowspan="2">A</td></tr></table>',
            "t",
        ),
        (
            '<table data-node-id="t"><tr><td data-node-id="c"><table><tr><td>X</td></tr></table></td></tr></table>',
            "t",
        ),
        ('<table data-node-id="t"><tr><td>A</td></tr></table>', "t"),
        ('<table data-node-id="t"></table>', "t"),
        ('<p data-node-id="t">Text</p>', "t"),
        (
            '<table data-node-id="t"><tr><td data-node-id="c">A <b>B</b></td></tr></table>',
            "t",
        ),
    ]
    for body, ident in cases:
        store, rev, runtime, tools, events = setup(body)
        result = tools["replace_table_data"].func(
            path="deck.slides.html",
            slide_id="one",
            revision=rev,
            node_id=ident,
            rows=[[{"text": "New"}]],
            runtime=runtime,
        )
        assert result["status"] == "error", result
        assert store.read("thread", "deck.slides.html").revision == rev and not events


def test_repair_unfit_target_rolls_back_every_prior_fit():
    body = '<section><p data-node-id="a" style="width:190px;height:48px;margin:0;font:40px Arial;white-space:nowrap">Hello world!</p><p data-node-id="b" style="width:20px;height:48px;margin:0;font:40px Arial;white-space:nowrap">Impossible sentence</p></section>'
    store, rev, runtime, tools, events = setup(body)
    result = tools["repair_slide_layout"].func(
        path="deck.slides.html", revision=rev, runtime=runtime
    )
    assert result["status"] == "error" and "cannot fit" in result["error"]
    assert store.read("thread", "deck.slides.html").revision == rev and not events


def test_repair_noop_dryrun_and_unsafe_nontext_layout():
    _store, rev, runtime, tools, events = setup()
    for targets in (None, [{"slide_id": "one", "node_id": "title"}]):
        result = tools["repair_slide_layout"].func(
            path="deck.slides.html",
            revision=rev,
            runtime=runtime,
            targets=targets,
            dry_run=True,
        )
        assert result["status"] == "noop", result
    assert not events
    _store, rev, runtime, tools, events = setup(
        '<section><p data-node-id="a" style="position:absolute;left:1300px">Outside</p></section>'
    )
    result = tools["repair_slide_layout"].func(
        path="deck.slides.html", revision=rev, runtime=runtime
    )
    assert result["status"] == "error" and result["issues"][0]["code"] == "off_canvas"


def test_verification_collects_errors_metadata_and_expected_text_without_writes():
    store, rev, runtime, tools, events = setup()
    original = store.read("thread", "deck.slides.html").content
    store.write(
        "thread",
        "deck.slides.html",
        original.replace("Original", "Changed").replace(
            "<title>Template</title>", "<title>Changed</title>"
        ),
        "External edit",
    )
    result = tools["verify_deck_consistency"].func(
        path="deck.slides.html",
        runtime=runtime,
        baseline_revision=rev,
        expected_text=[{"slide_id": "one", "node_id": "title", "text": "Missing"}],
    )
    assert not result["passed"] and result["complete"]
    assert {i["code"] for i in result["issues"]} >= {
        "metadata_changed",
        "text_mismatch",
    }
    assert result["fonts"] and result["palette"] and not events


def test_verification_failure_and_partial_scope_never_claim_whole_deck_pass():
    _, _, runtime, tools, _ = setup(second='<img src="assets/missing.png">')
    result = tools["verify_deck_consistency"].func(
        path="deck.slides.html", runtime=runtime
    )
    assert not result["passed"] and result["complete"]
    assert len(result["slides"]) == 2
    selected = tools["verify_deck_consistency"].func(
        path="deck.slides.html", runtime=runtime, slide_ids=["one"]
    )
    assert selected["passed"] and selected["checked_slides"] == ["one"]


def test_strict_nested_inputs_and_finite_bounds_apply_to_direct_functions():
    import pytest
    from pydantic import ValidationError

    _, rev, runtime, tools, _ = setup()
    invalid = [
        (
            "map_content_slots",
            {"requests": [{"key": "a", "role": "title", "unknown": True}]},
        ),
        ("map_content_slots", {"slide_ids": ["one", "one"]}),
        (
            "apply_deck_theme",
            {
                "revision": rev,
                "mappings": [
                    {"property": "color", "source": "red", "target": "url(x)"}
                ],
            },
        ),
        (
            "apply_deck_theme",
            {
                "revision": rev,
                "mappings": [
                    {"property": "color", "source": "red", "target": "blue"},
                    {"property": "color", "source": "#ff0000", "target": "green"},
                ],
            },
        ),
        ("repair_slide_layout", {"revision": rev, "max_shrink": float("nan")}),
        (
            "repair_slide_layout",
            {"revision": rev, "targets": [{"slide_id": "one", "node_id": "title"}] * 2},
        ),
        (
            "replace_chart_data",
            {
                "slide_id": "one",
                "revision": rev,
                "node_id": "title",
                "categories": ["A"],
                "series": [{"name": "Series", "values": [float("inf")]}],
            },
        ),
        (
            "replace_table_data",
            {
                "slide_id": "one",
                "revision": rev,
                "node_id": "title",
                "rows": [[{"text": "A", "slots": ["B"]}]],
            },
        ),
    ]
    for name, extra in invalid:
        assert (
            tools[name].func(path="deck.slides.html", runtime=runtime, **extra)[
                "status"
            ]
            == "error"
        )
    with pytest.raises(ValidationError):
        tools["map_content_slots"].args_schema.model_validate(
            {"path": "deck.slides.html", "runtime": runtime, "unexpected": 1}
        )


def test_missing_invalid_protected_paths_and_selection_are_rejected():
    _, rev, runtime, tools, _ = setup()
    for path in (
        "sources/locked.slides.html",
        "exports/output.slides.html",
        "../unsafe.slides.html",
        "missing.slides.html",
        "not-deck.html",
    ):
        assert (
            tools["map_content_slots"].func(path=path, runtime=runtime)["status"]
            == "error"
        )
    for ids in ([], ["absent"]):
        assert (
            tools["map_content_slots"].func(
                path="deck.slides.html", runtime=runtime, slide_ids=ids
            )["status"]
            == "error"
        )
    result = tools["repair_slide_layout"].func(
        path="deck.slides.html",
        revision=rev,
        runtime=runtime,
        targets=[{"slide_id": "one", "node_id": "missing"}],
    )
    assert result["status"] == "error"


def test_chart_verification_requires_explicit_expected_root_content():
    from langchain_canvas.deck import baseline_slide_html, extract_slides
    from lxml import html
    from test_structured_deck import source_presentation

    body = baseline_slide_html(
        extract_slides(source_presentation(), path="s.pptx")[0],
        slide_id="s1",
        ratio="16:9",
    )
    ident = html.fromstring(body).xpath(".//*[@data-chart-data]")[0].get("data-node-id")
    store, rev, runtime, tools, _ = setup(body)
    result = tools["replace_chart_data"].func(
        path="deck.slides.html",
        slide_id="one",
        revision=rev,
        node_id=ident,
        categories=["Future", "Now"],
        series=[{"name": "New", "values": [100, 25]}],
        runtime=runtime,
    )
    assert result["status"] == "committed", result
    unexpected = tools["verify_deck_consistency"].func(
        path="deck.slides.html", runtime=runtime, baseline_revision=rev
    )
    assert any(
        i["code"] == "unexpected_chart_data_change" for i in unexpected["issues"]
    )
    current = (
        parse_deck(store.read("thread", "deck.slides.html").content).slides[0].body_html
    )
    assert "Future" in current
    checked = tools["verify_deck_consistency"].func(
        path="deck.slides.html",
        runtime=runtime,
        baseline_revision=rev,
        expected_charts=[
            {
                "slide_id": "one",
                "node_id": ident,
                "categories": ["Future", "Now"],
                "series": [{"name": "New", "values": [100, 25]}],
            }
        ],
    )
    assert checked["passed"], checked
    assert any(w["code"] == "simplified_chart_preview" for w in checked["warnings"])


def test_chart_tampering_malformed_metadata_and_wrong_expectations_fail():
    from langchain_canvas.deck import baseline_slide_html, extract_slides
    from lxml import html
    from test_structured_deck import source_presentation

    original = baseline_slide_html(
        extract_slides(source_presentation(), path="s.pptx")[0],
        slide_id="s1",
        ratio="16:9",
    )
    for change in ("color", "metadata", "type", "size", "expected", "style"):
        root = html.fromstring(original)
        node = root.xpath(".//*[@data-chart-data]")[0]
        ident = node.get("data-node-id")
        if change == "color":
            child = node.xpath('./div[contains(@style,"background:")]')[0]
            child.set("style", child.get("style").replace("#663399", "#ff0000"))
        elif change == "metadata":
            node.set("data-chart-data", '{"type":"pie"}')
        elif change == "type":
            node.set("data-chart-type", "bar")
        elif change == "size":
            node.set("style", node.get("style").replace("width:576px", "width:50%"))
        body = html.tostring(root, encoding="unicode")
        store, rev, runtime, tools, _ = setup(body)
        kwargs = {}
        if change in {"expected", "style"}:
            kwargs["expected_charts"] = [
                {
                    "slide_id": "one",
                    "node_id": ident,
                    "categories": ["Q1", "Q2"],
                    "series": [{"name": "Sales", "values": [999, 20]}],
                }
            ]
        result = tools["verify_deck_consistency"].func(
            path="deck.slides.html", runtime=runtime, **kwargs
        )
        assert not result["passed"], (change, result)
        assert store.read("thread", "deck.slides.html").revision == rev


def test_readonly_verification_uses_one_consistent_deck_snapshot():
    class ChangingReadStore(InMemoryCanvasStore):
        armed = False
        latest_reads = 0

        def read(self, canvas_id, path, revision=None):
            got = super().read(canvas_id, path, revision)
            if self.armed and revision is None:
                self.latest_reads += 1
                self.armed = False
                self.write(
                    canvas_id,
                    path,
                    got.content.replace("Untouched", "Later edit"),
                    "Concurrent update",
                )
            return got

    store, rev, runtime, tools, events = setup(store=ChangingReadStore())
    store.armed = True
    result = tools["verify_deck_consistency"].func(
        path="deck.slides.html",
        runtime=runtime,
        expected_text=[{"slide_id": "two", "node_id": "other", "text": "Untouched"}],
    )
    assert result["passed"] and result["revision"] == rev, result
    assert (
        store.latest_reads == 1
        and "Later edit" in store.read("thread", "deck.slides.html").content
        and not events
    )


def test_deck_model_limits_no_ragged_chart_and_table_budget():
    import pytest
    from app.agent.deck_advanced_models import ChartInput, TableInput
    from pydantic import ValidationError

    base = {
        "path": "deck.slides.html",
        "slide_id": "one",
        "revision": "v1",
        "node_id": "t",
    }
    for rows in (
        [[{"text": "x" * 100000}, {"text": "x"}]],
        [[{"text": "x"}] * 50] * 41,
    ):
        with pytest.raises(ValidationError):
            TableInput.model_validate({**base, "rows": rows})
    with pytest.raises(ValidationError):
        ChartInput.model_validate(
            {**base, "categories": ["A", "B"], "series": [{"name": "S", "values": [1]}]}
        )
    for categories, series in (
        (["A"], [{"name": "S", "values": [True]}]),
        (["A"] * 51, [{"name": "S", "values": [1] * 51}]),
        (["A"], [{"name": "S", "values": [1]}] * 9),
    ):
        with pytest.raises(ValidationError):
            ChartInput.model_validate(
                {**base, "categories": categories, "series": series}
            )


def test_large_overflow_discovery_and_minimum_font_fail_without_mutation():
    body = (
        "<section>"
        + "".join(
            f'<p data-node-id="p{i}" style="position:absolute;left:40px;top:{i * 30}px;width:5px;height:30px;font:20px Arial;margin:0">Overflow</p>'
            for i in range(21)
        )
        + "</section>"
    )
    store, rev, runtime, tools, events = setup(body)
    result = tools["repair_slide_layout"].func(
        path="deck.slides.html", revision=rev, runtime=runtime
    )
    assert result["status"] == "error" and "20" in result["error"]
    result = tools["repair_slide_layout"].func(
        path="deck.slides.html",
        revision=rev,
        runtime=runtime,
        targets=[{"slide_id": "one", "node_id": "p0"}],
        min_font_size=40,
    )
    assert (
        result["status"] == "error"
        and "minimum" in result["error"].lower()
        or "min_font_size" in result["error"]
    )
    assert store.read("thread", "deck.slides.html").revision == rev and not events


def test_gradient_mapping_duplicate_element_ids_and_readonly_css_errors():
    for body, source in [
        (
            '<p data-node-id="x" style="background:linear-gradient(red,blue)">Gradient</p>',
            "red",
        ),
        ('<p data-node-id="x">One</p><p data-node-id="x">Two</p>', "white"),
    ]:
        _, rev, runtime, tools, _ = setup(body)
        result = tools["apply_deck_theme"].func(
            path="deck.slides.html",
            revision=rev,
            runtime=runtime,
            mappings=[
                {"property": "background-color", "source": source, "target": "green"}
            ],
        )
        assert result["status"] == "error", result
    _, _, runtime, tools, _ = setup(
        '<p data-node-id="x" style="--custom:red;color:var(--custom)">Unsafe</p>'
    )
    result = tools["verify_deck_consistency"].func(
        path="deck.slides.html", runtime=runtime
    )
    assert not result["passed"] and any(
        i["code"] == "unsupported" for i in result["issues"]
    )


def test_measurement_budget_fails_closed_before_any_write():
    import pytest
    from app.agent.deck_advanced import _Session

    store, revision, runtime, _tools, events = setup()
    session = _Session.load(store, runtime, "deck.slides.html", revision)
    session.measurement_limit = 200
    session.measurements = 200
    with pytest.raises(ValueError, match="200-measurement budget"):
        session.measure(session.slides()[0])
    assert store.read("thread", "deck.slides.html").revision == revision and not events
