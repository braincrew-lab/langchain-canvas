"""Style-preserving deck tools exercise real stores and DOM measurements."""

from types import SimpleNamespace

from langchain_canvas.deck import Deck, SlideTemplate, parse_deck, serialize_deck
from langchain_canvas.store import InMemoryCanvasStore


def setup_deck(body=None):
    from app.agent.deck_editing import create_deck_editing_tools

    store = InMemoryCanvasStore()
    body = (
        body
        or '<section class="slide"><p data-node-id="title" style="position:absolute;left:40px;top:40px;width:500px;height:90px;font-size:32px;color:#123456;margin:0">Original title</p></section>'
    )
    content = serialize_deck(
        Deck(
            title="Source",
            ratio="16:9",
            source="sources/original.pdf",
            slides=[
                SlideTemplate("one", "One", "p{font-family:Arial}", body),
                SlideTemplate(
                    "two", "Two", "", '<section class="slide"><p>Keep me</p></section>'
                ),
            ],
        )
    )
    revision = store.write("thread", "source.slides.html", content, "Seed").revision
    events = []
    runtime = SimpleNamespace(
        context=None,
        config={"configurable": {"thread_id": "thread"}},
        stream_writer=events.append,
    )
    tools = {t.name: t for t in create_deck_editing_tools(store)}
    return store, revision, runtime, tools


def test_replace_plain_text_preserves_style_source_and_other_slide():
    store, revision, runtime, tools = setup_deck()
    original = store.read("thread", "source.slides.html").content
    result = tools["replace_slide_text"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        node_id="title",
        text="New <content> & message",
        runtime=runtime,
    )
    assert result["status"] == "committed"
    deck = parse_deck(store.read("thread", "source.slides.html").content)
    assert "New &lt;content&gt; &amp; message" in deck.slides[0].body_html
    assert "color:#123456" in deck.slides[0].body_html.replace(" ", "")
    assert (
        deck.slides[0].style_css.replace(" ", "").replace(";}", "}")
        == "p{font-family:Arial}"
    )
    assert deck.slides[1] == parse_deck(original).slides[1]
    assert deck.source == "sources/original.pdf"
    assert store.read("thread", "source.slides.html", revision).content == original


def test_rich_text_slots_preserve_inline_emphasis_and_reject_plain_overwrite():
    body = '<section class="slide"><p data-node-id="rich" style="color:#222">Hello <strong style="color:#ff0000">world</strong>!</p></section>'
    store, revision, runtime, tools = setup_deck(body)
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "node_id": "rich",
        "runtime": runtime,
    }
    assert tools["replace_slide_text"].func(**args, text="Flatten")["status"] == "error"
    result = tools["replace_slide_text"].func(**args, slots=["Welcome ", "team", "."])
    assert result["status"] == "committed"
    current = (
        parse_deck(store.read("thread", "source.slides.html").content)
        .slides[0]
        .body_html
    )
    assert ">Welcome <strong" in current and ">team</strong>." in current
    assert "color: #ff0000" in current


def test_inspection_reports_text_slots_and_style_without_writing():
    store, revision, runtime, tools = setup_deck()
    result = tools["inspect_slide_elements"].func(
        path="source.slides.html", slide_id="one", runtime=runtime
    )
    assert result["revision"] == revision and result["elements"]
    title = next(e for e in result["elements"] if e["id"] == "title")
    assert title["text"] == "Original title" and title["slots"] == ["Original title"]
    assert title["w"] == 500
    style = tools["extract_slide_style"].func(
        path="source.slides.html", slide_id="one", runtime=runtime
    )
    assert "Arial" in str(style["typography"]) and "rgb(18, 52, 86)" in style["colors"]
    assert store.read("thread", "source.slides.html").revision == revision


