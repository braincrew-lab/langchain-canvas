"""Golden-file parity between the xlsx importers.

``langchain_canvas/xlsx_import.py`` and ``canvas-react/src/io/xlsx.ts`` read
the same uploaded workbook — one in the agent's process, one in the browser —
and have to land on the same sheets, or a table a person drags in and a table
an agent builds stop looking alike. The existing protocol parity test compares
field names in source; this compares what the two readers actually produce
from the same bytes.

The fixture and the golden live beside the TypeScript reader
(``src/io/__fixtures__/``) and both test suites read them, so whichever side
drifts, its own suite goes red. The golden is the browser's output, taken with
``TZ=UTC``: exceljs reads serial dates as UTC midnight and formats them from
local parts, so the day a date cell shows depends on the machine's zone.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from langchain_canvas.xlsx_import import xlsx_to_sheets

FIXTURES = Path(__file__).resolve().parents[2] / "canvas-react" / "src" / "io" / "__fixtures__"
WORKBOOK = FIXTURES / "xlsx-parity.xlsx"
GOLDEN = FIXTURES / "xlsx-parity.json"


def _as_json(value: object) -> object:
    """Through JSON, where a dict's integer keys become strings — the shape
    both readers are compared in, and the shape a table is stored in."""
    return json.loads(json.dumps(value, ensure_ascii=False))


def test_the_twin_reads_the_fixture_into_the_golden_sheets() -> None:
    assert _as_json(xlsx_to_sheets(WORKBOOK.read_bytes())) == json.loads(GOLDEN.read_text())


def test_the_fixture_burns_every_surface_the_importer_reads() -> None:
    """A surface the fixture does not exercise is one the twins can drift on
    unnoticed, so the fixture's coverage is itself pinned."""
    golden = json.loads(GOLDEN.read_text())
    sheets = golden["sheets"]
    assert [s["status"] for s in sheets] == [1, 0, 0]  # only the first is open
    assert [s["id"] for s in sheets] == ["sheet_0", "sheet_1", "sheet_2"]
    assert [s["order"] for s in sheets] == [0, 1, 2]

    first = sheets[0]
    cells = {f"{c['r']}_{c['c']}": c["v"] for c in first["celldata"]}
    assert cells["0_0"]["bl"] == 1 and cells["0_0"]["ff"] == "Arial"  # bold, face
    assert cells["0_0"]["fs"] == 12 and cells["0_0"]["fc"] == "#FFFFFF"  # size, rgb colour
    assert cells["0_0"]["bg"] == "#4472C4"  # solid fill
    assert cells["0_0"]["ht"] == 0 and cells["0_0"]["vt"] == 0  # both alignments
    assert cells["1_2"]["m"] == "1,234.50" and cells["1_2"]["v"] == 1234.5  # thousands
    assert cells["1_3"]["f"] == "=B2*C2" and cells["1_3"]["m"] == "3,703.50"  # cached formula
    assert cells["1_4"]["m"] == "15.6%"  # percent
    assert cells["2_2"]["m"] == "-$2,000"  # negative currency
    assert cells["1_5"]["ct"] == {"fa": "yyyy-mm-dd", "t": "d"}  # date type
    assert cells["2_5"]["m"].startswith('2025"년 "12')  # literal text in a format
    assert cells["1_6"]["tb"] == "2" and cells["1_6"]["ht"] == 2  # wrap, right
    assert cells["2_6"]["v"] == "true"  # boolean
    assert cells["3_0"]["it"] == 1 and cells["3_0"]["un"] == 1  # italic, underline
    assert cells["3_0"]["fc"] == "#335693"  # theme colour with a tint
    assert cells["3_1"]["fc"] == "#FF0000"  # legacy indexed palette
    assert cells["3_2"]["bg"] == "#f4b183"  # tinted fill
    assert cells["3_3"]["m"] == "" and cells["3_3"]["bg"] == "#FFC000"  # empty but styled
    assert "3_4" not in cells  # empty and unstyled: not carried at all
    assert cells["5_0"]["mc"] == {"r": 5, "c": 0, "rs": 1, "cs": 3}  # merge master
    assert cells["5_1"] == {"mc": {"r": 5, "c": 0}}  # covered cell points back

    config = first["config"]
    assert config["merge"] == {"5_0": {"r": 5, "c": 0, "rs": 1, "cs": 3}}
    assert config["columnlen"]["0"] == 134 and config["rowlen"]["0"] == 37  # stored sizes
    boxed = next(b["value"] for b in config["borderInfo"] if b["value"]["row_index"] == 6
                 and b["value"]["col_index"] == 0)
    assert [boxed[side]["style"] for side in ("l", "r", "t", "b")] == [1, 7, 3, 8]
    assert boxed["r"]["color"] == "#FF0000"

    image = sheets[2]["images"][0]
    assert image["id"] == "img_0" and image["src"].startswith("data:image/png;base64,")
    assert image["left"] > 0 and image["top"] > 0 and image["width"] >= 16

    keys = [c["key"] for c in golden["columns"]]
    assert keys[-1] == "Item (2)"  # a repeated header keeps both columns
    assert len(golden["rows"]) == 5  # the blank row is dropped
    assert golden["rows"][3]["Qty"] == "merged title"  # flat view reads through a merge


def test_without_openpyxl_the_reader_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    from langchain_canvas.converters import MissingConverterDependencyError

    real_import = builtins.__import__

    def blocked(name: str, *args: object, **kwargs: object) -> object:
        if name == "openpyxl":
            raise ImportError("no openpyxl")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", blocked)
    with pytest.raises(MissingConverterDependencyError, match=r"langchain-canvas\[xlsx\]"):
        xlsx_to_sheets(b"anything")
