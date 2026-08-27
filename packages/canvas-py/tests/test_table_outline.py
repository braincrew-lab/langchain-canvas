"""Reading a table as a map: what the card says, and what an address returns.

A table artifact stores the same table twice — the agent's ``columns``/``rows``
and the person's grid sheets — and the grid is where the size is. These tests
pin what the map names and what each address hands back.
"""

from __future__ import annotations

import json

import pytest

from langchain_canvas.table_outline import ROWS, add_sheet, table_view, write_cells


def _table(*, sheets: list[dict] | None = None, title: str = "Q3") -> str:
    data: dict = {
        "columns": [{"key": "region"}, {"key": "amount"}],
        "rows": [{"region": "Seoul", "amount": 12}, {"region": "Busan", "amount": 7}],
    }
    if sheets is not None:
        data["sheet"] = sheets
    return json.dumps({"type": "table", "title": title, "data": data})


def _grid(name: str, cells: list[dict], **config) -> dict:
    return {"name": name, "row": 200, "column": 8, "celldata": cells, "config": config}


def _cell(r: int, c: int, **value) -> dict:
    return {"r": r, "c": c, "v": value}


def test_the_map_names_every_rectangle_with_its_size_and_contents() -> None:
    view = table_view(_table(sheets=[
        _grid("Ledger", [_cell(0, 0, v="region"), _cell(1, 0, v="Seoul"),
                         _cell(1, 1, f="=SUM(B2:B9)")], merge={"1_1": {}}),
        _grid("Empty", []),
    ]))
    assert view is not None
    assert "table: Q3" in view
    # The agent's own rectangle, and the column names that address its cells.
    assert "[rows] 2 x 2 — what agents read and write" in view
    assert "region, amount" in view
    assert "[s0] Ledger — 200 x 8 grid, 3 values, 1 formula, 1 merge" in view
    # A sheet holding nothing but formatting says so rather than looking empty.
    assert "[s1] Empty — 200 x 8 grid, no values" in view
    assert len(view.splitlines()) < 12


def test_the_map_says_what_a_whole_file_rewrite_costs() -> None:
    # This is the risk the map itself creates: an agent that only ever sees
    # `rows` will reach for a full rewrite, and the person's grid goes with it.
    view = table_view(_table(sheets=[_grid("A", []), _grid("B", [])]))
    assert view is not None
    assert "rewrites all 2 grid sheets" in view
    assert "the formatting,\nmerges and formulas only the grid holds" in view
    # No sheets, no warning to give — there is nothing of the person's to lose.
    plain = table_view(_table())
    assert plain is not None and "rewrites" not in plain


def test_the_rows_address_returns_the_agent_rectangle_as_csv() -> None:
    view = table_view(_table(sheets=[_grid("A", [])]), "rows")
    assert view == "### sheet: rows\nregion,amount\nSeoul,12\nBusan,7"


def test_a_sheet_address_returns_that_grid_as_csv() -> None:
    view = table_view(
        _table(sheets=[_grid("A", []), _grid("Ledger", [
            _cell(0, 0, v="region"), _cell(0, 1, v="amount"),
            _cell(1, 0, v="Seoul"), _cell(1, 1, f="SUM(B2:B9)"),
        ])]),
        "s1",
    )
    # A typed formula stays a formula: its cached result is not what it says.
    # The header names the columns, so a writer never counts commas.
    assert view == "### sheet: Ledger (columns A-B)\nregion,amount\nSeoul,=SUM(B2:B9)"


def test_an_unknown_address_names_the_ones_that_exist() -> None:
    with pytest.raises(ValueError, match=r"rows, s0, s1 \(got 's7'\)"):
        table_view(_table(sheets=[_grid("A", []), _grid("B", [])]), "s7")


def test_content_that_is_not_a_table_asks_to_be_read_the_ordinary_way() -> None:
    # A file broken enough to lose its own shape has to stay visible, or it
    # cannot be fixed.
    assert table_view("{not json") is None
    assert table_view(json.dumps({"type": "table"})) is None
    assert table_view(json.dumps(["a list"])) is None
    # An envelope of another type saved under a table's name is the same
    # case. Calling it an empty table would hide a whole deck, and an agent
    # that believed the map would write over it.
    deck = json.dumps({"type": "slides", "data": {"slides": [{"title": "T"}]}})
    assert table_view(deck) is None
    assert table_view(deck, "rows") is None