def test_mutations_are_revision_checked_dry_run_noop_and_overflow_safe():
    store, revision, runtime, tools = setup_deck()
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "node_id": "title",
        "runtime": runtime,
    }
    assert (
        tools["replace_slide_text"].func(**args, text="Preview", dry_run=True)["status"]
        == "dry_run"
    )
    assert (
        tools["replace_slide_text"].func(**args, text="Original title")["status"]
        == "noop"
    )
    assert store.read("thread", "source.slides.html").revision == revision
    assert (
        tools["replace_slide_text"].func(**args, text="A very long paragraph " * 100)[
            "status"
        ]
        == "error"
    )
    assert store.read("thread", "source.slides.html").revision == revision
    args["revision"] = "stale"
    assert "Revision" in tools["replace_slide_text"].func(**args, text="Stale")["error"]


def test_clone_preserves_source_bytes_provenance_and_assets_without_overwrite():
    store, revision, runtime, tools = setup_deck()
    original = store.read("thread", "source.slides.html").content
    args = {
        "source": "source.slides.html",
        "destination": "working.slides.html",
        "revision": revision,
        "runtime": runtime,
    }
    assert (
        tools["clone_deck_template"].func(**args, dry_run=True)["status"] == "dry_run"
    )
    result = tools["clone_deck_template"].func(**args)
    assert result["status"] == "committed"
    assert store.read("thread", "working.slides.html").content == original
    assert store.read("thread", "source.slides.html").content == original
    args["revision"] = result["revision"]
    assert tools["clone_deck_template"].func(**args)["status"] == "error"


def test_style_and_position_changes_are_bounded_and_keep_text():
    store, revision, runtime, tools = setup_deck()
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "runtime": runtime,
    }
    styled = tools["style_slide_elements"].func(
        **args, node_ids=["title"], styles={"color": "#ff0000", "font_size": 30}
    )
    assert styled["status"] == "committed"
    args["revision"] = styled["revision"]
    positioned = tools["position_slide_elements"].func(
        **args, boxes=[{"node_id": "title", "x": 70, "y": 60, "width": 450}]
    )
    assert positioned["status"] == "committed"
    slide = parse_deck(store.read("thread", "source.slides.html").content).slides[0]
    assert "Original title" in slide.body_html and "left: 70px" in slide.body_html
    args["revision"] = positioned["revision"]
    assert (
        tools["style_slide_elements"].func(
            **args, node_ids=["title"], styles={"color": "red;position:fixed"}
        )["status"]
        == "error"
    )
    assert (
        tools["position_slide_elements"].func(
            **args, boxes=[{"node_id": "title", "x": float("nan")}]
        )["status"]
        == "error"
    )
    assert (
        tools["position_slide_elements"].func(
            **args, boxes=[{"node_id": "title", "x": 1500}]
        )["status"]
        == "error"
    )
    assert store.read("thread", "source.slides.html").revision == positioned["revision"]


def test_replace_image_preserves_box_and_rejects_external_or_missing_assets():
    import io

    from PIL import Image

    body = '<section class="slide"><img data-node-id="photo" src="assets/old.png" style="position:absolute;left:40px;top:40px;width:200px;height:100px;object-fit:cover"></section>'
    store, _, runtime, tools = setup_deck(body)
    stream = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(stream, format="PNG")
    store.write_bytes("thread", "assets/old.png", stream.getvalue(), "Old image")
    revision = store.write_bytes(
        "thread", "assets/new.png", stream.getvalue(), "New image"
    ).revision
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "node_id": "photo",
        "runtime": runtime,
    }
    for src in ("https://example.com/x.png", "assets/missing.png", "../../private.png"):
        assert tools["replace_slide_image"].func(**args, asset=src)["status"] == "error"
    result = tools["replace_slide_image"].func(
        **args, asset="assets/new.png", fit="contain"
    )
    assert result["status"] == "committed"
    current = (
        parse_deck(store.read("thread", "source.slides.html").content)
        .slides[0]
        .body_html
    )
    assert (
        'src="assets/new.png"' in current
        and "width: 200px" in current
        and "object-fit: contain" in current
    )
    assert store.read_bytes("thread", "assets/old.png").data == stream.getvalue()


