"""Reading a table artifact as a map instead of a wall of JSON.

A ``.table.json`` file carries the table twice: ``columns``/``rows``, which
is what agents read and write, and ``data["sheet"]``, the grid editor state
a person sees — values plus formatting, merges and typed formulas. The
second one is enormous. A real five-sheet import in this repo's examples is
29,448,518 characters, of which the agent's share is 48,693: the rest is
the person's borders, recorded cell by cell. Handing that file over whole
spends the whole context on formatting nobody asked to read.

:func:`table_view` answers "what is in here, and where" — one screen naming
every rectangle, its size and what it holds — and then hands back one
addressed rectangle as CSV, in the same ``### sheet:`` shape an uploaded
workbook arrives in, so a reader learns one format for both.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from .table_merge import cell_map

#: The address of the agent's own rectangle, beside the grid's ``s0``, ``s1``…
ROWS = "rows"


def _content(cell: Any) -> tuple[str, bool]:
    """One grid cell as (text, is_formula) — the typed formula wins."""
    if not isinstance(cell, dict):
        return ("" if cell is None else str(cell)), False
    formula = cell.get("f")
    if isinstance(formula, str) and formula:
        return formula if formula.startswith("=") else f"={formula}", True
    value = cell.get("v") if cell.get("v") is not None else cell.get("m")
    return ("" if value is None else str(value)), False


def _count(n: int, thing: str) -> str:
    return f"{n:,} {thing}" if n == 1 else f"{n:,} {thing}s"


def _sheet_line(index: int, sheet: dict[str, Any]) -> str:
    cells = cell_map(sheet)
    values = formulas = 0
    for cell in cells.values():
        text, is_formula = _content(cell)
        values += bool(text)
        formulas += is_formula
    merges = len((sheet.get("config") or {}).get("merge") or {})
    size = f"{sheet.get('row') or 0} x {sheet.get('column') or 0} grid"
    held = _count(values, "value") if values else "no values"
    if formulas:
        held += ", " + _count(formulas, "formula")
    if merges:
        held += ", " + _count(merges, "merge")
    return f"[s{index}] {sheet.get('name') or f's{index}'} — {size}, {held}"


def _rows_csv(columns: list[Any], rows: list[Any]) -> str:
    keys = [str(column.get("key")) for column in columns if isinstance(column, dict)]
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(keys)
    for row in rows:
        writer.writerow(["" if row.get(key) is None else str(row.get(key)) for key in keys])
    return out.getvalue().rstrip("\n")


def _sheet_csv(sheet: dict[str, Any]) -> str:
    cells = cell_map(sheet)
    if not cells:
        return "(no values — this sheet holds formatting only)"
    height = max(r for r, _ in cells) + 1
    width = max(c for _, c in cells) + 1
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    for r in range(height):
        writer.writerow([_content(cells.get((r, c)))[0] for c in range(width)])
    return out.getvalue().rstrip("\n")


def table_view(content: str, sheet: str | None = None) -> str | None:
    """The table's map, or one addressed rectangle as CSV.

    ``None`` means the content is not a table envelope, so the caller reads
    it the ordinary way — a file broken enough to miss its own shape has to
    stay visible to be fixable. An unknown address raises ``ValueError``
    naming the addresses that exist, which is the only guidance a caller
    needs to correct itself.
    """
    try:
        envelope = json.loads(content)
    except json.JSONDecodeError:
        return None
    if not isinstance(envelope, dict) or not isinstance(envelope.get("data"), dict):
        return None
    data = envelope["data"]
    columns = [c for c in (data.get("columns") or []) if isinstance(c, dict)]
    rows = [r for r in (data.get("rows") or []) if isinstance(r, dict)]
    sheets = [s for s in (data.get("sheet") or []) if isinstance(s, dict)]

    if sheet is not None:
        if sheet == ROWS:
            return f"### sheet: {ROWS}\n{_rows_csv(columns, rows)}"
        index = int(sheet[1:]) if sheet[:1] == "s" and sheet[1:].isdigit() else -1
        if not 0 <= index < len(sheets):
            addresses = ", ".join([ROWS, *(f"s{i}" for i in range(len(sheets)))])
            raise ValueError(f"sheet must be one of: {addresses} (got {sheet!r})")
        picked = sheets[index]
        return f"### sheet: {picked.get('name') or sheet}\n{_sheet_csv(picked)}"

    title = envelope.get("title")
    lines = [f"table: {title}" if isinstance(title, str) and title else "table"]
    lines.append(f"[{ROWS}] {len(rows)} x {len(columns)} — what agents read and write")
    if columns:
        lines.append("       " + ", ".join(str(c.get("key")) for c in columns))
    lines.extend(_sheet_line(i, s) for i, s in enumerate(sheets))
    grid = ""
    if len(sheets) == 1:
        grid = ' or sheet="s0"'
    elif sheets:
        grid = f' or sheet="s0" .. "s{len(sheets) - 1}"'
    lines.append(
        f'Read one rectangle with sheet="{ROWS}"{grid}; offset/limit window its lines.'
    )
    if sheets:
        sheet_count = "the grid sheet" if len(sheets) == 1 else f"all {len(sheets)} grid sheets"
        lines.append(f"Replacing this file whole rewrites {sheet_count} — the formatting,")
        lines.append("merges and formulas only the grid holds are not in what you read here.")
    return "\n".join(lines)
