"""The drawing reader numbers sheets the way openpyxl does.

A caller joins the reader's ``sheet`` index to ``workbook.worksheets``, so both must skip
and count the same sheets: a dialog sheet is a worksheet to openpyxl, a chart sheet and a
sheet with no usable part are not, and the workbook part is the one ``[Content_Types].xml``
names.
"""

from __future__ import annotations

import io
import posixpath
import re
import zipfile

import pytest
from test_xlsx_drawings import _MAIN, _PKG, _R, _one_cell, _sp, _wsdr

from langchain_canvas.xlsx_drawings import read_drawing_objects

_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
_SHEET_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
_MACRO_MAIN = "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
_TEMPLATE_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"
_FOLDERS = {"worksheet": "worksheets", "dialogsheet": "dialogsheets", "chartsheet": "chartsheets"}


def _parts(
    sheets: list[tuple[str, str, str | None, bool]],
    *,
    workbook: str = "xl/workbook.xml",
    content_types: str | None = None,
) -> dict[str, str]:
    """A workbook package as parts. A sheet is ``(name, kind, drawing, part_exists)``."""
    entries, rels, parts = [], [], {}
    for number, (name, kind, drawing, exists) in enumerate(sheets, 1):
        folder = _FOLDERS[kind]
        entries.append(f'<sheet name="{name}" sheetId="{number}" r:id="rId{number}"/>')
        rels.append(
            f'<Relationship Id="rId{number}" Type="{_R}/{kind}" '
            f'Target="{folder}/sheet{number}.xml"/>'
        )
        if exists:
            parts[f"xl/{folder}/sheet{number}.xml"] = f'<{kind} xmlns="{_MAIN}"/>'
        if drawing is not None:
            parts[f"xl/{folder}/_rels/sheet{number}.xml.rels"] = (
                f'<Relationships xmlns="{_PKG}"><Relationship Id="rId1" Type="{_R}/drawing" '
                f'Target="../drawings/drawing{number}.xml"/></Relationships>'
            )
            parts[f"xl/drawings/drawing{number}.xml"] = drawing
    directory, base = posixpath.split(workbook)
    listed = "".join(entries)
    parts[workbook] = (
        f'<workbook xmlns="{_MAIN}" xmlns:r="{_R}"><sheets>{listed}</sheets></workbook>'
    )
    parts[posixpath.join(directory, "_rels", f"{base}.rels")] = (
        f'<Relationships xmlns="{_PKG}">{"".join(rels)}</Relationships>'
    )
    if content_types is not None:
        parts["[Content_Types].xml"] = content_types
    return parts


def _types(workbook: str, content_type: str = _SHEET_MAIN) -> str:
    return (
        f'<Types xmlns="{_CT}"><Default Extension="xml" ContentType="application/xml"/>'
        f'<Override PartName="/{workbook}" ContentType="{content_type}"/></Types>'
    )


def _zip(parts: dict[str, str]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        for name, body in parts.items():
            archive.writestr(name, body)
    return out.getvalue()


def _located(data: bytes) -> list[tuple[int, str]]:
    return [(o["sheet"], o["name"]) for o in read_drawing_objects(data)]


def _shape(name: str) -> str:
    return _wsdr(_one_cell(_sp(name)))


# --- which sheets take a number ----------------------------------------------------------


def test_a_dialog_sheet_takes_a_worksheet_number() -> None:
    parts = _parts([("Dlg", "dialogsheet", None, True), ("Data", "worksheet", _shape("A"), True)])

    assert _located(_zip(parts)) == [(1, "A")]


def test_a_dialog_sheet_with_a_drawing_is_read_at_its_own_number() -> None:
    parts = _parts(
        [("Dlg", "dialogsheet", _shape("D"), True), ("Data", "worksheet", _shape("A"), True)]
    )

    assert _located(_zip(parts)) == [(0, "D"), (1, "A")]


def test_a_chart_sheet_takes_no_number() -> None:
    parts = _parts([("Big", "chartsheet", None, True), ("Data", "worksheet", _shape("A"), True)])

    assert _located(_zip(parts)) == [(0, "A")]


def test_a_sheet_whose_part_is_missing_takes_no_number() -> None:
    parts = _parts([("Gone", "worksheet", None, False), ("Data", "worksheet", _shape("A"), True)])

    assert _located(_zip(parts)) == [(0, "A")]


def test_a_sheet_with_no_relationship_id_takes_no_number() -> None:
    parts = _parts([("Data", "worksheet", _shape("A"), True)])
    parts["xl/workbook.xml"] = parts["xl/workbook.xml"].replace(
        "<sheets>", '<sheets><sheet name="Bare" sheetId="7"/>'
    )

    assert _located(_zip(parts)) == [(0, "A")]


# --- which part is the workbook ----------------------------------------------------------


def _actual_and_stale() -> dict[str, str]:
    """The real workbook part is ``xl/actual.xml``; a stale ``xl/workbook.xml`` lists the
    same sheets in the other order."""
    sheets = [("First", "worksheet", None, True), ("Second", "worksheet", _shape("B"), True)]
    parts = _parts(sheets, workbook="xl/actual.xml", content_types=_types("xl/actual.xml"))
    entries = re.findall(r"<sheet [^>]*/>", parts["xl/actual.xml"])
    parts["xl/workbook.xml"] = parts["xl/actual.xml"].replace(
        "".join(entries), "".join(reversed(entries))
    )
    parts["xl/_rels/workbook.xml.rels"] = parts["xl/_rels/actual.xml.rels"]
    return parts


def test_the_workbook_part_is_the_one_the_content_types_name() -> None:
    assert _located(_zip(_actual_and_stale())) == [(1, "B")]


@pytest.mark.parametrize("content_type", [_MACRO_MAIN, _TEMPLATE_MAIN])
def test_a_macro_or_template_workbook_type_names_the_workbook_part(content_type: str) -> None:
    parts = _actual_and_stale()
    parts["[Content_Types].xml"] = _types("xl/actual.xml", content_type)

    assert _located(_zip(parts)) == [(1, "B")]


def test_the_first_present_type_in_openpyxls_order_wins() -> None:
    parts = _actual_and_stale()
    parts["[Content_Types].xml"] = (
        f'<Types xmlns="{_CT}">'
        f'<Override PartName="/xl/workbook.xml" ContentType="{_SHEET_MAIN}"/>'
        f'<Override PartName="/xl/actual.xml" ContentType="{_TEMPLATE_MAIN}"/></Types>'
    )

    assert _located(_zip(parts)) == [(1, "B")]


def test_without_a_workbook_override_the_default_part_is_read() -> None:
    parts = _actual_and_stale()
    parts["[Content_Types].xml"] = (
        f'<Types xmlns="{_CT}"><Default Extension="xml" ContentType="{_SHEET_MAIN}"/></Types>'
    )

    assert _located(_zip(parts)) == [(0, "B")]  # the stale xl/workbook.xml lists B first


def test_unreadable_content_types_fall_back_to_the_default_part() -> None:
    parts = _actual_and_stale()
    parts["[Content_Types].xml"] = "<!DOCTYPE t []><Types/>"

    assert _located(_zip(parts)) == [(0, "B")]