def _sheet(name: str, cells: list[dict], **extra) -> dict:
    return {"name": name, "id": name, "order": 0, "status": 1, "row": 20, "column": 6,
            "celldata": cells, "config": {"merge": {}}, **extra}


def _book(*sheets: dict, rows: list[dict] | None = None) -> str:
    return json.dumps({"type": "table", "title": "Q3", "data": {
        "columns": [{"key": "region", "label": "region"},
                    {"key": "amount", "label": "amount"}],
        "rows": rows if rows is not None else [{"region": "Seoul", "amount": 10}],
        "sheet": list(sheets),
    }})


def _cells_of(content: str, index: int) -> dict[str, dict]:
    sheet = json.loads(content)["data"]["sheet"][index]
    return {f"{c['r']}_{c['c']}": c["v"] for c in sheet["celldata"]}


def test_a_write_lands_on_the_named_sheet_and_leaves_the_others_alone() -> None:
    book = _book(
        _sheet("Ledger", [_cell(1, 0, v="Seoul", bl=1)]),
        _sheet("Notes", [_cell(0, 0, v="keep me", fc="#FF0000")]),
    )
    out, note = write_cells(book, "s0", {"A2": "Busan", "B2": 42, "C2": "=B2*2"})

    assert json.loads(out)["data"]["sheet"][1] == json.loads(book)["data"]["sheet"][1]
    cells = _cells_of(out, 0)
    # Styling on a cell that gets a new value stays with it.
    assert cells["1_0"] == {"bl": 1, "v": "Busan", "m": "Busan"}
    assert cells["1_1"] == {"v": 42, "m": "42", "ct": {"fa": "General", "t": "n"}}
    assert cells["1_2"] == {"f": "=B2*2"}  # a formula stays a formula
    assert "Ledger" in note


def test_writing_the_first_sheet_brings_rows_with_it() -> None:
    # rows is the projection of sheet 0, and the xlsx export reads it. Left
    # stale, the export puts the old values back over the new ones.
    book = _book(_sheet("Ledger", [
        _cell(0, 0, v="region"), _cell(0, 1, v="amount"),
        _cell(1, 0, v="Seoul"), _cell(1, 1, v=10),
    ]))
    out, _ = write_cells(book, "s0", {"B2": 99})
    assert json.loads(out)["data"]["rows"] == [{"region": "Seoul", "amount": 99}]


def test_a_sheet_stored_as_a_dense_matrix_keeps_the_values_it_had() -> None:
    # celldata and data are read as alternatives, so a sheet that stored the
    # dense matrix has to be converted, not have one cell bolted onto it.
    dense = _sheet("Grid", [], data=[[{"v": "kept", "m": "kept"}, None], [None, None]])
    del dense["celldata"]
    out, _ = write_cells(_book(dense), "s0", {"B2": "new"})
    sheet = json.loads(out)["data"]["sheet"][0]
    assert "data" not in sheet
    assert {f"{c['r']}_{c['c']}" for c in sheet["celldata"]} == {"0_0", "1_1"}


def test_a_write_takes_the_addresses_the_reader_prints() -> None:
    book = _book(_sheet("Ledger", []), _sheet("Notes", []))
    with pytest.raises(ValueError, match=r"s0, s1 \(got 's9'\)"):
        write_cells(book, "s9", {"A1": 1})
    # `rows` is derived, so it says where to write instead of failing blankly.
    with pytest.raises(ValueError, match="write s0 instead"):
        write_cells(book, ROWS, {"A1": 1})
    with pytest.raises(ValueError, match="write them like A1"):
        write_cells(book, "s0", {"1A": 1})
    with pytest.raises(ValueError, match="at least one"):
        write_cells(book, "s0", {})


def test_a_new_sheet_goes_last_so_the_addresses_already_given_still_hold() -> None:
    book = _book(_sheet("Ledger", [_cell(0, 0, v="x")]))
    out, note = add_sheet(book, "Summary")
    sheets = json.loads(out)["data"]["sheet"]
    assert [s["name"] for s in sheets] == ["Ledger", "Summary"]
    assert sheets[0] == json.loads(book)["data"]["sheet"][0]  # s0 is still s0
    assert sheets[1]["status"] == 0 and sheets[1]["celldata"] == []
    assert "s1" in note
    with pytest.raises(ValueError, match="already has a sheet named"):
        add_sheet(out, "Summary")