def test_align_and_distribute_keep_content_and_spacing():
    body = (
        '<section class="slide">'
        + "".join(
            f'<p data-node-id="{name}" style="position:absolute;left:{x}px;top:{y}px;width:100px;height:40px;margin:0">{name}</p>'
            for name, x, y in [("a", 40, 40), ("b", 210, 90), ("c", 440, 70)]
        )
        + "</section>"
    )
    _store, revision, runtime, tools = setup_deck(body)
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "runtime": runtime,
        "node_ids": ["a", "b", "c"],
    }
    aligned = tools["align_slide_elements"].func(**args, alignment="top")
    assert aligned["status"] == "committed"
    args["revision"] = aligned["revision"]
    result = tools["align_slide_elements"].func(
        **args, alignment="distribute_horizontal"
    )
    assert result["status"] == "committed"
    seen = tools["inspect_slide_elements"].func(
        path=args["path"], slide_id="one", runtime=runtime
    )
    assert [e["y"] for e in seen["elements"]] == [40, 40, 40]
    assert [e["x"] for e in seen["elements"]] == [40, 240, 440]
    assert [e["text"] for e in seen["elements"]] == ["a", "b", "c"]


def test_fit_text_shrinks_within_style_limits_or_refuses_without_commit():
    body = '<section class="slide"><p data-node-id="title" style="position:absolute;left:40px;top:40px;width:180px;height:46px;font:40px Arial;white-space:nowrap;margin:0;color:#123456">Old</p></section>'
    store, revision, runtime, tools = setup_deck(body)
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "node_id": "title",
        "runtime": runtime,
    }
    result = tools["fit_slide_text"].func(**args, text="Hello world")
    assert result["status"] == "committed"
    assert 30 <= result["font_size"] < 40
    args["revision"] = result["revision"]
    before = store.read("thread", "source.slides.html").content
    refused = tools["fit_slide_text"].func(**args, text="Much too long content " * 50)
    assert refused["status"] == "error"
    assert store.read("thread", "source.slides.html").content == before


def test_normalize_merges_adjacent_fragments_into_editable_text_block():
    body = '<section class="slide"><span data-node-id="a" style="position:absolute;left:40px;top:40px;font:30px Arial">Hello </span><span data-node-id="b" style="position:absolute;left:116.7px;top:40px;font:30px Arial">world</span></section>'
    store, revision, runtime, tools = setup_deck(body)
    result = tools["normalize_slide_text"].func(
        path="source.slides.html", slide_id="one", revision=revision, runtime=runtime
    )
    assert result["status"] == "committed"
    assert result["report"]["merged"] >= 1
    current = (
        parse_deck(store.read("thread", "source.slides.html").content)
        .slides[0]
        .body_html
    )
    assert 'data-text-block="true"' in current
    assert "Hello" in current and "world" in current


def test_verification_checks_expected_content_and_style_drift_read_only():
    store, revision, runtime, tools = setup_deck()
    edited = tools["replace_slide_text"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        node_id="title",
        text="New title",
        runtime=runtime,
    )
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "runtime": runtime,
        "baseline_revision": revision,
        "expected_text": {"title": "New title"},
    }
    assert tools["verify_slide_edit"].func(**args)["passed"] is True
    styled = tools["style_slide_elements"].func(
        path="source.slides.html",
        slide_id="one",
        revision=edited["revision"],
        node_ids=["title"],
        styles={"color": "red"},
        runtime=runtime,
    )
    report = tools["verify_slide_edit"].func(**args)
    assert report["passed"] is False
    assert any(i["code"] == "style_drift" for i in report["issues"])
    args["expected_text"] = {"title": "Missing content"}
    assert any(
        i["code"] == "text_mismatch"
        for i in tools["verify_slide_edit"].func(**args)["issues"]
    )
    assert store.read("thread", "source.slides.html").revision == styled["revision"]


