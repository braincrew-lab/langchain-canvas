"""Every chart the preview cannot draw is accounted for, so its pages are listed.

The grid places a picture only for a chart it found and could box. A chart object that
was found but got no box (no anchor cell, past the anchor budget, an error while placing
it), and a drawing the reader had to stop reading, each count as one unboxed chart: the
rendered pages that carry charts are then listed under the grid.
"""

from __future__ import annotations

import io
import re
import zipfile

import openpyxl
import pytest
from openpyxl.drawing.image import Image
from test_xlsx_drawings import _MAIN, _R, _chart_frame, _grp, _sp
from test_xlsx_drawings_caps import _pic
from test_xlsx_gallery import (
    _bar_chart,
    _chart_workbook,
    _fill,
    _GalleryHost,
    _png,
    _preview,
    _save,
)
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


def test_a_group_chart_is_counted_once_when_it_has_no_box() -> None:
    absolute = _declared(
        '<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="3000000" cy="2000000"/>'
        f"{_grp('G', _chart_frame())}<xdr:clientData/></xdr:absoluteAnchor>"
    )
    data = _with_drawing(_chart_workbook(), _adding(absolute))

    assert _kinds(_entries(data)) == ["chart", "unboxed"]


def test_a_placed_group_chart_gets_a_notice_box_and_one_unboxed_entry() -> None:
    data = _with_drawing(
        _chart_workbook(), _adding(_two_cell(_grp("G", _chart_frame()), (0, 40), (4, 46)))
    )

    assert _kinds(_entries(data)) == ["chart", "unsupported", "unboxed"]


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


def test_a_chart_after_a_picture_at_the_object_cap_still_lists_the_chart_pages() -> None:
    members = [_sp(f"S{n}", "") for n in range(MAX_OBJECTS)]
    group = _two_cell(_grp("G", *members, _pic(), _chart_frame()), (0, 900), (4, 906))
    data = _with_drawing(_chart_workbook(), _adding(group))

    preview = _preview(data, _GalleryHost())

    assert _image_ids(preview) == ["chart_0"]
    assert preview["chartPages"] == [2]


def test_a_chart_after_a_picture_at_the_text_cap_still_lists_the_chart_pages() -> None:
    count = MAX_TOTAL_CHARS // MAX_OBJECT_CHARS + 1
    wordy = [_sp(f"S{n}", "t" * MAX_OBJECT_CHARS) for n in range(count)]
    group = _two_cell(_grp("G", *wordy, _pic(), _chart_frame()), (0, 900), (4, 906))
    data = _with_drawing(_chart_workbook(), _adding(group))

    preview = _preview(data, _GalleryHost())

    assert _image_ids(preview) == ["chart_0"]
    assert preview["chartPages"] == [2]


# --- nothing is lost after an exact cap --------------------------------------------------


def _drawing_part_of(data: bytes, sheet_number: int) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        rels = archive.read(f"xl/worksheets/_rels/sheet{sheet_number}.xml.rels").decode()
    found = re.search(r'Target="(?:\.\./drawings|/xl/drawings)/(drawing\d+\.xml)"', rels)
    assert found, rels
    return "xl/drawings/" + found[1]


def _with_part(data: bytes, part: str, edit) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(out, "w") as dst:
        for item in src.infolist():
            body = src.read(item)
            dst.writestr(item, edit(body.decode()).encode() if item.filename == part else body)
    return out.getvalue()


def _full_first_sheet_then(*, picture: bool) -> bytes:
    """The one-chart sheet with exactly the object cap of shapes, then a second sheet."""
    book = openpyxl.load_workbook(io.BytesIO(_chart_workbook()))
    later = book.create_sheet("Later")
    if picture:
        later.add_image(Image(io.BytesIO(_png())), "A1")
    # openpyxl drops shapes on save, so they go in after it
    return _with_drawing(_save(book), _adding(*_shapes(MAX_OBJECTS, "")))


@pytest.mark.parametrize("picture", [False, True], ids=["empty worksheet", "picture-only drawing"])
def test_an_empty_later_sheet_after_the_exact_cap_keeps_the_chart_pages_unlisted(
    picture: bool,
) -> None:
    preview = _preview(_full_first_sheet_then(picture=picture), _GalleryHost())

    assert _image_ids(preview) == ["chart_0"]
    assert preview["chartPages"] is None


