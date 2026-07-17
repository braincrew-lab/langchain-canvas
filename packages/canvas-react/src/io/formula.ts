/**
 * Pre-compute spreadsheet formulas supplied in table data.
 *
 * Fortune-sheet evaluates formulas you *type*, but a formula that arrives as
 * data (an agent or an imported file sending `"=AVERAGE(B2:B4)"`) needs a cached
 * result to display on load. This resolves those cached values with a small MIT
 * formula engine (`fast-formula-parser`), loaded via dynamic import so it never
 * touches the main bundle — only tables that actually contain a formula pull it.
 *
 * Coordinates follow the on-screen grid: display row 1 is the header, data rows
 * start at row 2 — so `=C2` references the first data row's third column, exactly
 * as a user would read it.
 */

import type { TableColumn, TableData } from "../protocol/artifacts";
import { loadOptional } from "../optionalImport";

/** Map of `"<celldataRow>,<col>"` → computed value, for formula cells only. */
export type FormulaValues = Map<string, string | number>;

const EMPTY: FormulaValues = new Map();

export async function computeFormulas(columns: TableColumn[], rows: TableData["rows"]): Promise<FormulaValues> {
  const formulaCells: { dataIdx: number; col: number; formula: string }[] = [];
  rows.forEach((row, dataIdx) =>
    columns.forEach((col, c) => {
      const v = row[col.key];
      if (typeof v === "string" && v.startsWith("=")) formulaCells.push({ dataIdx, col: c, formula: v });
    }),
  );
  if (formulaCells.length === 0) return EMPTY;

  // @ts-ignore — fast-formula-parser (MIT) ships no type declarations.
  const mod = await loadOptional("fast-formula-parser", () => import("fast-formula-parser"));
  const FormulaParser = (mod as { default?: unknown }).default ?? mod;

  const memo = new Map<string, string | number>();
  const inProgress = new Set<string>();

  /** Raw cell content at 1-based display coordinates (row 1 = header). */
  const rawAt = (row: number, col: number): string | number | null => {
    const colIdx = col - 1;
    if (row === 1) return columns[colIdx]?.label ?? columns[colIdx]?.key ?? null;
    const dataRow = rows[row - 2];
    const column = columns[colIdx];
    if (!dataRow || !column) return null;
    const v = dataRow[column.key];
    return v ?? null;
  };

  // Resolve a cell to a value, recursively evaluating formula cells (memoized,
  // with a cycle guard so a self-referential formula degrades to 0).
  const valueAt = (row: number, col: number): string | number => {
    const raw = rawAt(row, col);
    if (typeof raw !== "string" || !raw.startsWith("=")) return raw ?? 0;
    const key = `${row},${col}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (inProgress.has(key)) return 0;
    inProgress.add(key);
    const value = evaluate(raw, row, col);
    inProgress.delete(key);
    memo.set(key, value);
    return value;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = new (FormulaParser as any)({
    onCell: ({ row, col }: { row: number; col: number }) => valueAt(row, col),
    onRange: (ref: { from: { row: number; col: number }; to: { row: number; col: number } }) => {
      // Clamp to the actual data extent so full-column refs like =SUM(A:A) don't
      // materialize ~1M empty cells and block the thread (empty cells are 0).
      const maxRow = Math.min(ref.to.row, rows.length + 1); // header row + data rows
      const maxCol = Math.min(ref.to.col, columns.length);
      const grid: (string | number)[][] = [];
      for (let r = ref.from.row; r <= maxRow; r++) {
        const line: (string | number)[] = [];
        for (let c = ref.from.col; c <= maxCol; c++) line.push(valueAt(r, c));
        grid.push(line);
      }
      return grid;
    },
  });

  const evaluate = (formula: string, row: number, col: number): string | number => {
    try {
      const result = parser.parse(formula.slice(1), { row, col });
      if (result != null && typeof result === "object") return "#ERR"; // FormulaError
      return (result as string | number) ?? 0;
    } catch {
      return "#ERR";
    }
  };

  const out: FormulaValues = new Map();
  for (const { dataIdx, col, formula } of formulaCells) {
    // Display coords are (dataIdx + 2, col + 1); celldata row is (dataIdx + 1).
    out.set(`${dataIdx + 1},${col}`, evaluate(formula, dataIdx + 2, col + 1));
  }
  return out;
}
