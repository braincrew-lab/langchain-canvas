"""Reading a table as a map: what the card says, and what an address returns.

A table artifact stores the same table twice — the agent's ``columns``/``rows``
and the person's grid sheets — and the grid is where the size is. These tests
pin what the map names and what each address hands back.
"""

from __future__ import annotations

import json

import pytest

from langchain_canvas.table_outline import table_view


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
    assert view == "### sheet: Ledger\nregion,amount\nSeoul,=SUM(B2:B9)"


def test_an_unknown_address_names_the_ones_that_exist() -> None:
    with pytest.raises(ValueError, match=r"rows, s0, s1 \(got 's7'\)"):
        table_view(_table(sheets=[_grid("A", []), _grid("B", [])]), "s7")


def test_content_that_is_not_a_table_asks_to_be_read_the_ordinary_way() -> None:
    # A file broken enough to lose its own shape has to stay visible, or it
    # cannot be fixed.
    assert table_view("{not json") is None
    assert table_view(json.dumps({"type": "table"})) is None
    assert table_view(json.dumps(["a list"])) is None
