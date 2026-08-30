"""The text estimate, held to the golden cases the TypeScript twin reads."""

from __future__ import annotations

import json
from pathlib import Path

from langchain_canvas.slide_text import (
    MIN_FIT_SCALE,
    PAGE_W_PX,
    fit_scale,
    grown_height_pct,
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
