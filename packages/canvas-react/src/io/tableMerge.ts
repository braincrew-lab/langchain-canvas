/**
 * Converging a table's two representations: `rows` and `sheet`.
 *
 * A table artifact carries the same data twice once a person has edited it:
 * the structured `columns`/`rows` (what agents read and write) and the
 * Fortune-sheet editor state `data.sheet` (what the grid renders — values
 * plus formatting, merges and typed formulas). Both accept writes, so the
 * two drift apart unless something reconciles them. This module is that
 * something, in both directions:
 *
 * - {@link projectSheetIntoRows} (person → rows): runs at save time, so the
 *   stored `rows` always reflect what the person sees. This establishes the
 *   invariant "at every save, rows equal the sheet's data rectangle" — the
 *   common ancestor that makes the merge below conflict-free.
 * - {@link mergeRowsIntoSheet} (agent → sheet): runs wherever the sheet is
 *   consumed (render, export). Starting from the sheet, any rectangle cell
 *   whose rows value differs is overridden with the rows value — under the
 *   invariant, "differs" means "the agent wrote it after the last save", so
 *   rows win. Style keys (bold, colors, merges, …) are preserved.
 *
 * Known limits, by design:
 * - Cells outside the rows rectangle (notes a person typed beside the
 *   table) are preserved in the sheet but stay invisible to `rows`, CSV
 *   and agents.
 * - Agent row deletion is propagated by truncating trailing sheet rows
 *   (their formatting goes with them); a mid-table row insert/delete keeps
 *   every value correct but leaves row-level formatting at its old index.
 * - Agent column deletion is not propagated (the sheet keeps the column).
 * - Only the first sheet is reconciled — `rows` model a single grid.
 */

import type { TableColumn, TableData } from "../protocol/artifacts";
import type { FormulaValues } from "./formula";

type SheetCell = { r: number; c: number; v?: unknown };
type Sheet = Record<string, unknown> & { celldata?: SheetCell[]; data?: unknown[][] };

const isFormula = (v: unknown): v is string => typeof v === "string" && v.startsWith("=");

/** Keys of a Fortune cell object that carry the value; the rest is styling. */
const VALUE_KEYS = ["v", "m", "ct", "f", "qp", "spl"] as const;

/** Normalize a cell value for comparison: empty forms fold together and a
 * numeric string equals its number, so `80` vs `"80"` never reads as a
 * change (a false "difference" would overwrite on every load). */
function normalizedValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = String(value).trim();
  if (text === "") return null;
  const num = Number(text);
  return Number.isNaN(num) ? text : String(num);
}

const normalizedFormula = (f: unknown): string | null =>
  typeof f === "string" && f.trim() ? f.trim().replace(/^=/, "") : null;

/** True when a rows value and a sheet cell hold the same content. */
export function sameCellContent(rowsValue: unknown, cellV: unknown): boolean {
  const cellFormula = cellV && typeof cellV === "object" ? normalizedFormula((cellV as { f?: unknown }).f) : null;
  if (isFormula(rowsValue) || cellFormula !== null) {
    return normalizedFormula(rowsValue) === cellFormula;
  }
  const cellValue =
    cellV && typeof cellV === "object"
      ? ((cellV as { v?: unknown; m?: unknown }).v ?? (cellV as { m?: unknown }).m ?? null)
      : cellV;
  return normalizedValue(rowsValue) === normalizedValue(cellValue);
}

/** The sheet's cells as a map keyed `"r,c"` (accepts celldata or the dense
 * data-matrix form Fortune emits from onChange). */
function cellMap(sheet: Sheet): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (sheet.celldata?.length) {
    for (const cell of sheet.celldata) {
      if (cell?.v != null) map.set(`${cell.r},${cell.c}`, cell.v);
    }
    return map;
  }
  (sheet.data ?? []).forEach((row, r) =>
    (row ?? []).forEach((cell, c) => {
      if (cell != null) map.set(`${r},${c}`, cell);
    }),
  );
  return map;
}

/** A sheet cell's content, for projecting into rows: the typed formula when
 * present (`f` wins over the cached value — a formula must stay a formula in
 * rows, or agents read it as a constant), else the value. */
function projectedValue(cellV: unknown): string | number {
  if (cellV === null || cellV === undefined) return "";
  if (typeof cellV !== "object") return cellV as string | number;
  const f = normalizedFormula((cellV as { f?: unknown }).f);
  if (f !== null) return `=${f}`;
  const v = (cellV as { v?: unknown; m?: unknown }).v ?? (cellV as { m?: unknown }).m;
  return v === null || v === undefined ? "" : (v as string | number);
}

/**
 * Person → rows: rows rebuilt from the sheet's data rectangle (display row 1
 * onward, one column per `columns` entry). Row keys outside `columns` are
 * carried over from the existing rows untouched. Trailing rows with no
 * content in the rectangle are dropped (a person deleting rows shrinks the
 * table); the row count otherwise follows the sheet's deepest content row,
 * so person-added rows extend `rows`.
 */