def test_text_edit_rejects_inline_targets_oversize_content_and_invalid_color():
    body = '<section class="slide"><p data-node-id="block">A <span data-node-id="inline">word</span></p></section>'
    store, revision, runtime, tools = setup_deck(body)
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "runtime": runtime,
    }
    assert (
        tools["replace_slide_text"].func(**args, node_id="inline", text="No")["status"]
        == "error"
    )
    assert (
        tools["replace_slide_text"].func(**args, node_id="block", text="X" * 100001)[
            "status"
        ]
        == "error"
    )
    assert (
        tools["style_slide_elements"].func(
            **args, node_ids=["block"], styles={"color": "not-a-real-color"}
        )["status"]
        == "error"
    )
    assert store.read("thread", "source.slides.html").revision == revision


def test_canvas_context_takes_precedence_over_thread_id():
    _, _, runtime, tools = setup_deck()
    runtime.context = {"canvas_id": "missing-canvas"}
    result = tools["inspect_slide_elements"].func(
        path="source.slides.html", slide_id="one", runtime=runtime
    )
    assert result["status"] == "error"


def test_empty_or_identical_style_update_is_noop():
    store, revision, runtime, tools = setup_deck()
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "runtime": runtime,
        "node_ids": ["title"],
    }
    assert tools["style_slide_elements"].func(**args, styles={})["status"] == "noop"
    assert (
        tools["style_slide_elements"].func(**args, styles={"color": "#123456"})[
            "status"
        ]
        == "noop"
    )
    assert store.read("thread", "source.slides.html").revision == revision


def test_invalid_inputs_fail_without_writes_and_all_tools_handle_missing_deck():
    store, revision, runtime, tools = setup_deck()
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "runtime": runtime,
    }
    for extra in (
        {"text": "new", "slots": ["new"]},
        {},
        {"slots": []},
        {"slots": ["x", "y"]},
    ):
        assert (
            tools["replace_slide_text"].func(**args, node_id="title", **extra)["status"]
            == "error"
        )
    for values in ([], ["title", "title"]):
        assert (
            tools["style_slide_elements"].func(
                **args, node_ids=values, styles={"color": "blue"}
            )["status"]
            == "error"
        )
    for extra in (
        {"min_font_size": float("nan")},
        {"min_font_size": 100},
        {"node_id": "missing"},
    ):
        fit = {**args, "node_id": "title", **extra}
        assert tools["fit_slide_text"].func(**fit)["status"] == "error"
    assert (
        tools["align_slide_elements"].func(
            **args, node_ids=["title"], alignment="left"
        )["status"]
        == "error"
    )
    assert (
        tools["align_slide_elements"].func(
            **args, node_ids=["title", "missing"], alignment="left"
        )["status"]
        == "error"
    )
    assert (
        tools["clone_deck_template"].func(
            source="source.slides.html",
            destination="sources/forbidden.slides.html",
            revision=revision,
            runtime=runtime,
        )["status"]
        == "error"
    )
    assert (
        tools["clone_deck_template"].func(
            source="source.slides.html",
            destination="new.slides.html",
            revision="stale",
            runtime=runtime,
        )["status"]
        == "error"
    )
    assert store.read("thread", "source.slides.html").revision == revision
    for name in ("inspect_slide_elements", "extract_slide_style", "verify_slide_edit"):
        assert (
            tools[name].func(
                path="missing.slides.html", slide_id="one", runtime=runtime
            )["status"]
            == "error"
        )
    assert (
        tools["normalize_slide_text"].func(**{**args, "slide_id": "missing"})["status"]
        == "error"
    )
    runtime.config = {}
    assert (
        tools["inspect_slide_elements"].func(
            path="source.slides.html", slide_id="one", runtime=runtime
        )["status"]
        == "error"
    )


