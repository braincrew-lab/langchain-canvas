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

This module owns the addresses, and it owns both ends of them: ``s0``..``sN``
for the grid sheets, ``rows`` for the agent's own rectangle, and ``B3`` for a
cell inside one. :func:`write_cells` and :func:`add_sheet` take the addresses
:func:`table_view` prints, so nothing has to be counted by hand to write
where you just read.
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

from .table_merge import _VALUE_KEYS, _value_cell, cell_map, project_sheet_into_rows

#: The address of the agent's own rectangle, beside the grid's ``s0``, ``s1``…
ROWS = "rows"

_A1 = re.compile(r"^([A-Za-z]+)([1-9][0-9]*)$")


def _letters(column: int) -> str:
    """A zero-based column as its spreadsheet letters: 0 -> A, 26 -> AA."""
    name = ""
    while True:
        name = chr(65 + column % 26) + name
        column = column // 26 - 1
        if column < 0:
            return name


def _at(ref: str) -> tuple[int, int]:
    """A cell address as zero-based ``(row, column)``. ``"B3"`` -> ``(2, 1)``."""
    found = _A1.match(ref.strip())
    if not found:
        raise ValueError(
            f"{ref!r} is not a cell address — write them like A1, B3, AA10"
        )
    column = 0
    for letter in found.group(1).upper():
        column = column * 26 + (ord(letter) - 64)
    return int(found.group(2)) - 1, column - 1


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


def _sheet_csv(sheet: dict[str, Any]) -> tuple[str, str]:
    """One sheet as (a note about its columns, CSV). One line is one row, so
    the line number a reader sees is the row number a writer names — a cell
    with a line break inside shows the break as ``\\n`` rather than running
    onto the next line and pushing every address below it out by one."""
    cells = cell_map(sheet)
    if not cells:
        return "", "(no values — this sheet holds formatting only)"
    height = max(r for r, _ in cells) + 1
    width = max(c for _, c in cells) + 1
    lines = []
    for r in range(height):
        out = io.StringIO()
        csv.writer(out, lineterminator="").writerow(
            [_content(cells.get((r, c)))[0].replace("\n", "\\n") for c in range(width)]
        )
        lines.append(out.getvalue())
    return f" (columns A-{_letters(width - 1)})", "\n".join(lines)


def table_view(content: str, sheet: str | None = None) -> str | None:
    """The table's map, or one addressed rectangle as CSV.

    ``None`` means the content is not a table envelope, so the caller reads
    it the ordinary way — a file broken enough to miss its own shape has to
    stay visible to be fixable. That includes an envelope of the wrong type
    saved under a table's name: calling it an empty table would hide what is
    really in there, and an agent that believes it would overwrite it. An
    unknown address raises ``ValueError`` naming the addresses that exist,
    which is the only guidance a caller needs to correct itself.
    """
    try:
        envelope = json.loads(content)
    except json.JSONDecodeError:
        return None
    if not isinstance(envelope, dict) or envelope.get("type") != "table":
        return None
    if not isinstance(envelope.get("data"), dict):
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
        columns_note, body = _sheet_csv(picked)
        return f"### sheet: {picked.get('name') or sheet}{columns_note}\n{body}"

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


def _grid_index(sheet: str, sheets: list[dict[str, Any]]) -> int:
    """A grid address as its index, or a refusal naming the ones that exist."""
    index = int(sheet[1:]) if sheet[:1] == "s" and sheet[1:].isdigit() else -1
    if not 0 <= index < len(sheets):
        have = ", ".join(f"s{i}" for i in range(len(sheets))) or "none yet"
        extra = f" ({ROWS} is the projection of s0 — write s0 instead)" if sheet == ROWS else ""
        raise ValueError(f"sheet must be one of: {have} (got {sheet!r}){extra}")
    return index


def _table(content: str) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    """The envelope, its data and its grid sheets, or a refusal."""
    try:
        envelope = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"the file is not valid JSON: {exc}") from exc
    if not isinstance(envelope, dict) or envelope.get("type") != "table":
        raise ValueError("the file is not a table")
    data = envelope.get("data")
    if not isinstance(data, dict):
        raise ValueError("the table has no data")
    return envelope, data, [s for s in (data.get("sheet") or []) if isinstance(s, dict)]


def _rewritten(envelope: dict[str, Any]) -> str:
    return json.dumps(envelope, ensure_ascii=False)


def write_cells(content: str, sheet: str, cells: dict[str, Any]) -> tuple[str, str]:
    """Put values into one grid sheet, addressed cell by cell.

    ``cells`` maps a cell address to what goes in it — ``{"B3": 42,
    "C3": "=B3*2"}``. A value starting with ``=`` stays a formula; an empty
    string clears the cell. Whatever styling a cell already carries stays on
    it, the same way the reconciler keeps it.

    Writing into ``s0`` also refreshes ``rows``, because ``rows`` is the
    projection of that sheet and the xlsx export reads it: left stale, the
    export would put the old values back over the new ones.
    """
    envelope, data, sheets = _table(content)
    index = _grid_index(sheet, sheets)
    if not cells:
        raise ValueError("no cells to write — pass at least one, like {\"A1\": \"Total\"}")

    target = sheets[index]
    grid = cell_map(target)
    written = {_at(ref): value for ref, value in cells.items()}
    for at, value in written.items():
        fresh = _value_cell(value)
        existing = grid.get(at)
        style = (
            {k: v for k, v in existing.items() if k not in _VALUE_KEYS}
            if isinstance(existing, dict)
            else {}
        )
        if fresh is None and not style:
            grid.pop(at, None)
        else:
            grid[at] = {**style, **(fresh or {})}

    # A sheet that stores a dense `data` matrix has to become celldata here:
    # the two are read as alternatives, so leaving both would hide every value
    # this sheet already had behind the handful just written.
    rebuilt = {k: v for k, v in target.items() if k != "data"}
    rebuilt["celldata"] = [
        {"r": r, "c": c, "v": v} for (r, c), v in sorted(grid.items())
    ]
    rebuilt["row"] = max(int(target.get("row") or 0), max(r for r, _ in written) + 8)
    rebuilt["column"] = max(int(target.get("column") or 0), max(c for _, c in written) + 2)
    data["sheet"] = [*sheets[:index], rebuilt, *sheets[index + 1:]]
    if index == 0:
        data["rows"] = project_sheet_into_rows(
            data.get("columns") or [], data.get("rows") or [], data["sheet"]
        )
    where = ", ".join(sorted(cells))
    note = f"Wrote {where} on {rebuilt.get('name') or sheet}."
    if index == 0:
        note += f" rows now has {len(data.get('rows') or [])} entries."
    return _rewritten(envelope), note


def add_sheet(content: str, name: str) -> tuple[str, str]:
    """Add an empty sheet at the end, named ``name``.

    New sheets go last and keep the addresses already handed out: ``s0`` is
    still ``s0`` after this, so a reader's map does not go stale.
    """
    envelope, data, sheets = _table(content)
    name = name.strip()
    if not name:
        raise ValueError("a sheet needs a name")
    if any((s.get("name") or "") == name for s in sheets):
        raise ValueError(f"this table already has a sheet named {name!r}")
    index = len(sheets)
    data["sheet"] = [
        *sheets,
        {
            "name": name,
            "id": f"sheet_{index}",
            "order": index,
            "status": 1 if index == 0 else 0,
            "row": 24,
            "column": 10,
            "celldata": [],
            "config": {"merge": {}, "columnlen": {}, "rowlen": {}, "borderInfo": []},
            "images": [],
        },
    ]
    return _rewritten(envelope), f'Added sheet "{name}" as s{index}.'
