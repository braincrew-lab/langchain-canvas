"""What a deck save changed, in the words the model reads (`slide_diff`)."""

from __future__ import annotations

from langchain_canvas.slide_diff import diff_slides, format_slide_diff


def _el(el_id: str, **fields: object) -> dict[str, object]:
    return {"id": el_id, "type": "text", "x": 10, "y": 10, "w": 30, "h": 12, **fields}


def _deck(*elements: dict[str, object], page: dict[str, object] | None = None) -> dict[str, object]:
    data: dict[str, object] = {"slides": [{"elements": list(elements)}]}
    if page is not None:
        data["page"] = page
    return data


def test_no_change_is_no_diff() -> None:
    deck = _deck(_el("a", text="Hi"))
    assert diff_slides(deck, deck) == []


def test_a_moved_element_reads_as_moved() -> None:
    before = _deck(_el("a", text="Hi", x=10, y=10))
    after = _deck(_el("a", text="Hi", x=25, y=10))
    changes = diff_slides(before, after)
    assert changes == ['slide 1, element "a" (text): moved (x 10→25)']


def test_a_resize_and_a_rotation_read_separately() -> None:
    before = _deck(_el("a", text="Hi", w=30, h=12))
    after = _deck(_el("a", text="Hi", w=40, h=12, rotation=15))
    line = diff_slides(before, after)[0]
    assert "resized (w 30→40)" in line
    assert "rotated (0→15)" in line


def test_text_change_is_summarised_not_dumped() -> None:
    before = _deck(_el("a", text="old title"))
    after = _deck(_el("a", text="a brand new and rather much longer title"))
    line = diff_slides(before, after)[0]
    assert "text " in line
    assert "…" in line  # the long side is capped, not pasted whole


def test_restyle_names_the_fields() -> None:
    before = _deck(_el("a", text="Hi", fontSize=24, fill="#ffffff"))
    after = _deck(_el("a", text="Hi", fontSize=28, fill="#eeeeee"))
    line = diff_slides(before, after)[0]
    assert "restyled" in line
    assert "fontSize 24→28" in line
    assert "fill #ffffff→#eeeeee" in line


def test_added_and_removed_elements() -> None:
    before = _deck(_el("a", text="Hi"))
    after = _deck(_el("a", text="Hi"), _el("b", text="New"))
    changes = diff_slides(before, after)
    assert 'slide 1, element "b" (text): added' in changes
    removed = diff_slides(after, before)
    assert 'slide 1, element "b" (text): removed' in removed


def test_reorder_is_reported_by_draw_rank_not_raw_index() -> None:
    before = _deck(_el("a"), _el("b"), _el("c"))
    after = _deck(_el("c"), _el("a"), _el("b"))  # c moved to the front
    changes = diff_slides(before, after)
    assert any('element "c"' in c and "reordered (z 3→1)" in c for c in changes)


def test_adding_one_element_does_not_read_as_reordering_the_rest() -> None:
    before = _deck(_el("a"), _el("b"))
    after = _deck(_el("x"), _el("a"), _el("b"))  # only x is new; a,b keep their order
    changes = diff_slides(before, after)
    assert any('element "x"' in c and "added" in c for c in changes)
    assert not any("reordered" in c for c in changes)


def test_float_noise_below_epsilon_is_not_a_move() -> None:
    before = _deck(_el("a", x=10.0, y=10.0))
    after = _deck(_el("a", x=10.02, y=9.99))  # a re-projection, not an edit
    assert diff_slides(before, after) == []


def test_slide_added_and_removed() -> None:
    before = {"slides": [{"elements": [_el("a")]}]}
    after = {"slides": [{"elements": [_el("a")]}, {"elements": [_el("b"), _el("c")]}]}
    assert "slide 2: added (2 elements)" in diff_slides(before, after)
    assert "slide 2: removed" in diff_slides(after, before)


def test_page_orientation_change_is_named() -> None:
    before = _deck(_el("a"), page={"widthIn": 10, "heightIn": 5.625})
    after = _deck(_el("a"), page={"widthIn": 7.5, "heightIn": 10})
    line = diff_slides(before, after)[0]
    assert "page:" in line
    assert "portrait" in line


def test_structured_slide_fields_diff() -> None:
    before = {"slides": [{"title": "Q3", "bullets": ["one"]}]}
    after = {"slides": [{"title": "Q4", "bullets": ["one", "two"]}]}
    changes = diff_slides(before, after)
    assert any("title" in c and "Q3" in c and "Q4" in c for c in changes)
    assert any("bullets changed" in c for c in changes)


def test_unreadable_input_yields_no_diff() -> None:
    assert diff_slides(None, {"slides": []}) == []
    assert diff_slides({"slides": "nope"}, {"slides": []}) == []


def test_format_wraps_only_when_there_is_something() -> None:
    assert format_slide_diff([]) == ""
    text = format_slide_diff(['slide 1, element "a" (text): moved (x 10→25)'])
    assert text.startswith("Changed since last save:")
    assert "- slide 1" in text