def test_alignment_variants_and_nested_position_coordinates():
    body = '<section class="slide"><div style="position:absolute;left:30px;top:20px"><p data-node-id="a" style="position:absolute;left:10px;top:20px;width:80px;height:30px;margin:0">Alpha</p><p data-node-id="b" style="position:absolute;left:160px;top:120px;width:100px;height:40px;margin:0">Beta</p></div></section>'
    _, revision, runtime, tools = setup_deck(body)
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "revision": revision,
        "runtime": runtime,
        "node_ids": ["a", "b"],
    }
    for alignment in ("left", "right", "bottom", "hcenter", "vcenter"):
        result = tools["align_slide_elements"].func(
            **args, alignment=alignment, dry_run=True
        )
        assert result["status"] in {"dry_run", "noop"}
    assert (
        tools["align_slide_elements"].func(**args, alignment="distribute_vertical")[
            "status"
        ]
        == "error"
    )
    placed = tools["position_slide_elements"].func(
        path=args["path"],
        slide_id="one",
        revision=revision,
        runtime=runtime,
        boxes=[{"node_id": "a", "x": 70, "y": 80}],
    )
    assert placed["status"] == "committed"
    inspected = tools["inspect_slide_elements"].func(
        path=args["path"], slide_id="one", runtime=runtime
    )
    element = next(e for e in inspected["elements"] if e["id"] == "a")
    assert (element["x"], element["y"]) == (70, 80)


def test_unknown_style_and_missing_image_prevent_unsafe_commit():
    store, revision, runtime, tools = setup_deck(
        '<section class="slide"><p data-node-id="title" style="mix-blend-mode:multiply">Original</p><img src="assets/absent.png"></section>'
    )
    result = tools["replace_slide_text"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        node_id="title",
        text="New",
        runtime=runtime,
    )
    assert result["status"] == "error"
    assert store.read("thread", "source.slides.html").revision == revision
    report = tools["verify_slide_edit"].func(
        path="source.slides.html", slide_id="one", runtime=runtime
    )
    assert report["passed"] is False


def test_verification_ignores_ancestor_text_aggregate_but_detects_layout_movement():
    body = '<section class="slide" data-node-id="container"><p data-node-id="title" style="margin:0;height:40px">Original</p><p data-node-id="following" style="margin:0">Following</p></section>'
    store, revision, runtime, tools = setup_deck(body)
    result = tools["replace_slide_text"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        node_id="title",
        text="Replacement",
        runtime=runtime,
    )
    assert result["status"] == "committed"
    report = tools["verify_slide_edit"].func(
        path="source.slides.html",
        slide_id="one",
        runtime=runtime,
        baseline_revision=revision,
        expected_text={"title": "Replacement"},
    )
    assert report["passed"] is True
    current = store.read("thread", "source.slides.html").content
    store.write(
        "thread",
        "source.slides.html",
        current.replace("height: 40px", "height: 80px"),
        "External layout change",
    )
    moved = tools["verify_slide_edit"].func(
        path="source.slides.html",
        slide_id="one",
        runtime=runtime,
        baseline_revision=revision,
        expected_text={"title": "Replacement"},
    )
    assert any(
        i["code"] == "geometry_drift" and i["id"] == "following"
        for i in moved["issues"]
    )


def test_position_rejects_ancestor_and_descendant_targets_atomically():
    body = '<section class="slide"><div data-node-id="parent" style="position:absolute;left:20px;top:20px;width:400px;height:200px"><p data-node-id="child" style="position:absolute;left:20px;top:20px;margin:0">Child</p></div></section>'
    store, revision, runtime, tools = setup_deck(body)
    result = tools["position_slide_elements"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        runtime=runtime,
        boxes=[{"node_id": "parent", "x": 40}, {"node_id": "child", "x": 80}],
    )
    assert result["status"] == "error"
    assert store.read("thread", "source.slides.html").revision == revision


