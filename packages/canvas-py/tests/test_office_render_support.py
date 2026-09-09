"""Measurement-helper contract of ``office_render_support._shape_record`` (no Docker).

Plan §실제 렌더 게이트 R2, task 1b(a): the paragraph bullet the writer emits as
``a:buChar`` is drawn by the renderer's own marker face (LibreOffice:
OpenSymbol), which is NOT a body-font substitution. The helper must therefore
(1) classify a glyph as a bullet glyph only when it sits at the bullet's
position AND is the ``a:buChar`` character (positive match), (2) keep every
other glyph in the body set so a real substitution surfaces in ``pdf_fonts``,
and (3) count a character at the bullet position that is not the bullet as a
missing glyph. The page stream is synthetic; the shape is the one the real
exporter writes for the fixture's ``grow`` element.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest
from office_render_support import _shape_record
from pptx import Presentation

from langchain_canvas.exporters import SlidesPptxExporter

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "canvas-react"
    / "src"
    / "export"
    / "__fixtures__"
    / "parity-deck.slides.json"
)
BODY_FONT = "NotoSansCJKkr-Regular"
MARKER_FONT = "OpenSymbol"
BULLET = "•"
GLYPHS_PER_LINE = 16
GLYPH_ADVANCE_PT = 16.5
LINE_PITCH_PT = 19.8
PAGE_SIZE_PT = [720.0, 405.0]


@pytest.fixture(scope="module")
def grow() -> tuple[Any, dict[str, Any]]:
    """The exported ``grow`` shape (one ``a:buChar`` paragraph) and its element."""
    envelope = json.loads(FIXTURE.read_text(encoding="utf-8"))
    elements = envelope["data"]["slides"][0]["elements"]
    result = SlidesPptxExporter().export(json.dumps(envelope), path="parity.slides.json")
    deck = Presentation(io.BytesIO(result.data))
    (slide,) = deck.slides
    shapes = list(slide.shapes)
    assert len(shapes) == len(elements)
    index = next(i for i, e in enumerate(elements) if e["id"] == "grow")
    return shapes[index], elements[index]


def _glyph(index: int, ch: str, font: str) -> dict[str, Any]:
    """One visible glyph laid out like the baseline render: the marker slot
    (index 0) hangs left of the column, the body fills 16 glyphs a line."""
    line, column = divmod(index - 1, GLYPHS_PER_LINE) if index else (0, -1)
    left = 36.0 + column * GLYPH_ADVANCE_PT
    top = 23.0 + line * LINE_PITCH_PT
    return {
        "i": index,
        "ch": ch,
        "left": left,
        "right": left + GLYPH_ADVANCE_PT,
        "top": top,
        "bottom": top + 16.0,
        "font": font,
        "size": 18.0,
        "visible": True,
    }


def _page(chars: str, fonts: list[str]) -> dict[str, Any]:
    assert len(chars) == len(fonts)
    glyphs = [_glyph(i, ch, font) for i, (ch, font) in enumerate(zip(chars, fonts, strict=True))]
    return {"page": 1, "size_pt": PAGE_SIZE_PT, "paths_pt": [], "glyphs": glyphs}


def _record(grow: tuple[Any, dict[str, Any]], chars: str, fonts: list[str]) -> dict[str, Any]:
    shape, element = grow
    page = _page(chars, fonts)
    stream = "".join(g["ch"] for g in page["glyphs"])
    used = [False] * len(page["glyphs"])
    return _shape_record(shape, element, page, used, stream)


def test_a_body_glyph_drawn_by_opensymbol_is_reported_in_pdf_fonts(
    grow: tuple[Any, dict[str, Any]],
) -> None:
    """(a) A body Hangul glyph drawn by OpenSymbol is a real substitution: it
    must land in ``pdf_fonts`` (so R2's strict body-font equality fails), while
    the matched bullet stays apart in ``bullet_fonts``."""
    body = "가" * 40
    fonts = [MARKER_FONT] + [BODY_FONT] * 40
    fonts[6] = MARKER_FONT  # one body glyph substituted

    record = _record(grow, BULLET + body, fonts)

    assert MARKER_FONT in record["pdf_fonts"], record["pdf_fonts"]
    assert set(record["pdf_fonts"]) != {BODY_FONT}
    assert record["bullet_fonts"] == [MARKER_FONT]
    assert record["bullet_glyph_count"] == 1
    assert record["bullet_mismatches"] == []
    assert record["coverage"] == 1.0 and record["missing_glyphs"] == 0


def test_the_matched_bullet_keeps_the_marker_font_apart_from_the_body(
    grow: tuple[Any, dict[str, Any]],
) -> None:
    """(b) All-Noto body with an OpenSymbol bullet at the bullet position:
    the body set is exactly the named face; the marker is classified by
    position AND character, counted once per ``a:buChar`` paragraph."""
    body = "가" * 40
    fonts = [MARKER_FONT] + [BODY_FONT] * 40

    record = _record(grow, BULLET + body, fonts)

    assert record["pdf_fonts"] == [BODY_FONT]
    assert record["bullet_fonts"] == [MARKER_FONT]
    assert record["bullet_glyph_count"] == len(record["bullets"]) == 1
    assert record["bullet_mismatches"] == []
    assert record["coverage"] == 1.0 and record["missing_glyphs"] == 0
    assert record["matched_glyphs"] == 41 and record["n_visible_chars"] == 41
    assert record["line_count"] == 3 and record["lines"][0] == "가" * GLYPHS_PER_LINE


def test_a_marker_that_is_not_the_buchar_counts_as_missing(
    grow: tuple[Any, dict[str, Any]],
) -> None:
    """(c) A ``-`` at the bullet position is not the ``a:buChar`` (``•``): it
    is neither a bullet glyph nor body text, so the bullet is missing and the
    coverage drops below 1 — the body itself still matches in its own face."""
    body = "가" * 40
    fonts = [MARKER_FONT] + [BODY_FONT] * 40

    record = _record(grow, "-" + body, fonts)

    assert record["missing_glyphs"] >= 1
    assert record["coverage"] < 1.0
    assert record["bullet_fonts"] == []
    assert record["bullet_glyph_count"] == 0
    assert record["bullet_mismatches"] == [{"expected": BULLET, "found": "-"}]
    assert record["pdf_fonts"] == [BODY_FONT]
    assert record["matched_glyphs"] == 40


# --- D2 / D4 (docx-final): table borders as ink, the grid as a lattice, the
# numbered marker as the run before its item ------------------------------------
#
# LibreOffice 25.2.3 draws Word table borders as 0.5 pt STROKED two-point
# paths; pdfium's path bounds pad such a path by its full stroke width on every
# side (a 0.5 pt line reports a 1.0 pt tall box — final/parity-grid.pdf), so a
# bounds-based edge is 0.25 pt of non-ink per side. The R6 identity already
# reads segment points instead of bounds for the same reason; these helpers do
# the same for the table: the ink box is the points widened by half the stroke.
# The grid is the lattice — horizontals whose ends meet verticals — so a
# paragraph rule at the same left x is never mistaken for a table line.

from office_render_support import (  # noqa: E402
    marker_run_before,
    stroke_ink_box_pt,
    table_grid_paths,
)


def _stroke(points: list[list[float]], stroke_pt: float, cap: int | None = 0) -> dict[str, Any]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {
        "bbox_pt": [
            min(xs) - stroke_pt,
            min(ys) - stroke_pt,
            max(xs) - min(xs) + 2 * stroke_pt,
            max(ys) - min(ys) + 2 * stroke_pt,
        ],
        "matrix": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        "uniform_scale": 1.0,
        "stroke_width_raw": stroke_pt,
        "stroke_width_pt": stroke_pt,
        "stroked": True,
        "fill_mode": 0,
        "line_cap": cap,
        "segments": [
            {"type": 2 if i == 0 else 0, "close": False, "point_pt": list(p)}
            for i, p in enumerate(points)
        ],
    }


def test_a_stroked_path_ink_box_is_its_points_widened_by_half_the_stroke() -> None:
    # The browser table's top border as rendered: points 72.05..540.55 at y 207.85,
    # stroke 0.5, butt caps → ink exactly along the points, ±0.25 across.
    top = _stroke([[72.05, 207.85], [540.55, 207.85]], 0.5, cap=0)
    assert stroke_ink_box_pt(top) == [72.05, 207.6, 468.5, 0.5]
    # Square caps extend the ink along the line by half the stroke as well.
    square = _stroke([[72.05, 207.85], [540.55, 207.85]], 0.5, cap=2)
    assert stroke_ink_box_pt(square) == [71.8, 207.6, 469.0, 0.5]
    # Unknown cap → the conservative (square-cap) box, never the narrower one.
    unknown = _stroke([[72.05, 207.85], [540.55, 207.85]], 0.5, cap=None)
    assert stroke_ink_box_pt(unknown) == [71.8, 207.6, 469.0, 0.5]
    # A filled polygon is not a stroke: no ink box from this helper.
    filled = dict(top, stroked=False, fill_mode=1)
    assert stroke_ink_box_pt(filled) is None


def test_the_table_grid_is_the_lattice_of_lines_joined_by_verticals_not_the_rule() -> None:
    # The browser file's page 1 as rendered: 4 horizontals + 4 verticals at
    # y 207..253, and the fixture's ``---`` paragraph rule at y 459.8 whose left
    # end (72.0) rounds to the SAME integer as the table's (72.05 / 72.55).
    horizontals = [
        _stroke([[72.05, 207.85], [540.55, 207.85]], 0.5),
        _stroke([[72.55, 222.65], [540.05, 222.65]], 0.5),
        _stroke([[72.55, 237.55], [540.05, 237.55]], 0.5),
        _stroke([[72.05, 252.35], [540.55, 252.35]], 0.5),
    ]
    verticals = [
        _stroke([[72.3, 207.6], [72.3, 252.6]], 0.5),
        _stroke([[228.3, 208.1], [228.3, 252.1]], 0.5),
        _stroke([[384.3, 208.1], [384.3, 252.1]], 0.5),
        _stroke([[540.3, 207.6], [540.3, 252.6]], 0.5),
    ]
    rule = _stroke([[539.95, 459.8], [72.0, 459.8]], 0.75)
    short = _stroke([[72.0, 600.0], [200.0, 600.0]], 0.5)
    found = table_grid_paths(horizontals + [rule] + verticals + [rule, short])
    assert found["grid"] == horizontals + verticals
    assert found["other_wide"] == [rule, rule]
    ink = found["grid_ink_pt"]
    assert ink == [72.05, 207.6, 468.5, 45.0], ink  # union of the grid's (butt-capped) ink boxes
    assert found["centreline_pt"] == [72.3, 207.85, 468.0, 44.5]  # verticals' x, horizontals' y


def test_the_table_grid_is_empty_without_a_lattice() -> None:
    rule = _stroke([[539.95, 459.8], [72.0, 459.8]], 0.75)
    found = table_grid_paths([rule])
    assert found["grid"] == []
    assert found["other_wide"] == [rule]
    assert found["grid_ink_pt"] is None and found["centreline_pt"] is None


def _glyphs(stream: str) -> list[dict[str, Any]]:
    return [
        {
            "i": i,
            "ch": ch,
            "left": float(i),
            "right": i + 1.0,
            "top": 0.0,
            "bottom": 10.0,
            "origin_y": 9.0,
            "font": "F",
            "size": 12.0,
            "visible": True,
        }
        for i, ch in enumerate(stream)
    ]


def test_the_numbered_marker_is_the_run_right_before_its_item() -> None:
    # The rendered stream (final/parity-document.browser.pdf, no spaces): the
    # level-1 "1." precedes "첫째항목"; a nested "1." precedes "하위번호".
    glyphs = _glyphs("6주미정항목1.첫째항목2.둘째항목1.하위번호")
    marker = marker_run_before(glyphs, "첫째 항목", "1.")
    assert [g["i"] for g in marker] == [6, 7]
    nested = marker_run_before(glyphs, "하위 번호", "1.")
    assert [g["i"] for g in nested] == [18, 19]
    # A "1." elsewhere in the stream never stands in for a marker that is not there.
    with pytest.raises(pytest.fail.Exception):
        marker_run_before(_glyphs("1.x둘째항목"), "둘째 항목", "1.")