def test_a_later_sheet_with_a_shape_after_the_exact_cap_lists_the_chart_pages() -> None:
    data = _full_first_sheet_then(picture=True)
    late = _two_cell(_sp("Late"), (0, 1), (1, 2))
    data = _with_part(data, _drawing_part_of(data, 2), _adding(late))

    assert _preview(data, _GalleryHost())["chartPages"] == [2]


def test_a_picture_only_anchor_after_the_exact_cap_keeps_the_chart_pages_unlisted() -> None:
    picture = _two_cell(_pic(), (0, 2), (1, 3))
    data = _with_drawing(_chart_workbook(), _adding(*_shapes(MAX_OBJECTS, ""), picture))

    preview = _preview(data, _GalleryHost())

    assert _image_ids(preview) == ["chart_0"]
    assert preview["chartPages"] is None


# --- hidden sheets and chart sheets ------------------------------------------------------


def _with_hidden_sheet(state: str, *anchors: str) -> bytes:
    """The one-chart workbook plus a second sheet in ``state`` whose drawing gains ``anchors``."""
    book = openpyxl.load_workbook(io.BytesIO(_chart_workbook()))
    hidden = book.create_sheet("Hidden")
    hidden.add_image(Image(io.BytesIO(_png())), "A1")
    hidden.sheet_state = state
    data = _save(book)
    return _with_part(data, _drawing_part_of(data, 2), _adding(*anchors))


@pytest.mark.parametrize("state", ["hidden", "veryHidden"])
@pytest.mark.parametrize(
    "anchor",
    [_absolute_chartex(), _two_cell(_grp("G", _chart_frame()), (0, 40), (4, 46))],
    ids=["unplaced chartex", "group chart"],
)
def test_a_chart_on_a_hidden_sheet_still_adds_its_unboxed_entry(state: str, anchor: str) -> None:
    # listing the pages for a hidden chart is the safe side; dropping a visible one is not
    data = _with_hidden_sheet(state, anchor)

    assert _kinds(_entries(data)).count("unboxed") == 1
    assert _preview(data, _GalleryHost())["chartPages"] == [2]


def test_an_unplaced_chartex_on_a_visible_sheet_still_adds_an_unboxed_entry() -> None:
    data = _with_hidden_sheet("visible", _absolute_chartex())

    assert _kinds(_entries(data)).count("unboxed") == 1


def _with_chart_sheet(state: str = "visible", sheet_title: str = "Big") -> bytes:
    book = openpyxl.load_workbook(io.BytesIO(_chart_workbook()))
    sheet = book.create_chartsheet(sheet_title)
    sheet.add_chart(_bar_chart(book.worksheets[0]))
    sheet.sheet_state = state
    return _save(book)


@pytest.mark.parametrize("state", ["visible", "hidden"])
def test_a_chart_sheet_adds_its_unboxed_entry_whatever_its_state(state: str) -> None:
    data = _with_chart_sheet(state)

    assert _kinds(_entries(data)).count("unboxed") == 1
    assert _preview(data, _GalleryHost())["chartPages"] == [2]


def _edit_parts(data: bytes, edits) -> bytes:
    """``data`` with ``edits(name, body) -> [(name, body), ...]`` applied to every part."""
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(out, "w") as dst:
        for item in src.infolist():
            for name, body in edits(item.filename, src.read(item)):
                dst.writestr(name, body)
    return out.getvalue()


def test_a_chart_sheet_whose_title_a_worksheet_repeats_still_adds_its_entry() -> None:
    # openpyxl loads the second "Big" as "Big1"; the chart sheet must not be lost with it
    book = openpyxl.load_workbook(io.BytesIO(_with_chart_sheet()))
    book.create_sheet("Big2").sheet_state = "hidden"

    def rename(name: str, body: bytes) -> list[tuple[str, bytes]]:
        if name == "xl/workbook.xml":
            body = body.replace(b'name="Big2"', b'name="Big"')
        return [(name, body)]

    data = _edit_parts(_save(book), rename)

    assert _kinds(_entries(data)).count("unboxed") == 1
    assert _preview(data, _GalleryHost())["chartPages"] == [2]


def test_a_stale_workbook_xml_does_not_hide_a_chart_sheet() -> None:
    # the real workbook part is xl/actual.xml; xl/workbook.xml is a stale copy that hides it
    def move(name: str, body: bytes) -> list[tuple[str, bytes]]:
        if name == "xl/workbook.xml":
            stale = body.replace(b'state="visible"', b'state="hidden"')
            return [("xl/actual.xml", body), (name, stale)]
        if name == "xl/_rels/workbook.xml.rels":
            return [("xl/_rels/actual.xml.rels", body)]
        if name in ("_rels/.rels", "[Content_Types].xml"):
            return [(name, body.replace(b"xl/workbook.xml", b"xl/actual.xml"))]
        return [(name, body)]

    data = _edit_parts(_with_chart_sheet(), move)

    assert _kinds(_entries(data)).count("unboxed") == 1
    assert _preview(data, _GalleryHost())["chartPages"] == [2]