def test_verification_does_not_flag_decorative_symbols_as_fragmented_text():
    body = (
        '<section class="slide">'
        + "".join(
            f'<p data-node-id="s{i}" style="margin:0">{symbol}</p>'
            for i, symbol in enumerate(["┏", "┓", "┗", "┛", "★"])
        )
        + "</section>"
    )
    _, _, runtime, tools = setup_deck(body)
    result = tools["verify_slide_edit"].func(
        path="source.slides.html", slide_id="one", runtime=runtime
    )
    assert result["warnings"] == []


def test_empty_placeholder_can_be_filled_again():
    _store, revision, runtime, tools = setup_deck()
    args = {
        "path": "source.slides.html",
        "slide_id": "one",
        "node_id": "title",
        "runtime": runtime,
    }
    cleared = tools["replace_slide_text"].func(**args, revision=revision, text="")
    assert cleared["status"] == "committed"
    filled = tools["replace_slide_text"].func(
        **args, revision=cleared["revision"], text="New message"
    )
    assert filled["status"] == "committed"


def test_position_rejects_transformed_ancestor_without_commit():
    body = '<section class="slide"><div style="position:absolute;left:100px;top:100px;transform:scale(2)"><p data-node-id="nested" style="position:absolute;left:20px;top:20px;width:200px;height:80px">Keep</p></div></section>'
    store, revision, runtime, tools = setup_deck(body)
    result = tools["position_slide_elements"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        boxes=[{"node_id": "nested", "x": 200, "y": 200}],
        runtime=runtime,
    )
    assert result["status"] == "error"
    assert store.read("thread", "source.slides.html").revision == revision


def test_unsupported_css_cannot_silently_change_source_palette():
    body = '<section><p data-node-id="title" style="--brand:#123456;color:var(--brand);margin:0;font-size:24px">Original title</p></section>'
    store, revision, runtime, tools = setup_deck(body)
    result = tools["replace_slide_text"].func(
        path="source.slides.html",
        slide_id="one",
        node_id="title",
        revision=revision,
        text="New title",
        runtime=runtime,
    )
    assert result["status"] == "error"
    assert "--brand" in result["error"]
    assert store.read("thread", "source.slides.html").revision == revision


def test_replace_with_genuine_uploaded_source_image():
    import io

    from PIL import Image

    body = '<section class="slide"><img data-node-id="photo" src="assets/old.png" style="position:absolute;left:40px;top:40px;width:100px;height:100px"></section>'
    store, _, runtime, tools = setup_deck(body)
    png = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(png, format="PNG")
    store.write_bytes("thread", "assets/old.png", png.getvalue(), "old")
    revision = store.write_bytes(
        "thread", "sources/new.png", png.getvalue(), "upload"
    ).revision
    result = tools["replace_slide_image"].func(
        path="source.slides.html",
        slide_id="one",
        node_id="photo",
        revision=revision,
        asset="sources/new.png",
        runtime=runtime,
    )
    assert result["status"] == "committed"
    assert 'src="sources/new.png"' in store.read("thread", "source.slides.html").content


def test_fit_rich_text_preserves_relative_run_size_and_line_height():
    body = '<section class="slide"><p data-node-id="title" style="position:absolute;left:40px;top:40px;width:180px;height:46px;font-size:40px;line-height:44px;font-family:Arial;white-space:nowrap;margin:0;color:#123456">Old <span style="font-size:32px;line-height:36px;color:red">word</span></p></section>'
    store, revision, runtime, tools = setup_deck(body)
    fitted = tools["fit_slide_text"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        node_id="title",
        runtime=runtime,
        slots=["Hello ", "world!"],
    )
    assert fitted["status"] == "committed", fitted
    assert 30 <= fitted["font_size"] < 40
    import re

    from lxml import html as parser

    current = (
        parse_deck(store.read("thread", "source.slides.html").content)
        .slides[0]
        .body_html
    )
    root = parser.fromstring(current)
    parent = root.xpath('.//*[@data-node-id="title"]')[0]
    child = parent.xpath("./span")[0]
    size = float(re.search(r"font-size:\s*([\d.]+)", parent.get("style"))[1])
    child_size = float(re.search(r"font-size:\s*([\d.]+)", child.get("style"))[1])
    assert abs(child_size / size - 0.8) < 0.001
    assert "color: red" in child.get("style")
    assert parent.text_content() == "Hello world!"


