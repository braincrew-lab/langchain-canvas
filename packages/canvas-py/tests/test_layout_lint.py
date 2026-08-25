"""Layout lint — certain-only findings, silence on clean decks, no crashes.

The false-positive suite feeds real deck shapes from actual use (skinned
decks, letterboxed refits, padded slides, structured slides) and demands
zero warnings — one warning here means the check must be narrowed or cut.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from langchain_canvas import encode_slides
from langchain_canvas.layout_lint import lint_slides_data
from langchain_canvas.protocol.artifacts import SlidesData
from langchain_canvas.store import InMemoryCanvasStore
from langchain_canvas.tools import (
    _refit_slides_to_page,
    create_canvas_tools,
)


class _Runtime:
    """The slice of ToolRuntime the canvas tools read."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.context = None
        self.config = config
        self.stream_writer = None


def _runtime() -> _Runtime:
    return _Runtime(config={"configurable": {"thread_id": "t1"}})


def _tools(store: InMemoryCanvasStore) -> dict[str, Any]:
    return {t.name: t for t in create_canvas_tools(store)}


def _write(store: InMemoryCanvasStore, data: dict[str, Any], path: str = "deck.slides.json") -> str:
    tools = _tools(store)
    return tools["write_canvas"].func(
        path=path,
        content=encode_slides("Deck", data),
        description="save",
        runtime=_runtime(),
    )


def _deck(*elements: dict[str, Any], **slide_extra: Any) -> dict[str, Any]:
    return {"slides": [{**slide_extra, "elements": list(elements)}]}


def _el(
    eid: str, etype: str, x: float, y: float, w: float, h: float, **extra: Any
) -> dict[str, Any]:
    return {"id": eid, "type": etype, "x": x, "y": y, "w": w, "h": h, **extra}


# --- each certain check fires ----------------------------------------------------


def test_an_off_page_element_is_named_with_its_numbers() -> None:
    warnings = lint_slides_data(
        _deck(_el("title", "text", 60, 10, 58, 10, text="Hi"))
    )
    assert warnings == [
        'slide 1, element "title": x + w = 118 (off the page — the page runs 0 to 100)'
    ]


def test_negative_origin_is_off_page() -> None:
    warnings = lint_slides_data(
        _deck(_el("a", "shape", -5, -2, 10, 10, shape="rect"))
    )
    assert len(warnings) == 1
    assert "x = -5" in warnings[0] and "y = -2" in warnings[0]


def test_a_zero_sized_element_is_flagged() -> None:
    warnings = lint_slides_data(
        _deck(_el("z", "shape", 10, 10, 0, 5, shape="rect"))
    )
    assert warnings == [
        'slide 1, element "z": w = 0, h = 5 (zero or negative size renders nothing)'
    ]


def test_an_empty_text_element_is_flagged() -> None:
    warnings = lint_slides_data(
        _deck(_el("t", "text", 10, 10, 30, 10, text="   "))
    )
    assert "a text element with no text" in warnings[0]


def test_a_broken_image_reference_is_flagged_only_with_store_knowledge() -> None:
    deck = _deck(_el("img", "image", 10, 10, 30, 30, src="sources/missing.png"))
    assert lint_slides_data(deck) == []  # no ref_exists — no claim
    warnings = lint_slides_data(deck, ref_exists=lambda ref: False)
    assert 'src "sources/missing.png" is not on the canvas' in warnings[0]
    assert lint_slides_data(deck, ref_exists=lambda ref: True) == []


def test_a_fully_covered_element_is_flagged() -> None:
    warnings = lint_slides_data(
        _deck(
            _el("hidden", "text", 20, 20, 20, 10, text="Hi"),
            _el("panel", "shape", 10, 10, 60, 40, shape="rect", fill="#0d1b3e"),
        )
    )
    assert 'element "hidden" is completely covered by element "panel"' in warnings[0]


# --- schema: what the export will refuse ------------------------------------------


def _schema_warning(warnings: list[str]) -> str:
    matched = [w for w in warnings if "does not match the slides schema" in w]
    assert len(matched) == 1, warnings
    return matched[0]


def test_a_missing_element_id_is_flagged_with_the_export_consequence() -> None:
    deck = {"slides": [{"elements": [
        {"type": "text", "x": 6, "y": 8, "w": 88, "h": 10, "text": "Q3"}
    ]}]}
    warning = _schema_warning(lint_slides_data(deck))
    assert "exporting it fails" in warning
    assert 'slide 1, element #1: "id" is required' in warning
    assert "short unique id string" in warning


