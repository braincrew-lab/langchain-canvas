"""Real render gate (c): LibreOffice 25.2.3 (Docker arm64, image aa6d1c9ddcbe).

The repository exporters write ``.pptx`` / ``.docx`` files; the LOCAL Docker
image (referenced by ID, never tag) converts them to PDF with ``soffice``
(the exact production arguments of the evidence run,
``docwriter-render-evidence/local-render/scripts/03_render.sh``); pdfium
(``pypdfium2.raw``) extracts every glyph's tight box, font name and size plus
every drawn path's bounds, segment points, matrix and stroke width; the test
compares them with the frames the file itself declares. Every measurement is written to
``$CANVAS_PARITY_EVIDENCE_DIR/render/<stage>/<name>.measurements.json``.

Reporting label: "LibreOffice 25.2.3 (Docker arm64, image aa6d1c9ddcbe)".
Microsoft PowerPoint / Word native rendering is UNVERIFIED by this file; a
PASS here is a self-consistency proof of the written geometry, not a claim of
native-Office equivalence.

Switch vs fail-closed: ``CANVAS_OFFICE_RENDER_GATE=1`` only decides whether
CI *calls* this gate (CI has no Docker image). Once it is set, every
prerequisite — the image, ``soffice``, the font file and its sha256, pdfium,
the browser-written ``.docx`` — is asserted with ``pytest.fail``. No ``skip``,
``importorskip`` or ``xfail`` anywhere below this line.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

if os.environ.get("CANVAS_OFFICE_RENDER_GATE") != "1":
    pytest.skip(
        "opt-in gate: set CANVAS_OFFICE_RENDER_GATE=1 (local Docker image required)",
        allow_module_level=True,
    )

from office_render_support import (  # noqa: E402 — after the call switch, like the plan's module layout
    IMAGE_ID,
    TOL,
    _docker_bash,
    _glyph_run,
    connector_path_identity,
    marker_run_before,
    measure_deck,
    measure_document,
    render_to_pdf,
    table_grid_paths,
)

# --- constants (the recorded environment) -----------------------------------------

SOFFICE_VERSION = "25.2.3.2"
FONT_FAMILY = "Noto Sans CJK KR"
FONT_FILE_IN_IMAGE = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
PDF_FONT_NAME = "NotoSansCJKkr-Regular"  # what pdfium reports for the regular face
# The renderer's own list-marker face for a:buChar (LibreOffice: OpenSymbol).
# Allowed for positively matched bullet glyphs ONLY — never for body text.
MARKER_FONT_NAMES = {"OpenSymbol", PDF_FONT_NAME}
# pdfium raw names the measurement port calls; each must exist (R1), no skip.
PDFIUM_RAW_NAMES = (
    "FPDFText_GetCharBox",
    "FPDFText_GetFontInfo",
    "FPDFPath_CountSegments",
    "FPDFPath_GetPathSegment",
    "FPDFPathSegment_GetPoint",
    "FPDFPageObj_GetStrokeWidth",
    "FPDFPageObj_GetMatrix",
    "FPDFText_GetCharOrigin",
    # used by the same port beyond the plan's six: segment kind/close, draw mode
    "FPDFPathSegment_GetType",
    "FPDFPathSegment_GetClose",
    "FPDFPath_GetDrawMode",
)
LATIN_FALLBACK_FILE = "DejaVuSans.ttf"  # fc-match Calibri in the image
FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "canvas-react"
    / "src"
    / "export"
    / "__fixtures__"
    / "parity-deck.slides.json"
)
DOCUMENT_FIXTURE = FIXTURE.parent / "parity-document.md"  # written by task 10
PT_PER_IN = 72.0
PAGE_W_IN, PAGE_H_IN = 10.0, 5.625
PAGE_W_PT, PAGE_H_PT = PAGE_W_IN * PT_PER_IN, PAGE_H_IN * PT_PER_IN  # 720 x 405
METRIC_PAGE_W_PX = 960.0  # 96 dpi x 10 in — the basis U1 converges on

# Seed markdown for D3 until task 10 writes ``parity-document.md``: the same
# source the plan says that fixture is composed from (test_exporters.py
# markdown tests), carrying the bold run and the numbered item D3/D4 look for.
SEED_MARKDOWN = "\n".join(
    [
        "# 협업 제안서",
        "",
        "본 문서는 **브레인크루**와 *신한은행*의 협업 범위를 정리한다.",
        "이어지는 줄은 같은 문단이다.",
        "",
        "## 일정",
        "| 단계 | 기간 |",
        "|---|---|",
        "| 기획 | 2주 |",
        "| 개발 | 6주 |",
        "",
        "1. 첫째 항목",
        "2. 둘째 항목",
        "- 항목 A",
        "* 항목 B",
        "",
        "```",
        "uv run python -m app",
        "```",
        "",
        "---",
        "",
        "끝.",
    ]
)

# The HTML of the prereview's repro_docx_exporter.py (F8): stated column widths.
GRID_HTML = """
<h1>Grid check</h1>
<p>Three columns with stated widths.</p>
<table>
  <tr><th width="25%">A</th><th width="25%">B</th><th width="50%">C</th></tr>
  <tr><td>1</td><td>2</td><td>3</td></tr>
