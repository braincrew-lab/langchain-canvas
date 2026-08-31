"""Grouping repeated page layouts and picking a deterministic medoid.

Builds :class:`PageInventory` records directly — these tests are about
grouping/medoid math over a census, not about the PDF/PPTX readers that
produce one (covered in ``test_source_inventory.py``).
"""

from __future__ import annotations

from langchain_canvas.deck.patterns import select_representatives
from langchain_canvas.deck.source_inventory import PageInventory, TextBoxCensus


def _page(number: int, title_x: float, body_x: float) -> PageInventory:
    boxes = (
        TextBoxCensus(x=title_x, y=0.05, w=0.5, h=0.1, text=f"Title {number}", role="title"),
        TextBoxCensus(x=body_x, y=0.30, w=0.7, h=0.4, text=f"Body {number}", role="body"),
    )
    return PageInventory(page_number=number, text_boxes=boxes, has_text=True)


def _cover_page(number: int) -> PageInventory:
    boxes = (TextBoxCensus(x=0.10, y=0.40, w=0.8, h=0.2, text=f"Cover {number}", role="title"),)
    return PageInventory(page_number=number, text_boxes=boxes, has_text=True)


# --- the medoid can be a later page, not the first occurrence ----------------------


def test_body_medoid_can_follow_cover_pages():
    pages = [
        _cover_page(1),
        _page(2, title_x=0.08, body_x=0.08),
        _page(5, title_x=0.10, body_x=0.10),
        _page(9, title_x=0.12, body_x=0.12),
    ]

    groups = select_representatives(pages)
    body_group = next(group for group in groups if "body" in group.roles)

    assert body_group.member_pages == (2, 5, 9)
    assert body_group.representative_page == 5


# --- an exact tie in box distance breaks toward the lowest page number ------------


def test_ties_are_deterministic():
    pages = [_page(7, title_x=0.10, body_x=0.10), _page(3, title_x=0.10, body_x=0.10)]

    groups = select_representatives(pages)

    assert len(groups) == 1
    assert groups[0].representative_page == 3
    assert groups[0].member_pages == (3, 7)


# --- a partial observation window never claims global coverage --------------------


def test_partial_scope_is_not_global_coverage():
    # Only pages 10-12 were ever inspected in this call — page 1 was never seen.
    pages = [_page(10, 0.10, 0.10), _page(11, 0.10, 0.10), _page(12, 0.30, 0.30)]

    groups = select_representatives(pages)

    all_member_pages = {page for group in groups for page in group.member_pages}
    assert all_member_pages <= {10, 11, 12}
    assert 1 not in all_member_pages
    assert not any(hasattr(group, "total_source_pages") for group in groups)