def test_an_invalid_layout_value_names_the_allowed_values() -> None:
    deck = {"slides": [{"layout": "title+bullets", "title": "Q3"}]}
    warning = _schema_warning(lint_slides_data(deck))
    assert "slide 1: \"layout\" = 'title+bullets'" in warning
    assert "'title', 'content', 'section', 'image', 'two-column' or 'blank'" in warning


def test_the_same_mistake_across_many_elements_is_summarized() -> None:
    deck = {"slides": [{"elements": [
        {"type": "text", "x": 1, "y": i, "w": 10, "h": 5, "text": "x"}
        for i in range(10)
    ]}]}
    warning = _schema_warning(lint_slides_data(deck))
    assert warning.count('"id" is required') == 6
    assert "... and 4 more" in warning


def test_a_field_the_schema_has_no_place_for_is_flagged_as_ignored() -> None:
    deck = _deck(_el("box", "shape", 5, 5, 10, 10, shape="rect", stroke="#333"))
    warnings = lint_slides_data(deck)
    assert len(warnings) == 1
    assert "the canvas and the export both ignore them" in warnings[0]
    assert 'slide 1, element "box": "stroke"' in warnings[0]


def test_unknown_fields_are_caught_at_every_level() -> None:
    deck = {
        "theme": "dark",
        "slides": [{"transition": "fade", "elements": []}],
        "page": {"widthIn": 10, "heightIn": 5.625, "dpi": 96},
    }
    warnings = lint_slides_data(deck)
    assert len(warnings) == 1
    assert 'the deck: "theme"' in warnings[0]
    assert 'slide 1: "transition"' in warnings[0]
    assert 'the deck page: "dpi"' in warnings[0]


def test_out_of_range_padding_is_reported_once_not_twice() -> None:
    warnings = lint_slides_data({"slides": [{"padding": 60, "elements": []}]})
    assert warnings == [
        "slide 1: padding = 60 leaves no content area (must be 0 to below 50)"
    ]


def test_a_padding_of_the_wrong_type_still_reaches_the_schema_line() -> None:
    # The dedicated padding check ignores non-numbers, so the schema line is
    # the only thing standing between this deck and a refused export.
    warning = _schema_warning(lint_slides_data({"slides": [{"padding": "wide"}]}))
    assert 'slide 1: "padding"' in warning


# --- shadowed content: written but never drawn ------------------------------------


def test_structured_text_next_to_elements_is_flagged() -> None:
    deck = {"slides": [{
        "layout": "content",
        "title": "지표",
        "bullets": ["a", "b"],
        "elements": [_el("kpi", "text", 60, 20, 35, 10, text="128건")],
    }]}
    warnings = lint_slides_data(deck)
    assert len(warnings) == 1
    assert '"title", "bullets" are set next to "elements"' in warnings[0]
    assert "only \"elements\" is drawn" in warnings[0]
    assert "move that text into an element" in warnings[0]


def test_one_shadowed_field_reads_as_singular() -> None:
    deck = {"slides": [{
        "subtitle": "요약",
        "elements": [_el("kpi", "text", 60, 20, 35, 10, text="128건")],
    }]}
    assert '"subtitle" is set next to "elements"' in lint_slides_data(deck)[0]


def test_an_empty_elements_array_does_not_shadow_anything() -> None:
    # An empty array is what the structured shape looks like on the wire.
    assert lint_slides_data(
        {"slides": [{"layout": "content", "title": "지표", "elements": []}]}
    ) == []


# --- what deliberately does NOT fire ---------------------------------------------


def test_partial_overlap_is_not_a_finding() -> None:
    # Text over a background panel is normal design, not a defect.
    assert lint_slides_data(
        _deck(
            _el("text", "text", 20, 20, 40, 10, text="Hi"),
            _el("panel", "shape", 30, 15, 40, 40, shape="rect"),
        )
    ) == []


def test_an_ellipse_or_translucent_fill_never_counts_as_cover() -> None:
    base = _el("under", "text", 20, 20, 10, 10, text="Hi")
    ellipse = _el("e", "shape", 0, 0, 100, 100, shape="ellipse")
    alpha = _el("a", "shape", 0, 0, 100, 100, shape="rect", fill="#0d1b3e80")
    assert lint_slides_data(_deck(base, ellipse)) == []
    assert lint_slides_data(_deck(base, alpha)) == []


def test_data_uri_images_make_no_reference_claim() -> None:
    deck = _deck(_el("img", "image", 10, 10, 30, 30, src="data:image/png;base64,AAAA"))
    assert lint_slides_data(deck, ref_exists=lambda ref: False) == []


