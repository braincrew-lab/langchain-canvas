/**
 * Evaluate the formulas of one serialized grid sheet, in the sheet's own
 * coordinates — A1 is `celldata` `{r: 0, c: 0}`, exactly what the person
 * sees. The rows-shape engine (`formula.ts`) covers formulas that arrive in
 * the wire `rows`; this covers the grid state, where an agent's
 * `write_table_cells` puts them. Same engine, same custom functions, so the
 * two can never disagree.
 */

import { loadOptional } from "../optionalImport";
import { customFormulaFunctions } from "./formulaFunctions";

export interface SheetCellData {
  r: number;
  c: number;
  v?: unknown;
}

/** Map of `"<r>,<c>"` (0-based) → computed value, for formula cells only. */
export type SheetFormulaValues = Map<string, string | number>;

export async function computeSheetFormulas(celldata: SheetCellData[]): Promise<SheetFormulaValues> {
  const cells = new Map<string, Record<string, unknown>>();
  const formulas: { r: number; c: number; f: string }[] = [];
  let maxR = 0;
  let maxC = 0;
  for (const cell of celldata ?? []) {
    if (typeof cell?.r !== "number" || typeof cell?.c !== "number") continue;
    const v = cell.v;
    if (v !== null && typeof v === "object") {
      cells.set(`${cell.r},${cell.c}`, v as Record<string, unknown>);
      const f = (v as Record<string, unknown>).f;
      if (typeof f === "string" && f.trim()) formulas.push({ r: cell.r, c: cell.c, f });
    } else if (v !== undefined && v !== null) {
      cells.set(`${cell.r},${cell.c}`, { v });
    }
    maxR = Math.max(maxR, cell.r);
    maxC = Math.max(maxC, cell.c);
  }
  if (formulas.length === 0) return new Map();

  // @ts-ignore — fast-formula-parser (MIT) ships no type declarations.
  const mod = await loadOptional("fast-formula-parser", () => import("fast-formula-parser"));
  const FormulaParser = (mod as { default?: unknown }).default ?? mod;

  const memo = new Map<string, string | number>();
  const inProgress = new Set<string>();

  // Resolve a 1-based grid reference to a value, recursively evaluating
  // formula cells (memoized, with a cycle guard so a self-reference is 0).
  const valueAt = (row: number, col: number): string | number => {
    const cell = cells.get(`${row - 1},${col - 1}`);
    const formula = cell && typeof cell.f === "string" && cell.f.trim() ? (cell.f as string) : null;
    if (!formula) {
      const v = cell?.v;
      return typeof v === "number" || typeof v === "string" ? v : 0;
    }
    const key = `${row},${col}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (inProgress.has(key)) return 0;
    inProgress.add(key);
    const value = evaluate(formula, row, col);
    inProgress.delete(key);
    memo.set(key, value);
    return value;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = new (FormulaParser as any)({
    functions: customFormulaFunctions(),
    onCell: ({ row, col }: { row: number; col: number }) => valueAt(row, col),
    onRange: (ref: { from: { row: number; col: number }; to: { row: number; col: number } }) => {
      // Clamp to the sheet's extent so =SUM(A:A) doesn't materialize ~1M cells.
      const maxRow = Math.min(ref.to.row, maxR + 1);
      const maxCol = Math.min(ref.to.col, maxC + 1);
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
      const result = parser.parse(formula.replace(/^=/, ""), { row, col });
      if (result != null && typeof result === "object") return "#ERR"; // FormulaError
      return (result as string | number) ?? 0;
    } catch {
      return "#ERR";
    }
  };

  const out: SheetFormulaValues = new Map();
  for (const { r, c, f } of formulas) out.set(`${r},${c}`, valueAt(r + 1, c + 1));
  return out;
}