</table>
"""


# --- evidence directory -------------------------------------------------------------


def _evidence_dir() -> Path:
    value = os.environ.get("CANVAS_PARITY_EVIDENCE_DIR")
    if not value:
        pytest.fail("CANVAS_PARITY_EVIDENCE_DIR is not set — the gate has nowhere to write")
    return Path(value)


def _render_dir() -> Path:
    stage = os.environ.get("CANVAS_PARITY_RENDER_STAGE", "baseline")
    path = _evidence_dir() / "render" / stage
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write_json(name: str, payload: Any) -> Path:
    path = _render_dir() / f"{name}.measurements.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


# --- fixtures -----------------------------------------------------------------------


@pytest.fixture(scope="module")
def evidence() -> Path:
    return _evidence_dir()


@pytest.fixture(scope="module")
def deck_elements() -> list[dict[str, Any]]:
    envelope = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return envelope["data"]["slides"][0]["elements"]


@pytest.fixture(scope="module")
def parity_pptx(evidence: Path) -> tuple[Path, bytes]:
    from langchain_canvas.exporters import SlidesPptxExporter

    envelope = json.loads(FIXTURE.read_text(encoding="utf-8"))
    result = SlidesPptxExporter().export(json.dumps(envelope), path="parity.slides.json")
    path = _render_dir() / "parity.pptx"
    path.write_bytes(result.data)
    return path, result.data


@pytest.fixture(scope="module")
def deck_measure(
    parity_pptx: tuple[Path, bytes], deck_elements: list[dict[str, Any]]
) -> dict[str, Any]:
    path, data = parity_pptx
    pdf = render_to_pdf(path)
    measured = measure_deck(pdf, data, deck_elements)
    _write_json("parity", measured)
    return measured


def _element(elements: list[dict[str, Any]], element_id: str) -> dict[str, Any]:
    return next(e for e in elements if e["id"] == element_id)


def _frame_pt(element: dict[str, Any]) -> list[float]:
    return [
        element["x"] / 100 * PAGE_W_PT,
        element["y"] / 100 * PAGE_H_PT,
        element["w"] / 100 * PAGE_W_PT,
        element["h"] / 100 * PAGE_H_PT,
    ]


# --- R: the parity deck ---------------------------------------------------------------


def test_preflight_the_render_environment_is_the_recorded_one(evidence: Path) -> None:
    """R1 — the image, its soffice, its font resolution and the extracted font
    bytes are exactly the recorded ones; pdfium's raw API imports."""
    inspect = subprocess.run(
        ["docker", "image", "inspect", IMAGE_ID, "--format", "{{.Id}}"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert inspect.returncode == 0, inspect.stderr
    assert inspect.stdout.strip() == IMAGE_ID

    version = _docker_bash("soffice --version 2>/dev/null")
    assert SOFFICE_VERSION in version, version

    match = _docker_bash(f'fc-match "{FONT_FAMILY}"')
    assert match.startswith("NotoSansCJK-Regular.ttc"), match

    in_image = _docker_bash(f"sha256sum {FONT_FILE_IN_IMAGE}").split()[0]
    extracted = evidence / "fonts" / "NotoSansCJK-Regular.ttc"
    if not extracted.is_file():
        pytest.fail(f"{extracted} is missing — extract it from the image first (task 1)")
    assert hashlib.sha256(extracted.read_bytes()).hexdigest() == in_image

    import pypdfium2.raw as raw

    absent = [name for name in PDFIUM_RAW_NAMES if not hasattr(raw, name)]
    assert absent == [], f"pypdfium2.raw lacks {absent}"
    (evidence / "env").mkdir(exist_ok=True)
    (evidence / "env" / "render-gate-preflight.json").write_text(
        json.dumps(
            {
                "image_id": IMAGE_ID,
                "soffice": version.strip(),
                "fc_match": match.strip(),
                "font_sha256": in_image,
            },
            indent=1,
        ),
        encoding="utf-8",
    )


def test_every_text_shape_renders_in_the_named_font(deck_measure: dict[str, Any]) -> None:
    """R2 — every BODY glyph of every text shape is present and drawn by the
    named regular face (no bold, no exception); a paragraph's ``a:buChar``
    marker counts as a bullet glyph only when the glyph at its position IS
    that character (positive match) and may then be drawn by the renderer's
    marker face — one per ``a:buChar`` paragraph; nothing on the page is
    unaccounted for. Body text drawn by OpenSymbol is a real substitution and
    fails the body equality (see test_office_render_support.py)."""
    texts = {k: v for k, v in deck_measure["shapes"].items() if v.get("text")}
    assert texts, "no text shapes measured"
    for element_id, record in texts.items():
        assert record["coverage"] == 1.0, (element_id, record["coverage"])
        assert record["missing_glyphs"] == 0, (element_id, record["missing_glyphs"])
        assert record["bullet_mismatches"] == [], (element_id, record["bullet_mismatches"])
        assert set(record["pdf_fonts"]) == {PDF_FONT_NAME}, (element_id, record["pdf_fonts"])
        assert set(record["bullet_fonts"]) <= MARKER_FONT_NAMES, (
            element_id,
            record["bullet_fonts"],
        )
        assert record["bullet_glyph_count"] == len(record["bullets"]), (
            element_id,
            record["bullet_glyph_count"],
            record["bullets"],
        )
    assert deck_measure["unmatched_visible_glyphs"] == 0


def test_a_grown_spautofit_box_contains_its_text(
    deck_measure: dict[str, Any], deck_elements: list[dict[str, Any]]
) -> None:
    """R3 — the ``grow`` box is written at a height that actually holds its
    lines: glyphs inside the frame the file declares, the line count the
    estimator predicts for a 40 % box on the 96 dpi page, all on the page."""
    from langchain_canvas.slide_text import wrapped_lines

    grow = deck_measure["shapes"]["grow"]
    element = _element(deck_elements, "grow")
    assert grow["autofit"] == "spAutoFit"
    expected_lines = wrapped_lines(element["text"], element["fontSize"], 0.40 * METRIC_PAGE_W_PX)
    assert grow["glyph_union_inside_page"] is True
    assert grow["line_count"] == expected_lines, (grow["line_count"], expected_lines, grow["lines"])
    assert grow["h_contained_1pt"] and grow["v_contained_1pt"], grow["overflow_pt"]


@pytest.mark.parametrize("element_id", ["fit_latin", "fit_ko"])
def test_a_normautofit_box_contains_its_text(deck_measure: dict[str, Any], element_id: str) -> None:
    """R4 — a shrink-to-fit box keeps its glyphs inside its declared frame and
    the shrink actually fired (rendered size below the declared 18 pt). The
    ratio of rendered size to ``18 x fontScale`` is recorded, not asserted:
    LibreOffice applies its own reduction (evidence A1), native Office is
    UNVERIFIED."""
    record = deck_measure["shapes"][element_id]
    assert record["autofit"] == "normAutofit"
    declared = max(record["declared_size_pt"])
    rendered = max(record["pdf_font_sizes"])
    scale = int(record["fontScale"]) / 100000 if record["fontScale"] else None
    record["rendered_over_declared_scaled"] = (rendered / (declared * scale)) if scale else None
    _write_json("parity", deck_measure)
    assert record["contained_in_declared_frame"] is True, (
        element_id,
        record["overflow_pt"],
        record["missing_glyphs"],
    )
    assert rendered < 18.0, (element_id, rendered, record["fontScale"])


def test_the_overflow_control_overflows_only_downward(deck_measure: dict[str, Any]) -> None:
    """R5 — NEGATIVE CONTROL. ``overflow`` is an authored vertical overflow
    (8 lines in a 4 %-tall box, no autofit). It must overflow the frame
    bottom and nothing else, keep every glyph, stay on the page, and break
    only inside Hangul runs (the text has no spaces). Passing here proves the
    measurement can see an overflow; it does not stand in for R3/R4."""
    record = deck_measure["shapes"]["overflow"]
    assert record["autofit"] == "noAutofit"
    assert record["coverage"] == 1.0 and record["missing_glyphs"] == 0
    assert record["h_contained_1pt"] is True, record["overflow_pt"]
    assert record["v_contained_1pt"] is False, record["overflow_pt"]
    assert record["overflow_pt"]["bottom"] > 0
    assert record["glyph_union_inside_page"] is True, record["glyph_union_pt"]
    assert record["breaks"], "an 8-line box must break"
    assert all(b["kind"] == "intra-word:hangul" for b in record["breaks"]), record["break_kinds"]


def test_the_line_connector_renders_flat_at_its_box_thickness(
    deck_measure: dict[str, Any], deck_elements: list[dict[str, Any]]
) -> None:
    """R6 — identity (task 1b): the ONE two-point stroke path whose midpoint
    (segment points through the object's matrix, y flipped) is the file
    connector's midpoint within TOL. Assertions on that path: (i) its two
    endpoints are the file's ``begin``/``end`` within TOL, (ii) it is flat
    (``|y1 - y0| <= TOL``; the angle is recorded), (iii) its stroke width
    times the matrix's uniform scale is the file's line width within TOL.
    Path bounding boxes are recorded, never asserted: a stroked path's box
    carries caps/joins the geometry does not explain. A filled polygon or a
    non-uniform matrix at the midpoint fails inside the identity helper as a
    harness decision — the window is never widened. The ``rect`` element's
    drawn box is its fixture-derived frame."""
    file_connector = deck_measure["connector_pt"]
    line_width_pt = deck_measure["line_width_pt"]
    rendered = connector_path_identity(deck_measure["rendered_paths"], file_connector["mid"])
    deck_measure["connector_render"] = rendered
    _write_json("parity", deck_measure)
    (x0, y0), (x1, y1) = rendered["points_pt"]
    begin, end = file_connector["begin"], file_connector["end"]
    forward = abs(x0 - begin[0]) <= TOL and abs(y0 - begin[1]) <= TOL
    forward = forward and abs(x1 - end[0]) <= TOL and abs(y1 - end[1]) <= TOL
    backward = abs(x1 - begin[0]) <= TOL and abs(y1 - begin[1]) <= TOL
    backward = backward and abs(x0 - end[0]) <= TOL and abs(y0 - end[1]) <= TOL
    assert forward or backward, ("endpoints", rendered["points_pt"], "file", begin, end)
    assert abs(y1 - y0) <= TOL, ("drop_pt", rendered["drop_pt"], "angle_deg", rendered["angle_deg"])
    assert rendered["stroke_width_pt"] is not None, rendered
    assert abs(rendered["stroke_width_pt"] - line_width_pt) <= TOL, (
        rendered["stroke_width_pt"],
        line_width_pt,
    )
    rect = _frame_pt(_element(deck_elements, "rect"))
    boxes = deck_measure["rendered_path_boxes_pt"]
    rect_hits = [p for p in boxes if all(abs(p[i] - rect[i]) <= 1 for i in range(4))]
    assert rect_hits, ("rect frame", rect, "paths", boxes)


# --- D: Word files ----------------------------------------------------------------------


def _browser_docx(evidence: Path) -> Path:
    path = evidence / "parity-document.browser.docx"
    if not path.is_file():
        pytest.fail(
            f"{path} is missing — run exporters.test.ts with CANVAS_PARITY_EVIDENCE_DIR first "
            "(task 11 writes the browser Word file this gate renders)"
        )
    return path


def test_preflight_docx_font_substitution_is_the_recorded_one(evidence: Path) -> None:
    """D1 — the image substitutes Calibri with DejaVu Sans as recorded, and the
    browser-written Word file the D4 gate renders exists."""
    match = _docker_bash('fc-match "Calibri"')
    assert match.startswith(LATIN_FALLBACK_FILE), match
    _browser_docx(evidence)


def _table_lattice(measured: dict[str, Any]) -> dict[str, Any]:
    """The first page's table grid as the lattice of border strokes (docx-final):
    the wide horizontals whose ends meet verticals, plus those verticals — a
    paragraph rule is wide too but meets none. Recorded on ``measured``: the
    grid's pdfium bounds (``table_grid_paths_pt``, kept for comparison with
    earlier stages), its INK box (segment points widened by half the stroke —
    pdfium's bounds pad by the whole stroke, which is not ink; the R6
    precedent), its centre-line box and the other wide paths. The page's full
    path records are dropped from the JSON afterwards."""
    page = measured["pdf_pages"][0]
    lattice = table_grid_paths(page["paths"])
    measured["table_grid_paths_pt"] = [p["bbox_pt"] for p in lattice["grid"]]
    measured["table_grid_ink_pt"] = lattice["grid_ink_pt"]
    measured["table_grid_centreline_pt"] = lattice["centreline_pt"]
    measured["table_grid_line_caps"] = sorted({str(p["line_cap"]) for p in lattice["grid"]})
    measured["other_wide_paths_pt"] = [p["bbox_pt"] for p in lattice["other_wide"]]
    for entry in measured["pdf_pages"]:
        entry.pop("paths")
    return lattice


def test_the_python_html_docx_table_sits_inside_the_text_column() -> None:
    """D2 — the HTML door's table with stated column widths is drawn inside
    the text column the file's own section declares, at the grid width the
    file writes (468 pt = 9360 twips). The table is its border INK (segment
    points ± half the 0.5 pt stroke), the column stays ±1 pt."""
    from langchain_canvas.exporters import HtmlDocxExporter

    result = HtmlDocxExporter().export(GRID_HTML, path="parity-grid.html")
    path = _render_dir() / "parity-grid.docx"
    path.write_bytes(result.data)
    measured = measure_document(render_to_pdf(path), result.data)
    page = measured["pdf_pages"][0]
    lattice = _table_lattice(measured)
    measured.pop("glyphs")
    _write_json("parity-grid", measured)
    assert abs(page["size_pt"][0] - 612) <= 1 and abs(page["size_pt"][1] - 792) <= 1, page[
        "size_pt"
    ]
    left, right = measured["file_text_column_pt"]
    assert lattice["grid"], ("no table lattice (wide horizontals meeting verticals)", page)
    grid_left, _, grid_width, _ = measured["table_grid_ink_pt"]
    grid_right = grid_left + grid_width
    assert grid_right <= right + 1, (grid_right, right)
    assert grid_left >= left - 1, (grid_left, left)
    assert abs(grid_width - 468) <= 2, grid_width


def test_the_python_markdown_docx_keeps_text_inside_its_margins() -> None:
    """D3 — the markdown door declares 1 in margins on Letter and every glyph
    of the render sits inside that column; the bold run is drawn by a bold
    face. Input: ``parity-document.md`` (task 10) when present, else the seed
    markdown it is composed from."""
    from langchain_canvas.exporters import MarkdownDocxExporter

    source = (
        DOCUMENT_FIXTURE.read_text(encoding="utf-8")
        if DOCUMENT_FIXTURE.is_file()
        else SEED_MARKDOWN
    )
    result = MarkdownDocxExporter().export(source, path="parity-document.md")
    path = _render_dir() / "parity-document.py.docx"
    path.write_bytes(result.data)
    measured = measure_document(render_to_pdf(path), result.data)
    bold = _glyph_run(measured["glyphs"], "브레인크루")
    measured["bold_run_fonts"] = sorted({g["font"] for g in bold})
    measured["input"] = "fixture" if DOCUMENT_FIXTURE.is_file() else "seed"
    measured.pop("glyphs")
    _write_json("parity-document.py", measured)
    assert measured["file_margins_twips"] == {
        "left": 1440,
        "right": 1440,
        "top": 1440,
        "bottom": 1440,
    }, measured["file_margins_twips"]
    x, _, w, _ = measured["glyph_union_all_pages_pt"]
    assert x >= 71 and x + w <= 541, measured["glyph_union_all_pages_pt"]
    assert any("Bold" in font for font in measured["bold_run_fonts"]), measured["bold_run_fonts"]


def test_the_browser_word_file_keeps_its_blocks_when_rendered(evidence: Path) -> None:
    """D4 — the browser-written Word file keeps its bold run, its table and
    its numbered item through a real render. Depends on task 11's output;
    absent, this fails on its own without touching R1-R6/D2/D3."""
    from docx import Document

    source = _browser_docx(evidence)
    path = _render_dir() / "parity-document.browser.docx"
    path.write_bytes(source.read_bytes())
    document = Document(str(path))
    assert any(
        run.bold
        for paragraph in document.paragraphs
        for run in paragraph.runs
        if "브레인크루" in run.text
    )
    assert len(document.tables) == 1
    measured = measure_document(render_to_pdf(path), path.read_bytes())
    glyphs = measured["glyphs"]
    bold = _glyph_run(glyphs, "브레인크루")
    # The numbered item's marker is the "1." drawn right before the item's
    # own glyphs in the page stream — never a "1." from elsewhere (the nested
    # item, the code block). "Same baseline" is read at the glyph ORIGIN: the
    # tight box's bottom is not a baseline (the Hangul "목" descends ~1 pt
    # below the line the Latin digits sit on — final stage, 1.01 pt).
    item = _glyph_run(glyphs, "첫째 항목")
    number = marker_run_before(glyphs, "첫째 항목", "1.")
    measured["bold_run_fonts"] = sorted({g["font"] for g in bold})
    measured["numbered_item"] = {
        "marker_fonts": sorted({g["font"] for g in number}),
        "marker_origin_y": number[-1]["origin_y"],
        "item_origin_y": item[-1]["origin_y"],
        "marker_bottom": number[-1]["bottom"],
        "item_bottom": item[-1]["bottom"],
    }
    # The table grid: the lattice of border strokes (wide horizontals whose
    # ends meet verticals, plus those verticals). The fixture's ``---`` rule is
    # a paragraph border — wide, at nearly the same left x, but it meets no
    # vertical — so it lands in ``other_wide_paths_pt`` structurally, not by
    # how its x rounds.
    lattice = _table_lattice(measured)
    grid = lattice["grid"]
    wide = measured["table_grid_paths_pt"] + measured["other_wide_paths_pt"]
    measured.pop("glyphs")
    _write_json("parity-document.browser", measured)
    # The browser file declares the same page as the Python door and the
    # screen's Word page (U6): Letter, 1 in on every side — not the writer
    # library's default sheet.
    page = measured["pdf_pages"][0]
    width_pt, height_pt = page["size_pt"]
    assert abs(width_pt - 612) <= 1 and abs(height_pt - 792) <= 1, page["size_pt"]
    assert measured["file_margins_twips"] == {
        "left": 1440,
        "right": 1440,
        "top": 1440,
        "bottom": 1440,
    }, measured["file_margins_twips"]
    assert any("Bold" in font for font in measured["bold_run_fonts"]), measured["bold_run_fonts"]
    assert len(grid) >= 2, wide
    left, right = measured["file_text_column_pt"]
    ink_left, _, ink_width, _ = measured["table_grid_ink_pt"]
    assert ink_left >= left - 1, (measured["table_grid_ink_pt"], left)
    assert ink_left + ink_width <= right + 1, (measured["table_grid_ink_pt"], right)
    assert abs(number[-1]["origin_y"] - item[-1]["origin_y"]) < TOL, measured["numbered_item"]
    x, _, w, _ = measured["glyph_union_all_pages_pt"]
    assert x >= left - 1 and x + w <= right + 1, (measured["glyph_union_all_pages_pt"], left, right)
