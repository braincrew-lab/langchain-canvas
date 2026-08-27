"""Converging a table's two representations: ``rows`` and ``sheet``.

A table artifact carries the same data twice once a person has edited it:
the structured ``columns``/``rows`` (what agents read and write) and the
grid editor state ``data["sheet"]`` (what the person sees — values plus
formatting, merges and typed formulas). Both accept writes, so the two
drift apart unless something reconciles them. This module is the Python
side of that reconciliation, mirroring ``canvas-react/src/io/tableMerge.ts``:

- :func:`project_sheet_into_rows` (person → rows): runs at save time (the
  save endpoints call it through :func:`~langchain_canvas.replay.encode_artifact`),
  so stored ``rows`` always reflect what the person sees — including typed
  formulas, projected as their source text, never their cached value. This
  establishes the invariant "at every save, rows equal the sheet's data
  rectangle".
- :func:`merge_rows_into_sheet` (agent → sheet): runs where the sheet is
  consumed (the xlsx exporter). Under the invariant, a rectangle cell whose
  rows value differs was written by the agent after the last save, so the
  rows value wins; the cell's styling keys are preserved.

Known limits, by design: cells outside the rows rectangle (margin notes)
are preserved but stay invisible to ``rows``/CSV/agents; agent row deletion
truncates trailing sheet rows (their formatting goes too) while a mid-table
insert/delete keeps values right but leaves row-level formatting at its old
index; agent column deletion is not propagated; only the first sheet is
reconciled.
"""

from __future__ import annotations

from typing import Any

#: Keys of a grid cell object that carry the value; the rest is styling.
_VALUE_KEYS = ("v", "m", "ct", "f", "qp", "spl")