def test_edge_touching_elements_are_clean() -> None:
    # Exactly on the page edge — and the re-fit's 4-decimal rounding just
    # past it — is fine. Text painted AFTER a full-bleed rect is not covered
    # (paint order: array end is the front).
    assert lint_slides_data(
        _deck(
            _el("full", "shape", 0, 0, 100, 100, shape="rect"),
            _el("r", "text", 55.0001, 0, 45, 10, text="Hi"),
        )
    ) == []


def test_real_deck_shapes_from_use_stay_silent() -> None:
    """The false-positive corpus: decks that mirror real saved decks."""
    corpus: list[dict[str, Any]] = [
        # structured slides (derived layout)
        {"slides": [
            {"layout": "title", "title": "Q3 결과 보고", "subtitle": "요약"},
            {"title": "성과", "bullets": ["a", "b"]},
        ]},
        # skinned circle deck (post-refit letterbox numbers, 4-decimal rounding)
        {
            "template": "sources/brand-skin.pptx",
            "page": {"widthIn": 10.0, "heightIn": 7.5},
            "slides": [{"elements": [
                _el("c", "shape", 0.0, 12.4991, 56.25, 75.0019, shape="ellipse", fill="#ff0000"),
                _el("t", "text", 0.0, 80.0008, 40.0, 7.5002, text="Hi", fontSize=40.0),
            ]}],
        },
        # padded slide with full-width text and a background panel behind it
        {"slides": [{"padding": 5, "elements": [
            _el("panel", "shape", 0, 0, 100, 30, shape="rect", fill="#0d1b3e"),
            _el("title", "text", 5, 8, 90, 14, text="제목", fontSize=36, color="#ffffff"),
        ]}]},
        # edge-touching full-bleed image
        {"slides": [{"elements": [
            _el("bg", "image", 0, 0, 100, 100, src="sources/photo.png"),
            _el("cap", "text", 4, 88, 60, 8, text="caption"),
        ]}]},
    ]
    for deck in corpus:
        assert lint_slides_data(deck, ref_exists=lambda ref: True) == [], deck


def test_both_wire_spellings_of_every_field_stay_silent() -> None:
    """camelCase and snake_case are both the schema — neither is unknown."""
    camel = {
        "page": {"widthIn": 10, "heightIn": 5.625},
        "slides": [{"textColor": "#111", "elements": [
            _el("t", "text", 5, 5, 40, 10, text="Hi", fontSize=28, bold=True),
        ]}],
    }
    snake = {
        "page": {"width_in": 10, "height_in": 5.625},
        "slides": [{"text_color": "#111", "elements": [
            _el("t", "text", 5, 5, 40, 10, text="Hi", font_size=28, bold=True),
        ]}],
    }
    assert lint_slides_data(camel) == []
    assert lint_slides_data(snake) == []


_LAYOUTS = [None, "title", "content", "section", "image", "two-column", "blank"]
_ELEMENTS = [
    {"type": "text", "text": "Hi", "fontSize": 24, "color": "#111", "align": "center"},
    {"type": "image", "src": "sources/photo.png"},
    {"type": "shape", "shape": "rect", "fill": "#0d1b3e"},
    {"type": "shape", "shape": "ellipse", "fill": "#ff0000"},
    {"type": "shape", "shape": "line", "fill": "#888888"},
]


def test_the_valid_deck_sweep_stays_silent() -> None:
    """Every combination of the schema's own options warns about nothing.

    One warning here means a check claims a valid deck is broken, which is
    the one failure mode that would teach a model to ignore the channel.
    """
    checked = 0
    for layout in _LAYOUTS:
        for element in _ELEMENTS:
            for padding in (None, 0, 5, 49.9):
                for page in (None, {"widthIn": 10, "heightIn": 5.625},
                             {"widthIn": 13.333, "heightIn": 7.5}):
                    for background in (None, "#ffffff"):
                        slide: dict[str, Any] = {
                            "elements": [{"id": "e1", "x": 5, "y": 5, "w": 40,
                                          "h": 10, **element}]
                        }
                        if layout is not None:
                            slide["layout"] = layout
                        if padding is not None:
                            slide["padding"] = padding
                        if background is not None:
                            slide["background"] = background
                        deck: dict[str, Any] = {"slides": [slide]}
                        if page is not None:
                            deck["page"] = page
                        assert lint_slides_data(
                            deck, ref_exists=lambda ref: True
                        ) == [], deck
                        checked += 1
    assert checked == 840