def test_an_incomplete_drawing_read_still_adds_its_entry_beside_a_hidden_sheet() -> None:
    data = _with_hidden_sheet("hidden", *_shapes(MAX_OBJECTS + 1, ""))

    assert _kinds(_entries(data)) == ["chart", "unboxed"]


# --- the reader and openpyxl number the sheets alike -------------------------------------


def _located(data: bytes) -> list[tuple[int | None, str]]:
    return [(entry["sheet"], entry["kind"]) for entry in _entries(data)]


def _with_dialog_sheet_first(data: bytes) -> bytes:
    """``data`` with a hidden dialog sheet ahead of its sheets; openpyxl reads it as a worksheet."""

    def insert(name: str, body: bytes) -> list[tuple[str, bytes]]:
        if name == "xl/workbook.xml":
            entry = f'<sheet xmlns:r="{_R}" name="Dlg" sheetId="9" state="hidden" r:id="rId90"/>'
            return [(name, body.replace(b"<sheets>", b"<sheets>" + entry.encode()))]
        if name == "xl/_rels/workbook.xml.rels":
            rel = (
                f'<Relationship Type="{_R}/dialogsheet" '
                'Target="/xl/dialogsheets/sheet1.xml" Id="rId90"/>'
            )
            return [(name, body.replace(b"</Relationships>", rel.encode() + b"</Relationships>"))]
        if name == "[Content_Types].xml":
            override = (
                '<Override PartName="/xl/dialogsheets/sheet1.xml" ContentType='
                '"application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml"/>'
            )
            return [
                (name, body.replace(b"</Types>", override.encode() + b"</Types>")),
                ("xl/dialogsheets/sheet1.xml", f'<dialogsheet xmlns="{_MAIN}"/>'.encode()),
            ]
        return [(name, body)]

    return _edit_parts(data, insert)


def test_a_dialog_sheet_ahead_of_a_worksheet_does_not_shift_its_charts() -> None:
    group = _two_cell(_grp("G", _chart_frame()), (0, 40), (4, 46))
    data = _with_dialog_sheet_first(_with_drawing(_chart_workbook(), _adding(group)))
    assert [sheet.title for sheet in openpyxl.load_workbook(io.BytesIO(data)).worksheets] == [
        "Dlg",
        "피벗",
    ]

    assert _located(data) == [(1, "chart"), (1, "unsupported"), (1, "unboxed")]
    assert _preview(data, _GalleryHost())["chartPages"] == [2]


def _chart_on_second_sheet_with_chartex() -> bytes:
    book = openpyxl.Workbook()
    book.active.title = "A"
    second = book.create_sheet("B")
    _fill(second)
    second.add_chart(_bar_chart(second), "A15")
    data = _save(book)
    notice = _two_cell(_chartex_frame(), (0, 40), (4, 46))
    return _with_part(data, _drawing_part_of(data, 2), _adding(notice))


def test_the_workbook_part_the_content_types_name_decides_the_sheet_numbers() -> None:
    # the real workbook part is xl/actual.xml; a stale xl/workbook.xml lists B before A
    def move(name: str, body: bytes) -> list[tuple[str, bytes]]:
        if name == "xl/workbook.xml":
            entries = re.findall(rb"<sheet [^>]*/>", body)
            stale = body.replace(b"".join(entries), b"".join(reversed(entries)))
            return [("xl/actual.xml", body), (name, stale)]
        if name == "xl/_rels/workbook.xml.rels":
            return [("xl/_rels/actual.xml.rels", body), (name, body)]
        if name in ("_rels/.rels", "[Content_Types].xml"):
            return [(name, body.replace(b"xl/workbook.xml", b"xl/actual.xml"))]
        return [(name, body)]

    data = _edit_parts(_chart_on_second_sheet_with_chartex(), move)

    assert _located(data) == [(1, "chart"), (1, "unsupported")]
    assert _preview(data, _GalleryHost())["chartPages"] is None


# --- the notices land on the worksheet openpyxl loaded, however the package is made ------

