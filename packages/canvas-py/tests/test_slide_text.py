"""The text estimate, held to the golden cases the TypeScript twin reads."""

from __future__ import annotations

import json
from pathlib import Path

from langchain_canvas.slide_text import (
    MIN_FIT_SCALE,
    PAGE_H_PX,
    PAGE_W_PX,
    fit_scale,
    grown_height_pct,
    metrics_page_px,
    wrapped_lines,
)

GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "canvas-react"
    / "src"
    / "client"
    / "slideText.golden.json"
)


def test_the_golden_cases_hold() -> None:
    """One estimate on both sides: the numbers in the golden file are what
    this module computes, and the TypeScript suite checks its twin against
    the same file."""
    cases = json.loads(GOLDEN.read_text())
    assert len(cases) >= 5
    for case in cases:
        text, size, w, h = case["text"], case["size"], case["w"], case["h"]
        leading = case.get("lineHeight")
        assert wrapped_lines(text, size, w / 100 * PAGE_W_PX) == case["lines"], case["name"]
        assert grown_height_pct(text, size, w, h, leading) == case["grownHeightPct"], case["name"]
        assert fit_scale(text, size, w, h, leading) == case["fitScale"], case["name"]


def test_a_growing_box_never_shrinks_below_its_own_height() -> None:
    assert grown_height_pct("hi", 24, 50, 30) == 30


def test_a_fit_stops_at_a_quarter() -> None:
    assert fit_scale("가" * 1000, 40, 10, 2) == MIN_FIT_SCALE


def test_the_classic_page_is_the_default_canvas() -> None:
    """Passing the 16:9 page explicitly measures exactly like passing none, so
    every page-less deck (and its golden) is unchanged."""
    assert metrics_page_px(None) == (PAGE_W_PX, PAGE_H_PX)
    assert metrics_page_px((10.0, 5.625)) == (PAGE_W_PX, PAGE_H_PX)


def test_a_malformed_page_falls_back_to_the_classic_canvas() -> None:
    assert metrics_page_px((0.0, 10.0)) == (PAGE_W_PX, PAGE_H_PX)
    assert metrics_page_px((-1.0, -1.0)) == (PAGE_W_PX, PAGE_H_PX)


def test_a_portrait_page_measures_on_a_taller_narrower_canvas() -> None:
    """A portrait page is narrower and taller, so its px canvas is too — the
    whole point of the metric being page-aware."""
    width_px, height_px = metrics_page_px((7.5, 10.0))
    assert height_px > width_px
    assert (width_px, height_px) == (7.5 * 128, 10.0 * 128)


def test_a_box_grows_differently_on_a_portrait_page() -> None:
    """The same text in the same percent box grows to a different share of the
    page once the page shape changes — landscape vs portrait are not the same
    box, and the old fixed-16:9 metric got the portrait case wrong."""
    long_text = "wrapping " * 40
    landscape = grown_height_pct(long_text, 24, 40, 3)
    portrait = grown_height_pct(long_text, 24, 40, 3, page=(7.5, 10.0))
    assert landscape > 3 and portrait > 3  # both grew past the box
    assert landscape != portrait