def test_the_structured_deck_sweep_stays_silent() -> None:
    """The same options with the derived layout instead of free elements."""
    checked = 0
    for layout in _LAYOUTS:
        for filled in ({"title": "제목"}, {"title": "제목", "bullets": ["a", "b"]},
                       {"title": "제목", "subtitle": "요약"},
                       {"title": "제목", "bullets": ["a"], "bullets2": ["b"]},
                       {"title": "제목", "image": "sources/photo.png"}):
            for notes in (None, "speaker notes"):
                for elements in (None, []):
                    slide: dict[str, Any] = dict(filled)
                    if layout is not None:
                        slide["layout"] = layout
                    if notes is not None:
                        slide["notes"] = notes
                    if elements is not None:
                        slide["elements"] = elements
                    assert lint_slides_data(
                        {"slides": [slide]}, ref_exists=lambda ref: True
                    ) == [], slide
                    checked += 1
    assert checked == 140


# --- the write/edit channel -------------------------------------------------------


def test_write_canvas_appends_the_layout_check_block() -> None:
    store = InMemoryCanvasStore()
    result = _write(store, {"slides": [{"elements": [
        {"id": "title", "type": "text", "x": 60, "y": 10, "w": 58, "h": 10, "text": "Hi"}
    ]}]})
    assert result.startswith("Wrote deck.slides.json")
    assert "Deck check:" in result
    assert 'element "title": x + w = 118' in result
    assert 'pages="grid"' in result


def test_write_canvas_stays_silent_for_a_clean_deck() -> None:
    store = InMemoryCanvasStore()
    result = _write(store, {"slides": [{"elements": [
        {"id": "t", "type": "text", "x": 10, "y": 10, "w": 50, "h": 10, "text": "Hi"}
    ]}]})
    assert "Deck check" not in result


def test_write_canvas_carries_the_schema_and_shadow_findings() -> None:
    """What an agent actually wrote in a run, checked at the save that made it."""
    store = InMemoryCanvasStore()
    result = _write(store, {"slides": [{
        "layout": "title+bullets",
        "title": "3분기 실적",
        "bullets": ["매출 128억", "신규 고객 24곳"],
        "elements": [
            {"type": "text", "x": 60, "y": 20, "w": 35, "h": 12,
             "text": "128억", "fontSize": 40, "stroke": "#333"}
        ],
    }]})
    assert result.startswith("Wrote deck.slides.json")  # the save still lands
    assert "Deck check:" in result
    assert "exporting it fails" in result
    assert '"id" is required' in result
    assert "'title', 'content', 'section'" in result
    assert '"stroke"' in result
    assert '"title", "bullets" are set next to "elements"' in result


def test_edit_canvas_lints_the_edited_deck() -> None:
    store = InMemoryCanvasStore()
    _write(store, {"slides": [{"elements": [
        {"id": "t", "type": "text", "x": 10, "y": 10, "w": 50, "h": 10, "text": "Hi"}
    ]}]})
    tools = _tools(store)
    revision = store.read("t1", "deck.slides.json").revision
    result = tools["edit_canvas"].func(
        path="deck.slides.json",
        old='"x": 10,',
        new='"x": 70,',
        description="move",
        revision=revision,
        runtime=_runtime(),
    )
    assert result.startswith("Edited deck.slides.json")
    assert "x + w = 120" in result


# --- padding: no crash, honest schema ---------------------------------------------


@pytest.mark.parametrize("padding", [50, 60, 100, -5])
def test_refit_survives_degenerate_padding(padding: float) -> None:
    data = {"slides": [{"padding": padding, "elements": [
        {"id": "t", "type": "text", "x": 10, "y": 10, "w": 50, "h": 10, "text": "Hi"}
    ]}]}
    # Must not raise; the degenerate slide is skipped, not mangled.
    _refit_slides_to_page(data, 10.0, 5.625, 10.0, 7.5)
    assert data["slides"][0]["elements"][0]["x"] == 10


def test_the_schema_refuses_degenerate_padding_honestly() -> None:
    with pytest.raises(ValidationError, match="less_than|less than"):
        SlidesData.model_validate({"slides": [{"padding": 60}]})
    assert SlidesData.model_validate({"slides": [{"padding": 5}]}).slides[0].padding == 5


def test_a_padded_deck_still_exports_and_validates() -> None:
    deck = SlidesData.model_validate(
        json.loads(encode_slides("D", {"slides": [{"padding": 6, "elements": []}]}))["data"]
    )
    assert deck.slides[0].padding == 6
