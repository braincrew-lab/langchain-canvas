"""The pixel diff between two printed deck revisions (`slide_visual_diff`).

Decks are built here as raster PDFs with Pillow — no LibreOffice needed — so
what each test changes is visible in the test itself, and the suite runs
anywhere the pdf-images extra does.
"""

from __future__ import annotations

import io

import pytest

pytest.importorskip("pypdfium2")
pytest.importorskip("PIL")

from PIL import Image, ImageDraw

from langchain_canvas.slide_visual_diff import (
    MIN_CHANGED_RATIO,
    PageDiff,
    attribute_to_elements,
    compare_images,
    format_visual_diff,
    visual_diff_pdfs,
)

W, H = 640, 360


def _page(draw_extra=None) -> Image.Image:
    image = Image.new("RGB", (W, H), "#ffffff")
    draw = ImageDraw.Draw(image)
    draw.rectangle([40, 40, 240, 120], outline="#334455", width=3)
    draw.text((50, 60), "constant content", fill="#223344")
    if draw_extra:
        draw_extra(draw)
    return image


def _pdf(pages: list[Image.Image]) -> bytes:
    out = io.BytesIO()
    pages[0].save(out, format="PDF", save_all=True, append_images=pages[1:], resolution=96)
    return out.getvalue()


def test_only_the_changed_page_reads_as_changed() -> None:
    before = _pdf([_page(), _page(), _page()])
    after = _pdf([
        _page(),
        _page(lambda d: d.rectangle([400, 200, 560, 300], fill="#cc3333")),
        _page(),
    ])
    diffs = visual_diff_pdfs(before, after, workers=1)
    assert [d.page for d in diffs] == [1, 2, 3]
    assert not diffs[0].changed
    assert diffs[1].changed and diffs[1].ratio > 0.005
    assert not diffs[2].changed
    # the bbox lands on the region that was painted, not the whole page
    left, top, right, bottom = diffs[1].bbox
    width, height = diffs[1].size
    assert left / width > 0.5 and top / height > 0.4


def test_noise_below_the_tolerance_is_not_a_change() -> None:
    """A one-step intensity wobble — the kind a re-render produces — stays
    silent; a wrong 'changed' teaches the reader to ignore the channel."""
    base = _page()
    nudged = base.copy()
    pixels = nudged.load()
    r, g, b = pixels[10, 10]
    pixels[10, 10] = (min(255, r + 5), g, b)
    ratio, _ = compare_images(base, nudged)
    assert ratio == 0.0


def test_a_page_present_on_one_side_only_is_fully_changed() -> None:
    before = _pdf([_page()])
    after = _pdf([_page(), _page()])
    diffs = visual_diff_pdfs(before, after, workers=1)
    added = next(d for d in diffs if d.page == 2)
    assert added.ratio == 1.0 and added.bbox is None and added.changed


def test_parallel_and_sequential_agree() -> None:
    before = _pdf([_page() for _ in range(4)])
    after = _pdf([
        _page(),
        _page(lambda d: d.ellipse([100, 200, 200, 300], fill="#3366cc")),
        _page(),
        _page(lambda d: d.line([0, 0, W, H], fill="#000000", width=4)),
    ])
    sequential = visual_diff_pdfs(before, after, workers=1)
    parallel = visual_diff_pdfs(before, after, workers=4)
    assert [(d.page, d.ratio, d.bbox) for d in sequential] == [
        (d.page, d.ratio, d.bbox) for d in parallel
    ]
    assert [d.page for d in sequential if d.changed] == [2, 4]


def test_attribution_names_the_element_under_the_change() -> None:
    # changed region: right-bottom quadrant of a 1280x720 render
    diff = PageDiff(page=1, ratio=0.05, bbox=(800, 400, 1200, 700), size=(1280, 720))
    elements = [
        {"id": "title", "x": 5, "y": 5, "w": 60, "h": 12},        # top-left: miss
        {"id": "chart", "x": 55, "y": 50, "w": 40, "h": 40},      # overlaps: hit
    ]
    assert attribute_to_elements(diff, elements) == ["chart"]


def test_attribution_counts_a_rotated_element_by_its_painted_bounds() -> None:
    """A tall thin box turned 90° paints wide — the un-rotated bounds would
    miss a change it plainly covers."""
    diff = PageDiff(page=1, ratio=0.02, bbox=(0, 320, 1280, 400), size=(1280, 720))
    upright = {"id": "bar", "x": 47, "y": 10, "w": 6, "h": 80}
    turned = {**upright, "id": "bar90", "rotation": 90}
    wide_change_missing_the_upright_column = PageDiff(
        page=1, ratio=0.02, bbox=(0, 320, 500, 400), size=(1280, 720)
    )
    # upright column sits at x 47-53%; a change at x 0-39% misses it...
    assert attribute_to_elements(wide_change_missing_the_upright_column, [upright]) == []
    # ...but the same box turned 90° spans x 10-90% and is hit.
    assert attribute_to_elements(wide_change_missing_the_upright_column, [turned]) == ["bar90"]
    assert attribute_to_elements(diff, [upright, turned]) == ["bar", "bar90"]


def test_format_reads_as_one_voice_with_the_json_diff() -> None:
    diffs = [
        PageDiff(page=1, ratio=0.0, bbox=None, size=(10, 10)),
        PageDiff(page=2, ratio=0.066, bbox=(1, 1, 5, 5), size=(10, 10)),
    ]
    text = format_visual_diff(diffs, {2: ["title", "e3"]})
    assert text == 'visual: slide 2 changed 6.6% (elements "title", "e3")'
    assert format_visual_diff([diffs[0]]) == ""


def test_min_ratio_is_a_hair_above_zero() -> None:
    assert 0 < MIN_CHANGED_RATIO < 0.01