def _is_formula(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("=")


def _normalized_value(value: Any) -> str | None:
    """Comparison form: empty forms fold together, numeric strings equal
    their numbers — ``80`` vs ``"80"`` must never read as a change."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return _number_text(float(value))
    text = str(value).strip()
    if not text:
        return None
    try:
        return _number_text(float(text))
    except ValueError:
        return text


def _number_text(num: float) -> str:
    return str(int(num)) if num == int(num) else str(num)


def _normalized_formula(f: Any) -> str | None:
    if isinstance(f, str) and f.strip():
        return f.strip().lstrip("=")
    return None


def same_cell_content(rows_value: Any, cell_v: Any) -> bool:
    """True when a rows value and a sheet cell hold the same content."""
    cell_formula = _normalized_formula(cell_v.get("f")) if isinstance(cell_v, dict) else None
    if _is_formula(rows_value) or cell_formula is not None:
        return _normalized_formula(rows_value) == cell_formula
    if isinstance(cell_v, dict):
        cell_value = cell_v.get("v") if cell_v.get("v") is not None else cell_v.get("m")
    else:
        cell_value = cell_v
    return _normalized_value(rows_value) == _normalized_value(cell_value)


def cell_map(sheet: dict[str, Any]) -> dict[tuple[int, int], Any]:
    """The sheet's cells keyed ``(r, c)`` — from ``celldata`` or the dense
    ``data`` matrix the grid emits from live state."""
    cells: dict[tuple[int, int], Any] = {}
    celldata = sheet.get("celldata")
    if celldata:
        for cell in celldata:
            if isinstance(cell, dict) and cell.get("v") is not None:
                cells[(int(cell["r"]), int(cell["c"]))] = cell["v"]
        return cells
    for r, row in enumerate(sheet.get("data") or []):
        for c, cell in enumerate(row or []):
            if cell is not None:
                cells[(r, c)] = cell
    return cells


def _projected_value(cell_v: Any) -> Any:
    """A sheet cell's content for rows: the typed formula when present
    (``f`` wins — a formula must stay a formula in rows), else the value."""
    if cell_v is None:
        return ""
    if not isinstance(cell_v, dict):
        return cell_v
    formula = _normalized_formula(cell_v.get("f"))
    if formula is not None:
        return f"={formula}"
    value = cell_v.get("v") if cell_v.get("v") is not None else cell_v.get("m")
    return "" if value is None else value


def project_sheet_into_rows(
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    sheet: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Person → rows: rows rebuilt from the sheet's data rectangle.

    Row keys outside ``columns`` are carried over untouched; trailing rows
    with no rectangle content are dropped (person-deleted), person-added
    rows extend the list.
    """
    first = sheet[0] if sheet else None
    if not isinstance(first, dict) or not columns:
        return rows
    cells = cell_map(first)

    deepest = 0
    for r, c in cells:
        if r >= 1 and c < len(columns):
            deepest = max(deepest, r)

    projected: list[dict[str, Any]] = []
    for i in range(deepest):
        row = dict(rows[i]) if i < len(rows) else {}
        for c, column in enumerate(columns):
            row[str(column.get("key"))] = _projected_value(cells.get((i + 1, c)))
        projected.append(row)
    return projected


def merge_rows_into_sheet(
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    sheet: list[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    """Agent → sheet: rectangle cells whose rows value differs are overridden
    by the rows value (styling keys preserved); trailing sheet rows beyond
    ``rows`` are dropped inside the rectangle. Returns ``sheet`` unchanged
    when nothing differs. Formula overrides carry the formula only — the
    spreadsheet app recomputes on open, matching the exporter's contract.
    """
    first = sheet[0] if sheet else None
    if not isinstance(first, dict) or not columns:
        return sheet
    cells = cell_map(first)

    overrides: dict[tuple[int, int], dict[str, Any] | None] = {}
    for c, column in enumerate(columns):
        label = column.get("label") or column.get("key")
        if not same_cell_content(label, cells.get((0, c))):
            overrides[(0, c)] = {"v": label, "m": str(label)}
        for i, row in enumerate(rows):
            value = row.get(str(column.get("key")))
            if not same_cell_content(value, cells.get((i + 1, c))):
                overrides[(i + 1, c)] = _value_cell(value)

    def in_rectangle(r: int, c: int) -> bool:
        return c < len(columns) and r >= 1

    ghosts = [key for key in cells if in_rectangle(*key) and key[0] > len(rows)]
    if not overrides and not ghosts:
        return sheet

    merged: list[dict[str, Any]] = []
    for (r, c), existing in cells.items():
        if in_rectangle(r, c) and r > len(rows):
            continue  # agent-deleted row — its formatting goes with it
        if (r, c) not in overrides:
            merged.append({"r": r, "c": c, "v": existing})
            continue
        style = (
            {k: v for k, v in existing.items() if k not in _VALUE_KEYS}
            if isinstance(existing, dict)
            else {}
        )
        next_value = overrides[(r, c)]
        v = style if next_value is None else {**style, **next_value}
        if v:
            merged.append({"r": r, "c": c, "v": v})
    for (r, c), next_value in overrides.items():
        if (r, c) in cells or next_value is None:
            continue
        merged.append({"r": r, "c": c, "v": next_value})
    merged.sort(key=lambda cell: (cell["r"], cell["c"]))

    merged_first = {k: v for k, v in first.items() if k != "data"}
    merged_first["celldata"] = merged
    merged_first["row"] = max(int(first.get("row") or 0), len(rows) + 40)
    merged_first["column"] = max(int(first.get("column") or 0), len(columns) + 2)
    return [merged_first, *list(sheet or [])[1:]]


def _value_cell(rows_value: Any) -> dict[str, Any] | None:
    if rows_value is None or rows_value == "":
        return None
    if _is_formula(rows_value):
        return {"f": rows_value}
    cell: dict[str, Any] = {"v": rows_value, "m": str(rows_value)}
    if isinstance(rows_value, (int, float)) and not isinstance(rows_value, bool):
        cell["ct"] = {"fa": "General", "t": "n"}
    return cell
