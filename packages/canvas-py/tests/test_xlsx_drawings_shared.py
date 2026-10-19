"""One worksheet named by many sheet entries: its relationships are read once, within budget.

The archive limits do not count repeats, so the reader keeps what it parsed for a
worksheet part and charges the relationships part against the same per-read byte
budget as the drawings.
"""

from __future__ import annotations

import io
import zipfile

from test_xlsx_drawings import _MAIN, _PKG, _R, _one_cell, _sp, _wsdr

from langchain_canvas.xlsx_drawings import MAX_OBJECTS, read_drawing_objects


def _shared_worksheet_package(references: int, filler: int) -> bytes:
    """``references`` sheet entries that all point at one worksheet part.

    That worksheet's relationships part holds its one drawing and ``filler`` more
    relationships, so the part is large however few bytes it takes in the zip.
    """
    listed = "".join(f'<sheet name="S{n}" sheetId="{n}" r:id="rId{n}"/>' for n in range(references))
    targets = "".join(
        f'<Relationship Id="rId{n}" Type="{_R}/worksheet" Target="worksheets/sheet1.xml"/>'
        for n in range(references)
    )
    padding = "".join(
        f'<Relationship Id="x{n}" Type="{_R}/hyperlink" Target="https://example.com/{n}" '
        'TargetMode="External"/>'
        for n in range(filler)
    )
    parts = {
        "xl/workbook.xml": (
            f'<workbook xmlns="{_MAIN}" xmlns:r="{_R}"><sheets>{listed}</sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{_PKG}">{targets}</Relationships>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{_MAIN}"/>',
        "xl/worksheets/_rels/sheet1.xml.rels": (
            f'<Relationships xmlns="{_PKG}"><Relationship Id="rId1" Type="{_R}/drawing" '
            f'Target="../drawings/drawing1.xml"/>{padding}</Relationships>'
        ),
        "xl/drawings/drawing1.xml": _wsdr(_one_cell(_sp("Shared"))),
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, body in parts.items():
            archive.writestr(name, body)
    return out.getvalue()


def test_a_worksheet_named_by_many_sheets_has_its_relationships_read_once(monkeypatch) -> None:
    import time

    import langchain_canvas.xlsx_drawings as xlsx_drawings

    read: list[str] = []
    real = xlsx_drawings._part_text

    def _spy(archive, name):
        read.append(name)
        return real(archive, name)

    monkeypatch.setattr(xlsx_drawings, "_part_text", _spy)
    data = _shared_worksheet_package(1000, filler=10_000)  # about 1 MiB of relationships

    started = time.perf_counter()
    objects = read_drawing_objects(data)
    elapsed = time.perf_counter() - started

    assert read.count("xl/worksheets/_rels/sheet1.xml.rels") == 1
    assert elapsed < 1
    (single,) = read_drawing_objects(_shared_worksheet_package(1, filler=10_000))
    assert len(objects) == MAX_OBJECTS
    assert {**objects[0], "sheet": 0, "sheet_name": "S0"} == single
    assert objects[-1]["sheet"] == MAX_OBJECTS - 1


def test_relationship_bytes_count_against_the_parse_budget(monkeypatch) -> None:
    import langchain_canvas.xlsx_drawings as xlsx_drawings

    data = _shared_worksheet_package(2, filler=500)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        rels = archive.getinfo("xl/worksheets/_rels/sheet1.xml.rels").file_size
        drawing = archive.getinfo("xl/drawings/drawing1.xml").file_size

    monkeypatch.setattr(xlsx_drawings, "MAX_TOTAL_PART_BYTES", rels - 1)
    assert read_drawing_objects(data) == []  # the relationships alone pass the budget
    monkeypatch.setattr(xlsx_drawings, "MAX_TOTAL_PART_BYTES", rels + drawing - 1)
    assert read_drawing_objects(data) == []  # no room left for the drawing
    monkeypatch.setattr(xlsx_drawings, "MAX_TOTAL_PART_BYTES", rels + drawing)
    assert len(read_drawing_objects(data)) == 2  # both sheets, one read of each part
