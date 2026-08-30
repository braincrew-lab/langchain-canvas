"""The deck's map: one line per slide, every element addressed."""

from __future__ import annotations

from langchain_canvas import encode_slides
from langchain_canvas.deck_outline import deck_outline


def test_the_outline_names_every_element_with_its_id_size_and_text() -> None:
    deck = encode_slides("05_Connect", {
        "template": "sources/x.pptx",
        "slides": [
            {"elements": [
                {"id": "e0", "type": "text", "x": 5, "y": 5, "w": 54, "h": 12, "fontSize": 88,
                 "text": "왜 지금 브레인크루 X 신한은행인가 — 아주 긴 제목이 계속 이어집니다"},
                {"id": "e1", "type": "image", "x": 0, "y": 0, "w": 100, "h": 100,
                 "src": "assets/x/a.jpg"},
                {"id": "e2", "type": "shape", "shape": "rect", "x": 1, "y": 1, "w": 10, "h": 10},
            ]},
            {"layout": "title", "title": "Thank You", "subtitle": "Q&A"},
        ],
    })
    out = deck_outline(deck)
    assert out is not None
    assert out.startswith("deck: 05_Connect — 2 slide(s), template sources/x.pptx")
    assert '[s1] 3 elements: e0 text 88px 54x12 "왜 지금 브레인크루 X 신한은행인가 — 아주' in out
    assert "…\"" in out  # the head is cut, never the whole title
    assert "e1 image 100x100 assets/x/a.jpg" in out
    assert "e2 rect 10x10" in out
    assert '[s2] structured: layout title, title "Thank You", subtitle "Q&A"' in out
    assert "search for it to edit" in out


def test_a_file_that_is_not_a_deck_has_no_outline() -> None:
    assert deck_outline("# notes") is None
    assert deck_outline('{"type": "table", "data": {}}') is None


def test_read_canvas_puts_the_outline_before_the_json() -> None:
    import sys

    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    from test_tools import _runtime

    from langchain_canvas.store import InMemoryCanvasStore
    from langchain_canvas.tools import create_canvas_tools

    store = InMemoryCanvasStore()
    deck = encode_slides("D", {"slides": [{"title": "Hi", "layout": "title"}]})
    store.write("t1", "deck.slides.json", deck, "w")
    tools = {t.name: t for t in create_canvas_tools(store)}
    text = tools["read_canvas"].func(path="deck.slides.json", runtime=_runtime(thread_id="t1"))
    assert "deck: D — 1 slide(s)" in text
    assert text.index("deck: D") < text.index('"type": "slides"')
    later = tools["read_canvas"].func(
        path="deck.slides.json", runtime=_runtime(thread_id="t1"), offset=3
    )
    assert "deck: D" not in later  # the map rides the first page only


def test_a_table_is_one_line_with_its_grid_and_first_row() -> None:
    import json

    from langchain_canvas.deck_outline import deck_outline

    content = json.dumps({"type": "slides", "title": "D", "data": {"slides": [{"elements": [
        {"id": "t3", "type": "table", "x": 10, "y": 30, "w": 80, "h": 40,
         "rows": [["Item", "Q1", "Q2"], ["Sales", "120", "135"]]},
    ]}]}})
    outline = deck_outline(content)
    assert outline is not None
    assert '[s1] 1 elements: t3 table 2x3 80x40 "Item | Q1 | Q2"' in outline


def test_the_outline_says_which_boxes_grow_or_shrink() -> None:
    deck = encode_slides("d", {"slides": [{"elements": [
        {"id": "e0", "type": "text", "x": 5, "y": 5, "w": 50, "h": 10, "fontSize": 24,
         "text": "grows", "autofit": "shape"},
        {"id": "e1", "type": "text", "x": 5, "y": 20, "w": 50, "h": 10, "fontSize": 24,
         "text": "shrinks", "autofit": "text"},
        {"id": "e2", "type": "text", "x": 5, "y": 40, "w": 50, "h": 10, "fontSize": 24,
         "text": "fixed"},
    ]}]})
    out = deck_outline(deck)
    assert out is not None
    assert 'e0 text 24px grows 50x10 "grows"' in out
    assert 'e1 text 24px shrinks 50x10 "shrinks"' in out
    assert 'e2 text 24px 50x10 "fixed"' in out
    assert "`grows` marks a box that takes its text's height" in out