_WORKSHEET_TYPE = f"{_R}/worksheet"
_GHOST_PART = "xl/worksheets/ghost.xml"


def _with_ghost_ahead(data: bytes, sheet_entry: str, relationships: str) -> bytes:
    """``data`` with ``sheet_entry`` ahead of its sheets, ``relationships`` added to the
    workbook's, and an empty worksheet part ``xl/worksheets/ghost.xml``."""

    def insert(name: str, body: bytes) -> list[tuple[str, bytes]]:
        if name == "xl/workbook.xml":
            return [(name, body.replace(b"<sheets>", b"<sheets>" + sheet_entry.encode()))]
        if name == "xl/_rels/workbook.xml.rels":
            closing = b"</Relationships>"
            return [(name, body.replace(closing, relationships.encode() + closing))]
        if name == "[Content_Types].xml":
            override = (
                f'<Override PartName="/{_GHOST_PART}" ContentType='
                '"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            )
            return [
                (name, body.replace(b"</Types>", override.encode() + b"</Types>")),
                (_GHOST_PART, f'<worksheet xmlns="{_MAIN}"><sheetData/></worksheet>'.encode()),
            ]
        return [(name, body)]

    return _edit_parts(data, insert)


def _ghost_entry(rel_id: str | None) -> str:
    attribute = "" if rel_id is None else f' r:id="{rel_id}"'
    return f'<sheet xmlns:r="{_R}" name="Ghost" sheetId="90"{attribute}/>'


def _relationship(rel_id: str, target: str, mode: str = "") -> str:
    target_mode = f' TargetMode="{mode}"' if mode else ""
    return f'<Relationship Id="{rel_id}" Type="{_WORKSHEET_TYPE}" Target="{target}"{target_mode}/>'


_GHOSTS = {
    # openpyxl keys the relationships by id, so the second (missing) target wins
    "a repeated id whose last target is missing": (
        _ghost_entry("rIdG"),
        _relationship("rIdG", "worksheets/ghost.xml")
        + _relationship("rIdG", "worksheets/missing.xml"),
        ["피벗"],
    ),
    # openpyxl drops the leading slash of an absolute target and nothing else
    "an absolute target with a dot segment": (
        _ghost_entry("rIdG"),
        _relationship("rIdG", "/xl/./worksheets/ghost.xml"),
        ["피벗"],
    ),
    # openpyxl skips a sheet entry without r:id, whatever an empty id points at
    "a sheet without r:id beside an empty relationship id": (
        _ghost_entry(None),
        _relationship("", "worksheets/ghost.xml"),
        ["피벗"],
    ),
    # openpyxl keeps an external target as written and reads it when the archive holds it
    "an external target naming a worksheet part": (
        _ghost_entry("rIdG"),
        _relationship("rIdG", _GHOST_PART, "External"),
        ["Ghost", "피벗"],
    ),
}


@pytest.mark.filterwarnings("ignore:File contains an invalid specification")
@pytest.mark.parametrize("case", list(_GHOSTS), ids=list(_GHOSTS))
def test_the_notices_land_on_the_worksheet_openpyxl_loaded(case: str) -> None:
    sheet_entry, relationships, titles = _GHOSTS[case]
    group = _two_cell(_grp("G", _chart_frame()), (0, 40), (4, 46))
    chartex = _two_cell(_chartex_frame(), (6, 40), (10, 46))
    base = _with_drawing(_chart_workbook(), _adding(group, chartex))
    data = _with_ghost_ahead(base, sheet_entry, relationships)
    loaded = [sheet.title for sheet in openpyxl.load_workbook(io.BytesIO(data)).worksheets]
    assert loaded == titles
    index = titles.index("피벗")

    assert _located(data) == [
        (index, "chart"),
        (index, "unsupported"),
        (index, "unsupported"),
        (index, "unboxed"),
    ]
    assert _preview(data, _GalleryHost())["chartPages"] == [2]


def test_an_openpyxl_without_worksheet_relationships_lists_the_chart_pages(monkeypatch) -> None:
    from langchain_canvas import xlsx_import

    def _none(worksheet):
        raise AttributeError("_rels")

    monkeypatch.setattr(xlsx_import, "_drawing_targets", _none)
    data = _with_drawing(_chart_workbook(), _adding(_two_cell(_chartex_frame(), (0, 40), (4, 46))))

    assert _kinds(_entries(data)) == ["chart", "unboxed"]
    assert _preview(data, _GalleryHost())["chartPages"] == [2]