export function projectSheetIntoRows(
  columns: TableColumn[],
  rows: TableData["rows"],
  sheet: TableData["sheet"],
): TableData["rows"] {
  const first = sheet?.[0] as Sheet | undefined;
  if (!first || columns.length === 0) return rows;
  const cells = cellMap(first);

  let deepest = 0;
  for (const key of cells.keys()) {
    const [r, c] = key.split(",").map(Number);
    if (r >= 1 && c < columns.length) deepest = Math.max(deepest, r);
  }

  const projected: TableData["rows"] = [];
  for (let i = 0; i < deepest; i++) {
    const row: Record<string, string | number> = { ...(rows[i] ?? {}) };
    columns.forEach((col, c) => {
      row[col.key] = projectedValue(cells.get(`${i + 1},${c}`));
    });
    projected.push(row);
  }
  return projected;
}

/** The Fortune value keys for one rows value (cached formula results come
 * from `formulas`, keyed like `computeFormulas` output). */
function valueCell(
  rowsValue: unknown,
  dataIdx: number,
  col: number,
  formulas: FormulaValues | undefined,
): Record<string, unknown> | null {
  if (rowsValue === null || rowsValue === undefined || rowsValue === "") return null;
  if (isFormula(rowsValue)) {
    const out: Record<string, unknown> = { f: rowsValue };
    const computed = formulas?.get(`${dataIdx + 1},${col}`);
    if (computed !== undefined) {
      out.v = computed;
      out.m = String(computed);
      if (typeof computed === "number") out.ct = { fa: "General", t: "n" };
    }
    return out;
  }
  const numeric = typeof rowsValue === "number";
  return { v: rowsValue, m: String(rowsValue), ...(numeric ? { ct: { fa: "General", t: "n" } } : {}) };
}

/**
 * Agent → sheet: the sheet with every rectangle cell whose rows value
 * differs overridden by the rows value. Style keys on the overridden cell
 * are preserved; only value keys change. Trailing sheet rows beyond
 * `rows.length` are dropped inside the rectangle (agent row deletion —
 * their formatting goes with them; out-of-rectangle cells stay). A no-op
 * (returns the input array) when nothing differs, so mounts stay stable.
 */
export function mergeRowsIntoSheet(
  columns: TableColumn[],
  rows: TableData["rows"],
  sheet: TableData["sheet"],
  formulas?: FormulaValues,
): TableData["sheet"] {
  const first = sheet?.[0] as Sheet | undefined;
  if (!first || columns.length === 0) return sheet;
  const cells = cellMap(first);

  const overrides = new Map<string, Record<string, unknown> | null>();
  columns.forEach((col, c) => {
    // Header row follows the column labels.
    const label = col.label ?? col.key;
    if (!sameCellContent(label, cells.get(`0,${c}`))) {
      overrides.set(`0,${c}`, { v: label, m: String(label) });
    }
    rows.forEach((row, i) => {
      const value = row[col.key];
      if (!sameCellContent(value, cells.get(`${i + 1},${c}`))) {
        overrides.set(`${i + 1},${c}`, valueCell(value, i, c, formulas));
      }
    });
  });

  const inRectangle = (r: number, c: number) => c < columns.length && r >= 1;
  const ghosts = [...cells.keys()].filter((key) => {
    const [r, c] = key.split(",").map(Number);
    return inRectangle(r, c) && r > rows.length;
  });
  if (overrides.size === 0 && ghosts.length === 0) return sheet;

  const merged: SheetCell[] = [];
  const seen = new Set<string>();
  for (const [key, existing] of cells) {
    const [r, c] = key.split(",").map(Number);
    seen.add(key);
    if (inRectangle(r, c) && r > rows.length) continue; // agent-deleted row
    if (!overrides.has(key)) {
      merged.push({ r, c, v: existing });
      continue;
    }
    const next = overrides.get(key);
    const style =
      existing && typeof existing === "object"
        ? Object.fromEntries(
            Object.entries(existing as Record<string, unknown>).filter(
              ([k]) => !(VALUE_KEYS as readonly string[]).includes(k),
            ),
          )
        : {};
    const v = next === null ? style : { ...style, ...next };
    if (Object.keys(v).length > 0) merged.push({ r, c, v });
  }
  for (const [key, next] of overrides) {
    if (seen.has(key) || next === null) continue;
    const [r, c] = key.split(",").map(Number);
    merged.push({ r, c, v: next });
  }
  merged.sort((a, b) => a.r - b.r || a.c - b.c);

  const { data: _data, ...rest } = first;
  const mergedFirst: Sheet = {
    ...rest,
    celldata: merged,
    row: Math.max(Number(first.row) || 0, rows.length + 40),
    column: Math.max(Number(first.column) || 0, columns.length + 2),
  };
  return [mergedFirst, ...(sheet ?? []).slice(1)] as TableData["sheet"];
}
