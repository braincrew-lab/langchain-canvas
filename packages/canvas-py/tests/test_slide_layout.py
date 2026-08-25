"""The derived slide layout: what a structured slide turns into.

Two things are pinned here. The behaviour — a body block fills its band, an
overfull slide stays on the page, one size is chosen per slide — and the
*shared golden fixture*, which the TypeScript twin is held to by its own
suite. Change the layout on one side only and one of the two suites fails.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from langchain_canvas.protocol.artifacts import Slide, SlidePage
from langchain_canvas.slide_layout import (
    BODY_BOTTOM,
    BODY_RAMP,
    BODY_TOP,
    FONT_DISPLAY,
    FONT_TITLE,
    derive_elements,
    resolve_elements,
)

GOLDEN_PATH = (
    Path(__file__).resolve().parents[2]
    / "canvas-react"
    / "src"
    / "client"
    / "derivedLayout.golden.json"
)

SCALE = {FONT_DISPLAY, FONT_TITLE, *BODY_RAMP}


def deck_slide(**fields: object) -> Slide:
    return Slide.model_validate(fields)


def bullets_of(slide: Slide, page: SlidePage | None = None):
    return [e for e in derive_elements(slide, page) if e.id.startswith("bul")]


def _golden_cases() -> list[dict[str, Any]]:
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def test_every_golden_case_stays_on_the_page() -> None:
    """The boundary the layout owes every caller, pinned case by case.

    Nothing off the page, no zero-sized box, no two bullets on top of each
    other. The save-time check cannot make up for a layout that breaks this:
    a slide's coordinates are ours, not the agent's, so a violation here is
    a defect the agent has no way to fix.
    """
    for case in _golden_cases():
        elements = case["elements"]
        for element in elements:
            where = f'{case["name"]}: {element["id"]}'
            assert element["x"] >= -0.01, where
            assert element["y"] >= -0.01, where
            assert element["x"] + element["w"] <= 100.01, where
            assert element["y"] + element["h"] <= 100.01, where
            assert element["w"] > 0 and element["h"] > 0, where
        bullets = [e for e in elements if e["id"].startswith("bul_")]
        for previous, following in zip(bullets, bullets[1:], strict=False):
            assert following["y"] >= previous["y"] + previous["h"] - 0.01, case["name"]


def test_the_golden_fixture_matches_this_implementation() -> None:
    """The fixture the TypeScript twin is also held to."""
    cases = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    assert cases, "the golden fixture is empty"
    for case in cases:
        page = SlidePage.model_validate(case["page"]) if case.get("page") else None
        produced = [
            {
                key: (round(value, 6) if isinstance(value, float) else value)
                for key, value in element.model_dump(by_alias=True, exclude_none=True).items()
            }
            for element in derive_elements(Slide.model_validate(case["slide"]), page)
        ]
        assert produced == case["elements"], case["name"]


def test_explicit_elements_win_over_derivation() -> None:
    slide = deck_slide(
        title="ignored",
        elements=[{"id": "e1", "type": "text", "x": 1, "y": 2, "w": 3, "h": 4, "text": "kept"}],
    )
    assert [e.id for e in resolve_elements(slide)] == ["e1"]


def test_a_slide_with_no_elements_derives_its_own() -> None:
    assert [e.id for e in resolve_elements(deck_slide(title="T"))] == ["title"]


def test_ids_are_stable_across_calls() -> None:
    slide = deck_slide(title="T", bullets=["a", "b"])
    assert [e.id for e in derive_elements(slide)] == [e.id for e in derive_elements(slide)]


@pytest.mark.parametrize("count", [3, 4, 5, 6, 8, 10])
def test_a_body_block_reaches_the_bottom_of_its_band(count: int) -> None:
    """The dead strip under the bullets is the band's margin, not an accident."""
    slide = deck_slide(title="Heading", bullets=[f"point {i}" for i in range(count)])
    bullets = bullets_of(slide)
    assert len(bullets) == count
    assert bullets[-1].y + bullets[-1].h == pytest.approx(BODY_BOTTOM, abs=0.01)


@pytest.mark.parametrize("count", [1, 2, 3, 4, 6, 9, 14, 25, 40])
def test_no_bullet_ever_leaves_the_page(count: int) -> None:
    """The fixed pitch this replaced walked off the bottom past eight bullets."""
    slide = deck_slide(title="Heading", bullets=[f"point {i}" for i in range(count)])
    for element in bullets_of(slide):
        assert element.y >= 0
        assert element.y + element.h <= 100.0 + 0.01


@pytest.mark.parametrize("count", [1, 2, 3, 4, 6, 9, 14, 25])
def test_bullets_never_overlap_while_the_slide_still_fits(count: int) -> None:
    slide = deck_slide(title="Heading", bullets=[f"point {i}" for i in range(count)])
    bullets = bullets_of(slide)
    for previous, following in zip(bullets, bullets[1:], strict=False):
        assert following.y >= previous.y + previous.h - 0.01


