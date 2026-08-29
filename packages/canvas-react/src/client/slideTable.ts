/**
 * The grid a table element draws.
 *
 * One reading of `rows` / `colWidths` / `rowHeights` / `cells`, shared by the
 * editor, the thumbnails, the present view and the print sheet, so every
 * surface agrees on which cell sits where. The twin of
 * `canvas-py/src/langchain_canvas/slide_table.py`, which the pptx exporter,
 * the deck check and the outline read.
 */

import type { SlideElement, SlideTableCell } from "../protocol/artifacts";

export interface TableGrid {
  rows: string[][];
  nRows: number;
  nCols: number;
  /** Percent of the table's box, summing to 100. */
  colWidths: number[];
  rowHeights: number[];
  /** Merge origin (`"r,c"`) → [row span, column span], each at least 1. */
  spans: Map<string, [number, number]>;
  /** Cells a span covers — drawn by their origin, not themselves. */
  covered: Set<string>;
  /** Per-cell overrides, by `"r,c"`. */
  styles: Map<string, SlideTableCell>;
}

export const cellKey = (r: number, c: number) => `${r},${c}`;

/** `count` shares summing to 100 — the given ones scaled, or equal ones when
 *  they are missing, the wrong length, or not all positive. */
export function shares(values: number[] | undefined, count: number): number[] {
  if (count <= 0) return [];
  if (values && values.length === count && values.every((v) => Number.isFinite(v) && v > 0)) {
    const total = values.reduce((a, b) => a + b, 0);
    return values.map((v) => Math.round((100000 * v) / total) / 1000);
  }
  return Array.from({ length: count }, () => Math.round(100000 / count) / 1000);
}

/** The grid of one `type: "table"` element, or null when it has no usable
 *  `rows` (a ragged or empty grid). */
export function tableGrid(el: SlideElement): TableGrid | null {
  const rows = el.rows;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(Array.isArray)) return null;
  const nCols = rows[0].length;
  if (nCols === 0 || rows.some((r) => r.length !== nCols)) return null;
  const text = rows.map((r) => r.map((v) => (v == null ? "" : String(v))));
  const nRows = text.length;
  const spans = new Map<string, [number, number]>();
  const covered = new Set<string>();
  const styles = new Map<string, SlideTableCell>();
  for (const cell of el.cells ?? []) {
    const { r, c } = cell;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= nRows || c < 0 || c >= nCols) continue;
    styles.set(cellKey(r, c), cell);
    const rowSpan = Math.max(1, Math.min(cell.rowSpan ?? 1, nRows - r));
    const colSpan = Math.max(1, Math.min(cell.colSpan ?? 1, nCols - c));
    if ((rowSpan === 1 && colSpan === 1) || covered.has(cellKey(r, c))) continue;
    spans.set(cellKey(r, c), [rowSpan, colSpan]);
    for (let rr = r; rr < r + rowSpan; rr++)
      for (let cc = c; cc < c + colSpan; cc++) if (rr !== r || cc !== c) covered.add(cellKey(rr, cc));
  }
  return {
    rows: text,
    nRows,
    nCols,
    colWidths: shares(el.colWidths, nCols),
    rowHeights: shares(el.rowHeights, nRows),
    spans,
    covered,
    styles,
  };
}

/** The inset PowerPoint gives a cell (0.1in sides, 0.05in top and bottom at
 *  96dpi). The pptx exporter leaves the file's default, which is the same. */
export const CELL_PAD_X = 9.6;
export const CELL_PAD_Y = 4.8;
/** A table's text size when the element names none — the text default. */
export const TABLE_FONT_PX = 24;

export interface CellLook {
  fontSize: number;
  bold: boolean;
  color?: string;
  align: "left" | "center" | "right";
  fill?: string;
}

/** What one cell looks like: its own overrides over the table's defaults,
 *  with the header row bold unless told otherwise. */
export function cellLook(el: SlideElement, r: number, cell: SlideTableCell | undefined): CellLook {
  return {
    fontSize: cell?.fontSize ?? el.fontSize ?? TABLE_FONT_PX,
    bold: cell?.bold ?? el.bold ?? (el.header === true && r === 0),
    color: cell?.color ?? el.color,
    align: cell?.align ?? el.align ?? "left",
    fill: cell?.fill ?? el.fill,
  };
}
