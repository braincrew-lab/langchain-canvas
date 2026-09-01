/**
 * One-shot formula evaluator CLI — the `check_table` tool's engine.
 *
 * Reads a `{columns, rows}` JSON payload (the wire `TableData` shape) on
 * stdin and writes the evaluation of every formula cell to stdout:
 *
 *     {"results": [{"row": 0, "col": 2, "key": "total",
 *                   "formula": "=SUM(B2:B4)", "value": 60}, ...]}
 *
 * `row` is the 0-based data-row index; `value` is what the canvas will
 * display (`"#ERR"` for a failed formula). It imports the exact module the
 * client uses to precompute formulas on load (`computeFormulas`, custom
 * registrations included), so a verifier built on this CLI can never drift
 * from what the canvas shows. Built as `dist/formula-cli.js`; run it as
 * `node dist/formula-cli.js`.
 */

import type { TableColumn, TableData } from "../protocol/artifacts";
import { computeFormulas } from "./formula";
import { computeSheetFormulas, type SheetCellData } from "./sheetFormula";

declare const process: {
  stdin: AsyncIterable<Uint8Array>;
  stdout: { write(text: string): void };
  exitCode?: number;
};

async function main(): Promise<void> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const merged = new Uint8Array(acc.length + c.length);
      merged.set(acc);
      merged.set(c, acc.length);
      return merged;
    }, new Uint8Array()),
  );

  const payload = JSON.parse(input) as {
    columns?: TableColumn[];
    rows?: TableData["rows"];
    sheets?: Array<{ celldata?: SheetCellData[] }>;
  };

  // Grid mode: `{sheets: [{celldata}]}` — every formula cell of each sheet,
  // in the sheet's own 0-based coordinates. Used to stamp computed values
  // at save time and to verify what the person's grid will show.
  if (payload.sheets) {
    const results: Array<Record<string, unknown>> = [];
    for (let index = 0; index < payload.sheets.length; index++) {
      const celldata = payload.sheets[index]?.celldata ?? [];
      const values = await computeSheetFormulas(celldata);
      for (const cell of celldata) {
        const v = cell?.v;
        const formula = v && typeof v === "object" ? (v as Record<string, unknown>).f : null;
        if (typeof formula !== "string" || !formula.trim()) continue;
        results.push({
          sheet: index,
          r: cell.r,
          c: cell.c,
          formula,
          value: values.get(`${cell.r},${cell.c}`) ?? null,
        });
      }
    }
    process.stdout.write(JSON.stringify({ results }));
    return;
  }

  const { columns, rows } = payload;
  const values = await computeFormulas(columns ?? [], rows ?? []);

  const results: Array<Record<string, unknown>> = [];
  (rows ?? []).forEach((row, dataIdx) =>
    (columns ?? []).forEach((col, colIdx) => {
      const v = row[col.key];
      if (typeof v !== "string" || !v.startsWith("=")) return;
      results.push({
        row: dataIdx,
        col: colIdx,
        key: col.key,
        formula: v,
        value: values.get(`${dataIdx + 1},${colIdx}`) ?? null,
      });
    }),
  );
  process.stdout.write(JSON.stringify({ results }));
}

main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ error: String(error) }));
  process.exitCode = 1;
});