def test_one_size_serves_every_bullet_on_a_slide() -> None:
    """Same fontSize in the file, same size on the screen — the whole point."""
    slide = deck_slide(
        title="Mixed lengths",
        bullets=[
            "short",
            "a bullet long enough that it has to wrap onto a second line inside its box",
            "another short one",
        ],
    )
    assert len({e.font_size for e in bullets_of(slide)}) == 1


def test_a_wrapping_bullet_gets_a_box_tall_enough_for_both_lines() -> None:
    long_text = "a bullet long enough that it has to wrap onto a second line inside its box"
    slide = deck_slide(title="T", bullets=["short", long_text])
    short_box, long_box = bullets_of(slide)
    assert long_box.h == pytest.approx(short_box.h * 2)


def test_the_body_ramp_steps_down_as_a_slide_fills() -> None:
    sparse = bullets_of(deck_slide(title="T", bullets=["a", "b", "c"]))[0]
    dense = bullets_of(deck_slide(title="T", bullets=[f"item {i}" for i in range(12)]))[0]
    assert sparse.font_size == BODY_RAMP[0]
    assert dense.font_size is not None and sparse.font_size is not None
    assert dense.font_size < sparse.font_size


def test_every_derived_size_sits_on_the_type_scale() -> None:
    slides = [
        deck_slide(layout="title", title="Cover", subtitle="Sub"),
        deck_slide(layout="section", title="Part two"),
        deck_slide(title="Heading", subtitle="Under it", bullets=["a", "b", "c"]),
        deck_slide(layout="two-column", title="T", bullets=["a"], bullets2=["b", "c"]),
        *[
            deck_slide(title="T", bullets=[f"item {i}" for i in range(n)])
            for n in (1, 3, 5, 8, 12, 20)
        ],
    ]
    sizes = {e.font_size for slide in slides for e in derive_elements(slide) if e.font_size}
    assert sizes <= SCALE, sizes - SCALE


def test_a_subtitle_on_a_content_slide_is_drawn() -> None:
    """It used to vanish: the layout drew the title and the bullets, nothing else."""
    slide = deck_slide(title="Heading", subtitle="A line under it", bullets=["a"])
    ids = [e.id for e in derive_elements(slide)]
    assert ids[:2] == ["title", "subtitle"]


def test_a_subtitle_pushes_the_bullets_below_itself() -> None:
    slide = deck_slide(title="Heading", subtitle="A line under it", bullets=["a", "b"])
    elements = {e.id: e for e in derive_elements(slide)}
    assert elements["bul_0"].y >= elements["subtitle"].y + elements["subtitle"].h


def test_a_wrapping_title_pushes_the_body_down() -> None:
    short = deck_slide(title="Short", bullets=["a", "b", "c", "d", "e", "f"])
    long = deck_slide(
        title="A heading long enough that it has to wrap onto a second line to fit the box",
        bullets=["a", "b", "c", "d", "e", "f"],
    )
    assert bullets_of(long)[0].y > bullets_of(short)[0].y


def test_both_columns_share_one_size() -> None:
    slide = deck_slide(
        layout="two-column",
        title="Compare",
        bullets=["one"],
        bullets2=[f"a longer line number {i}" for i in range(8)],
    )
    sizes = {e.font_size for e in derive_elements(slide) if e.id.startswith("bul")}
    assert len(sizes) == 1


def test_a_cover_centres_its_title_and_subtitle() -> None:
    elements = derive_elements(deck_slide(layout="title", title="Cover", subtitle="Sub"))
    top = min(e.y for e in elements)
    bottom = max(e.y + e.h for e in elements)
    assert top == pytest.approx(100.0 - bottom, abs=0.01)


def test_an_image_fills_the_band_under_the_heading() -> None:
    slide = deck_slide(layout="image", title="T", image="a.png")
    elements = {e.id: e for e in derive_elements(slide)}
    assert elements["img"].y == pytest.approx(BODY_TOP)
    assert elements["img"].y + elements["img"].h == pytest.approx(BODY_BOTTOM)


def test_a_taller_page_gets_shorter_boxes_in_percent() -> None:
    """Percent geometry means a line box depends on the page it sits on."""
    slide = deck_slide(title="T", bullets=["one"])
    classic = bullets_of(slide)[0]
    four_by_three = bullets_of(slide, SlidePage(widthIn=10.0, heightIn=7.5))[0]
    assert four_by_three.h < classic.h


def test_a_malformed_page_falls_back_to_the_classic_canvas() -> None:
    slide = deck_slide(title="T", bullets=["one"])
    broken = SlidePage.model_construct(width_in=0.0, height_in=0.0)
    assert bullets_of(slide, broken)[0].h == bullets_of(slide)[0].h


def test_an_empty_slide_derives_nothing() -> None:
    assert derive_elements(deck_slide()) == []
