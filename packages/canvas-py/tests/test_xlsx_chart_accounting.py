"""Every chart the preview cannot draw is accounted for, so its pages are listed.

The grid places a picture only for a chart it found and could box. A chart object that
was found but got no box (no anchor cell, past the anchor budget, an error while placing
it), and a drawing the reader had to stop reading, each count as one unboxed chart: the
rendered pages that carry charts are then listed under the grid.
"""

from __future__ import annotations

import io

import openpyxl
import pytest
from openpyxl.drawing.image import Image
from test_xlsx_drawings import _chart_frame, _grp, _sp
from test_xlsx_gallery import _chart_workbook, _GalleryHost, _png, _preview, _save
from test_xlsx_placeholders import (
    _adding,
    _chartex_frame,
    _declared,
    _entries,
    _kinds,
    _two_cell,
    _with_drawing,
)

from langchain_canvas.replay import _PREVIEW_CACHE
from langchain_canvas.xlsx_drawings import MAX_OBJECT_CHARS, MAX_OBJECTS, MAX_TOTAL_CHARS


@pytest.fixture(autouse=True)
def _clear_preview_cache():
    _PREVIEW_CACHE.clear()
    yield
    _PREVIEW_CACHE.clear()


def _absolute_chartex() -> str:
    return _declared(
        '<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="3000000" cy="2000000"/>'
        f"{_chartex_frame()}<xdr:clientData/></xdr:absoluteAnchor>"
    )


def _image_ids(preview: dict) -> list[str]:
    return [image["id"] for image in preview["workbook"]["sheet"][0]["images"]]


# --- a chartex frame that got no box ----------------------------------------------------


def test_a_chartex_with_no_anchor_cell_is_counted_beside_an_ordinary_chart() -> None:
    data = _with_drawing(_chart_workbook(), _adding(_absolute_chartex()))

    assert _kinds(_entries(data)) == ["chart", "unboxed"]
    preview = _preview(data, _GalleryHost())

    assert _image_ids(preview) == ["chart_0"]
    assert preview["chartPages"] == [2]


def test_a_chartex_past_the_anchor_budget_is_counted() -> None:
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(["a", 1])
    png = _png()
    for row in range(1, 500):  # 499 pictures
        sheet.add_image(Image(io.BytesIO(png)), f"D{row}")
    chart_book = openpyxl.load_workbook(io.BytesIO(_chart_workbook()))
    sheet.add_chart(chart_book.worksheets[0]._charts[0], "A15")
    data = _with_drawing(_save(book), _adding(_two_cell(_chartex_frame(), (0, 40), (4, 46))))

    preview = _preview(data, _GalleryHost())

    assert "chart_0" in _image_ids(preview)  # the ordinary chart took the last anchor
    assert preview["chartPages"] == [2]


def test_a_chartex_that_cannot_be_placed_is_counted_once(monkeypatch) -> None:
    import langchain_canvas.xlsx_import as xlsx_import

    def _boom(anchor):
        raise ValueError("no box")

    monkeypatch.setattr(xlsx_import, "_anchor_of", _boom)
    data = _with_drawing(_chart_workbook(), _adding(_two_cell(_chartex_frame(), (0, 40), (4, 46))))

    assert _kinds(_entries(data)) == ["chart", "unboxed"]


def test_a_placed_chartex_adds_no_unboxed_entry() -> None:
    data = _with_drawing(_chart_workbook(), _adding(_two_cell(_chartex_frame(), (0, 40), (4, 46))))

    assert _kinds(_entries(data)) == ["chart", "unsupported"]
    assert _preview(data, _GalleryHost())["chartPages"] is None


def test_a_group_chart_is_counted_once_even_when_it_has_no_box() -> None:
    data = _with_drawing(
        _chart_workbook(), _adding(_two_cell(_grp("G", _chart_frame()), (0, 40), (4, 46)))
    )

    assert _kinds(_entries(data)).count("unboxed") == 1


# --- a drawing the reader stopped reading ------------------------------------------------


def _shapes(count: int, text: str) -> list[str]:
    return [_two_cell(_sp(f"S{n}", text), (0, 100 + n), (1, 101 + n)) for n in range(count)]


def _hidden_group_chart() -> str:
    return _two_cell(_grp("G", _chart_frame()), (0, 900), (4, 906))


def test_a_grouped_chart_after_the_text_cap_still_lists_the_chart_pages() -> None:
    wordy = _shapes(MAX_TOTAL_CHARS // MAX_OBJECT_CHARS + 1, "t" * MAX_OBJECT_CHARS)
    data = _with_drawing(_chart_workbook(), _adding(*wordy, _hidden_group_chart()))

    preview = _preview(data, _GalleryHost())

    assert _image_ids(preview) == ["chart_0"]
    assert preview["chartPages"] == [2]


def test_a_grouped_chart_after_the_object_cap_still_lists_the_chart_pages() -> None:
    data = _with_drawing(
        _chart_workbook(), _adding(*_shapes(MAX_OBJECTS, ""), _hidden_group_chart())
    )

    preview = _preview(data, _GalleryHost())

    assert _image_ids(preview) == ["chart_0"]
    assert preview["chartPages"] == [2]


def test_shapes_under_every_cap_keep_the_chart_pages_unlisted() -> None:
    data = _with_drawing(_chart_workbook(), _adding(*_shapes(5, "note")))

    assert _preview(data, _GalleryHost())["chartPages"] is None
