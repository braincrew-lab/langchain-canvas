"""The grid a table element draws.

One reading of ``rows`` / ``colWidths`` / ``rowHeights`` / ``cells``, shared
by the pptx exporter, the deck check and the outline, so the file, the
finding and the map agree on which cell sits where. The twin of
``canvas-react/src/client/slideTable.ts``, which the editor, the thumbnails
and the print sheet read.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

Cell = tuple[int, int]


@dataclass(frozen=True)
class TableGrid:
    rows: list[list[str]]
    #: Percent of the table's box, summing to 100.
    col_widths: list[float]
    row_heights: list[float]
    #: Merge origin -> (row span, column span), each at least 1.
    spans: dict[Cell, tuple[int, int]] = field(default_factory=dict)
    #: Cells a span covers — drawn by their origin, not themselves.
    covered: frozenset[Cell] = frozenset()
    #: Per-cell overrides, as written (camelCase keys).
    styles: dict[Cell, dict[str, Any]] = field(default_factory=dict)

    @property
    def n_rows(self) -> int:
        return len(self.rows)

    @property
    def n_cols(self) -> int:
        return len(self.rows[0]) if self.rows else 0


def shares(values: Any, count: int) -> list[float]:
    """``count`` shares summing to 100 — the given ones scaled, or equal ones
    when they are missing, the wrong length, or not all positive."""
    if count <= 0:
        return []
    if (
        isinstance(values, list)
        and len(values) == count
        and all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in values)
    ):
        total = float(sum(values))
        return [round(100.0 * float(v) / total, 3) for v in values]
    return [round(100.0 / count, 3)] * count


def table_grid(element: dict[str, Any]) -> TableGrid | None:
    """The grid of one ``type: "table"`` element, or ``None`` when it has no
    usable ``rows`` (a ragged or empty grid — the schema check names it)."""
    rows = element.get("rows")
    if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
        return None
    n_cols = len(rows[0])
    if n_cols == 0 or any(len(r) != n_cols for r in rows):
        return None
    text = [["" if v is None else str(v) for v in row] for row in rows]
    n_rows = len(text)
    spans: dict[Cell, tuple[int, int]] = {}
    covered: set[Cell] = set()
    styles: dict[Cell, dict[str, Any]] = {}
    for cell in element.get("cells") or []:
        if not isinstance(cell, dict):
            continue
        r, c = cell.get("r"), cell.get("c")
        if not (isinstance(r, int) and isinstance(c, int)):
            continue
        if not (0 <= r < n_rows and 0 <= c < n_cols):
            continue
        styles[(r, c)] = cell
        row_span = cell.get("rowSpan") or 1
        col_span = cell.get("colSpan") or 1
        if not (isinstance(row_span, int) and isinstance(col_span, int)):
            continue
        row_span = max(1, min(row_span, n_rows - r))
        col_span = max(1, min(col_span, n_cols - c))
        if (row_span, col_span) == (1, 1) or (r, c) in covered:
            continue
        spans[(r, c)] = (row_span, col_span)
        for rr in range(r, r + row_span):
            for cc in range(c, c + col_span):
                if (rr, cc) != (r, c):
                    covered.add((rr, cc))
    return TableGrid(
        rows=text,
        col_widths=shares(element.get("colWidths"), n_cols),
        row_heights=shares(element.get("rowHeights"), n_rows),
        spans=spans,
        covered=frozenset(covered),
        styles=styles,
    )