def test_verify_detects_external_deletion_unexpected_text_and_metadata_changes():
    store, revision, runtime, tools = setup_deck(
        '<section><p data-node-id="a">First</p><p data-node-id="b">Second</p><p data-node-id="hidden" style="display:none">Hidden</p></section>'
    )
    source = parse_deck(store.read("thread", "source.slides.html").content)
    changed = serialize_deck(
        Deck(
            "Changed",
            source.ratio,
            source.source,
            [
                SlideTemplate(
                    "one",
                    "One",
                    "",
                    '<section><p data-node-id="a">Unexpected</p></section>',
                ),
                source.slides[1],
            ],
        )
    )
    store.write("thread", "source.slides.html", changed, "Concurrent external edit")
    result = tools["verify_slide_edit"].func(
        path="source.slides.html",
        slide_id="one",
        runtime=runtime,
        baseline_revision=revision,
    )
    codes = {i["code"] for i in result["issues"]}
    assert {"missing_element", "unexpected_text_change", "metadata_changed"} <= codes
    assert result["passed"] is False


def test_overlapping_distribution_does_not_mutate_or_emit():
    body = (
        "<section>"
        + "".join(
            f'<p data-node-id="{name}" style="position:absolute;left:{x}px;top:40px;width:100px;height:40px;margin:0">{name}</p>'
            for name, x in [("a", 40), ("b", 90), ("c", 120)]
        )
        + "</section>"
    )
    store, revision, runtime, tools = setup_deck(body)
    result = tools["align_slide_elements"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        runtime=runtime,
        node_ids=["a", "b", "c"],
        alignment="distribute_horizontal",
    )
    assert result["status"] == "error" and "overlap" in result["error"]
    assert store.read("thread", "source.slides.html").revision == revision


def test_missing_duplicate_or_nontext_targets_fail_without_writes():
    import pytest
    from app.agent.deck_editing import _Markup, _plain_text

    markup = _Markup(
        '<section>\n<p data-node-id="same">A</p><p data-node-id="same">B</p><br/><span/></section>'
    )
    with pytest.raises(ValueError, match="exactly once"):
        markup.target("same")
    with pytest.raises(ValueError, match="text element"):
        _plain_text('<img data-node-id="image"/>', "image", "No")
    store, revision, runtime, tools = setup_deck(
        '<section data-node-id="container"><p data-node-id="title">Content</p></section>'
    )
    result = tools["fit_slide_text"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        runtime=runtime,
        node_id="container",
        text="No",
    )
    assert result["status"] == "error" and "semantic text block" in result["error"]
    result = tools["replace_slide_text"].func(
        path="sources/locked.slides.html",
        slide_id="one",
        revision=revision,
        runtime=runtime,
        node_id="title",
        text="No",
    )
    assert result["status"] == "error"
    assert store.read("thread", "source.slides.html").revision == revision


def test_transparent_fill_clears_background_without_changing_text():
    store, revision, runtime, tools = setup_deck()
    result = tools["style_slide_elements"].func(
        path="source.slides.html",
        slide_id="one",
        revision=revision,
        runtime=runtime,
        node_ids=["title"],
        styles={"background_color": "transparent", "border_color": None},
    )
    assert result["status"] == "committed"
    current = store.read("thread", "source.slides.html").content
    assert "background-color: transparent" in current and "Original title" in current
