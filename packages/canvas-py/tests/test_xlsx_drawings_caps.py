"""The drawing reader says a read is incomplete only when a cap hid an object.

A picture is never read, so one between the cap and a chart hides nothing but must not hide
the chart from the flag. A later empty worksheet or drawing part holds nothing to lose.
"""

from __future__ import annotations

from test_xlsx_drawings import (
    _PKG,
    _R,
    _chart_frame,
    _grp,
    _one_cell,
    _package,
    _sp,
    _text_boxes,
    _wsdr,
)

from langchain_canvas.xlsx_drawings import (
    MAX_OBJECT_CHARS,
    MAX_OBJECTS,
    MAX_TOTAL_CHARS,
    read_drawing_objects_checked,
)


def _pic(name: str = "Picture 1") -> str:
    return (
        f'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="5" name="{name}"/><xdr:cNvPicPr/></xdr:nvPicPr>'
        "<xdr:blipFill/><xdr:spPr/></xdr:pic>"
    )


def _shapes(count: int, text: str = "x") -> list[str]:
    return [_sp(f"S{n}", text) for n in range(count)]


# --- a chart after a picture at the cap --------------------------------------------------


def test_a_chart_after_a_picture_at_the_object_cap_leaves_the_read_incomplete() -> None:
    group = _grp("G", *_shapes(MAX_OBJECTS), _pic(), _chart_frame())

    objects, complete = read_drawing_objects_checked(_package([_wsdr(_one_cell(group))]))

    assert len(objects) == MAX_OBJECTS and not complete


def test_a_chart_after_a_picture_at_the_text_cap_leaves_the_read_incomplete() -> None:
    wordy = _shapes(MAX_TOTAL_CHARS // MAX_OBJECT_CHARS + 1, "t" * MAX_OBJECT_CHARS)
    group = _grp("G", *wordy, _pic(), _chart_frame())

    objects, complete = read_drawing_objects_checked(_package([_wsdr(_one_cell(group))]))

    assert "group_chart" not in [o["kind"] for o in objects] and not complete


def test_only_pictures_after_the_cap_leave_the_read_complete() -> None:
    group = _grp("G", *_shapes(MAX_OBJECTS), _pic(), _pic("Picture 2"))

    _, complete = read_drawing_objects_checked(_package([_wsdr(_one_cell(group))]))

    assert complete


# --- a picture-only anchor after the cap -------------------------------------------------


def test_a_picture_only_anchor_after_the_exact_cap_leaves_the_read_complete() -> None:
    data = _package([_wsdr(*_text_boxes(MAX_OBJECTS), _one_cell(_pic()))])

    objects, complete = read_drawing_objects_checked(data)

    assert len(objects) == MAX_OBJECTS and complete


def test_a_shape_anchor_after_a_picture_only_anchor_leaves_the_read_incomplete() -> None:
    late = _one_cell(_sp("Late"))
    data = _package([_wsdr(*_text_boxes(MAX_OBJECTS), _one_cell(_pic()), late)])

    objects, complete = read_drawing_objects_checked(data)

    assert len(objects) == MAX_OBJECTS and not complete


# --- an empty sheet or drawing after the cap ---------------------------------------------


def test_an_empty_worksheet_after_the_exact_cap_leaves_the_read_complete() -> None:
    data = _package([_wsdr(*_text_boxes(MAX_OBJECTS)), None])

    objects, complete = read_drawing_objects_checked(data)

    assert len(objects) == MAX_OBJECTS and complete


def test_an_empty_drawing_after_the_exact_cap_leaves_the_read_complete() -> None:
    data = _package([_wsdr(*_text_boxes(MAX_OBJECTS)), _wsdr()])

    assert read_drawing_objects_checked(data)[1]


def test_a_picture_only_drawing_after_the_exact_cap_leaves_the_read_complete() -> None:
    data = _package([_wsdr(*_text_boxes(MAX_OBJECTS)), _wsdr(_one_cell(_pic()))])

    assert read_drawing_objects_checked(data)[1]


def test_a_later_worksheet_with_a_shape_after_the_cap_leaves_the_read_incomplete() -> None:
    data = _package([_wsdr(*_text_boxes(MAX_OBJECTS)), _wsdr(_one_cell(_sp("Late")))])

    objects, complete = read_drawing_objects_checked(data)

    assert len(objects) == MAX_OBJECTS and not complete


def _two_drawings(first: str, second: str) -> bytes:
    """One worksheet whose relationships name two drawing parts."""
    rels = (
        f'<Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId1" Type="{_R}/drawing" Target="../drawings/drawing1.xml"/>'
        f'<Relationship Id="rId2" Type="{_R}/drawing" Target="../drawings/drawing9.xml"/>'
        "</Relationships>"
    )
    return _package(
        [first],
        extra={"xl/worksheets/_rels/sheet1.xml.rels": rels, "xl/drawings/drawing9.xml": second},
    )


def test_an_empty_second_drawing_of_a_full_worksheet_leaves_the_read_complete() -> None:
    objects, complete = read_drawing_objects_checked(
        _two_drawings(_wsdr(*_text_boxes(MAX_OBJECTS)), _wsdr())
    )

    assert len(objects) == MAX_OBJECTS and complete


def test_a_second_drawing_with_a_shape_on_a_full_worksheet_leaves_the_read_incomplete() -> None:
    objects, complete = read_drawing_objects_checked(
        _two_drawings(_wsdr(*_text_boxes(MAX_OBJECTS)), _wsdr(_one_cell(_sp("Late"))))
    )

    assert len(objects) == MAX_OBJECTS and not complete
