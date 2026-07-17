/**
 * Renders a `type: "table"` artifact as a real spreadsheet — Fortune-sheet
 * (MIT): merged cells, per-cell fonts/formats, formulas, freeze panes, and
 * multiple sheets, all editable in place.
 *
 * Agents emit the simple `{ columns, rows }` shape; we convert it to a
 * Fortune-sheet workbook and re-key as data streams in. When the user scrolls to
 * the bottom, more rows are appended automatically (by driving Fortune's own —
 * visually hidden — add-rows control, so growth is native and reset-free).
 *
 * Fortune-sheet touches `window` at import, so it's loaded lazily and only
 * rendered after mount (never during SSR).
 */

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";

import "@fortune-sheet/react/dist/index.css";

import type { TableColumn, TableData } from "../../protocol/artifacts";
import { computeFormulas, type FormulaValues } from "../../io/formula";
import type { RendererProps } from "../../registry/registry";

const Workbook = lazy(() => import("@fortune-sheet/react").then((m) => ({ default: m.Workbook })));

const isFormula = (v: unknown): v is string => typeof v === "string" && v.startsWith("=");

/** Convert the agent's simple columns/rows into a Fortune-sheet workbook. */
function toWorkbook(columns: TableColumn[], rows: TableData["rows"], formulas: FormulaValues): Record<string, unknown>[] {
  const celldata: Record<string, unknown>[] = [];
  columns.forEach((col, c) => {
    const label = col.label ?? col.key;
    celldata.push({ r: 0, c, v: { v: label, m: String(label), bl: 1, bg: "#f3f4f6" } });
  });
  rows.forEach((row, r) => {
    columns.forEach((col, c) => {
      const val = row[col.key];
      if (val === undefined || val === null || val === "") return;
      // A "=…" string is a formula. Fortune owns it live (re-evaluates on edit);
      // we also seed the cached result computed off-thread so it shows on load.
      if (isFormula(val)) {
        const computed = formulas.get(`${r + 1},${c}`);
        const v: Record<string, unknown> = { f: val };
        if (computed !== undefined) {
          v.v = computed;
          v.m = String(computed);
          if (typeof computed === "number") v.ct = { fa: "General", t: "n" };
        }
        celldata.push({ r: r + 1, c, v });
        return;
      }
      const numeric = typeof val === "number";
      celldata.push({
        r: r + 1,
        c,
        v: { v: val, m: String(val), ...(numeric ? { ct: { fa: "General", t: "n" } } : {}) },
      });
    });
  });
  return [
    {
      name: "Sheet1",
      id: "sheet1",
      order: 0,
      // A generously large grid so it scrolls smoothly in both directions like a
      // real spreadsheet — no dynamic row insertion mid-scroll (which jumps the
      // scrollbar). Grows past the defaults only when the data itself is larger.
      row: Math.max(rows.length + 100, 200),
      column: Math.max(columns.length + 8, 30),
      celldata,
      // No frozen pane: a freeze split offsets the initial scroll and hides the
      // first data rows behind the split line. A plain grid scrolls cleanly in
      // both directions, exactly like a default spreadsheet.
      config: { rowlen: { 0: 28 } },
    },
  ];
}

const EMPTY_FORMULAS: FormulaValues = new Map();

export function TableRenderer({ artifact }: RendererProps<TableData>) {
  const { columns, rows } = artifact.data;
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => setMounted(true), []);

  // Identity of the streamed data — the workbook re-keys on change (uncontrolled
  // afterward, so in-session edits are preserved between renders). `version` is
  // bumped on `canvas.replace`, so a new agent version refreshes even when the
  // row/column counts are unchanged.
  const dataKey = `${artifact.id}:v${artifact.version}:${columns.length}x${rows.length}`;
  const hasFormulas = useMemo(
    () => rows.some((row) => columns.some((col) => isFormula(row[col.key]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey],
  );

  // Formula cells are computed off the main bundle; until ready they render as
  // the raw formula, then re-key once cached values arrive.
  const [formulas, setFormulas] = useState<FormulaValues>(EMPTY_FORMULAS);
  const [formulasReady, setFormulasReady] = useState(!hasFormulas);
  useEffect(() => {
    if (!hasFormulas) {
      setFormulas(EMPTY_FORMULAS);
      setFormulasReady(true);
      return;
    }
    let alive = true;
    setFormulasReady(false);
    computeFormulas(columns, rows).then((values) => {
      if (!alive) return;
      setFormulas(values);
      setFormulasReady(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, hasFormulas]);

  const source = useMemo(
    () => toWorkbook(columns, rows, formulas),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey, formulas],
  );

  if (columns.length === 0) {
    return <div className="cv-sheet cv-sheet--empty">Waiting for data…</div>;
  }
  if (!mounted) {
    return <div className="cv-sheet cv-sheet--empty">Loading spreadsheet…</div>;
  }
  // Wait for formula pre-computation before mounting, so the workbook mounts once
  // with final values — no remount that could interrupt an in-progress edit.
  if (!formulasReady) {
    return <div className="cv-sheet cv-sheet--empty">Calculating…</div>;
  }

  return (
    <div className="cv-sheet" ref={rootRef}>
      <Suspense fallback={<div className="cv-sheet--empty">Loading…</div>}>
        <Workbook key={dataKey} data={source as never} />
      </Suspense>
    </div>
  );
}
