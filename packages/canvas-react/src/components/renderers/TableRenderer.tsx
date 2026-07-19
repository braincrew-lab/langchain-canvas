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
  // Auto-fit each column to its widest cell (header included), like double-clicking
  // a column border in Excel — so long text isn't truncated. Clamped to sane bounds.
  // Sample at most the first ~400 rows to size columns — enough to fit content
  // without an O(rows × cols) scan stalling a very large sheet.
  const sample = Math.min(rows.length, 400);
  const columnlen: Record<number, number> = {};
  columns.forEach((col, c) => {
    let widest = String(col.label ?? col.key).length;
    for (let ri = 0; ri < sample; ri++) {
      let v = rows[ri][col.key];
      if (isFormula(v)) v = formulas.get(`${ri + 1},${c}`) ?? ""; // measure the result, not the source
      if (v != null && v !== "") widest = Math.max(widest, String(v).length);
    }
    columnlen[c] = Math.min(360, Math.max(64, Math.round(widest * 8.5) + 18));
  });

  return [
    {
      name: "Sheet1",
      id: "sheet1",
      order: 0,
      // Size the grid to the data plus a modest buffer — big enough to feel like a
      // real sheet and to keep growing, small enough that the scrollbar stays
      // proportional (a huge empty grid makes scrolling feel disconnected).
      row: Math.max(rows.length + 40, 60),
      column: Math.max(columns.length + 4, 16),
      celldata,
      // No frozen pane: a freeze split offsets the initial scroll and hides the
      // first data rows behind the split line. A plain grid scrolls cleanly.
      config: { rowlen: { 0: 28 }, columnlen },
    },
  ];
}

/** Columns from the union of row keys — a fallback when `columns` is omitted. */
function deriveColumns(rows: TableData["rows"]): TableColumn[] {
  const keys = new Set<string>();
  for (let i = 0; i < Math.min(rows.length, 50); i++) Object.keys(rows[i] ?? {}).forEach((k) => keys.add(k));
  return [...keys].map((key) => ({ key }));
}

const EMPTY_FORMULAS: FormulaValues = new Map();

export function TableRenderer({ artifact }: RendererProps<TableData>) {
  const rows = artifact.data.rows;
  // Fall back to deriving columns from the row keys, so a table that arrives with
  // rows but no explicit `columns` still renders instead of "Waiting for data".
  const columns = useMemo(
    () => (artifact.data.columns.length ? artifact.data.columns : deriveColumns(rows)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [artifact.id, artifact.version, artifact.data.columns.length, rows.length],
  );
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => setMounted(true), []);

  // Fortune-sheet advances only a couple of pixels per wheel notch, so a tall
  // sheet feels like the vertical scroll is stuck (hundreds of gestures to reach
  // the bottom). Forward the wheel delta 1:1 to its own scrollbars instead, for
  // natural scrolling — and only swallow the event when we actually moved, so
  // page scroll past the sheet's edges still works.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      const y = root.querySelector<HTMLElement>(".luckysheet-scrollbar-y");
      const x = root.querySelector<HTMLElement>(".luckysheet-scrollbar-x");
      let moved = false;
      if (y && e.deltaY && y.scrollHeight > y.clientHeight) {
        const max = y.scrollHeight - y.clientHeight;
        const next = Math.max(0, Math.min(max, y.scrollTop + e.deltaY));
        if (next !== y.scrollTop) { y.scrollTop = next; moved = true; }
      }
      if (x && e.deltaX && x.scrollWidth > x.clientWidth) {
        const max = x.scrollWidth - x.clientWidth;
        const next = Math.max(0, Math.min(max, x.scrollLeft + e.deltaX));
        if (next !== x.scrollLeft) { x.scrollLeft = next; moved = true; }
      }
      // A horizontal-dominant gesture must stay inside the sheet even at (or past)
      // the scroll edge — otherwise it leaks out and the surrounding layout grabs
      // it, so left–right scrolling feels like it "catches on the outside".
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (moved || (horizontal && e.deltaX)) { e.preventDefault(); e.stopPropagation(); }
    };
    root.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => root.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
  }, [mounted]);

  // Identity of the streamed data — the workbook re-keys on change (uncontrolled
  // afterward, so in-session edits are preserved between renders). `version` is
  // bumped on `canvas.replace`, so a new agent version refreshes even when the
  // row/column counts are unchanged.
  const dataKey = `${artifact.id}:v${artifact.version}:${columns.length}x${rows.length}`;
  const hasFormulas = useMemo(
    () => rows.slice(0, 400).some((row) => columns.some((col) => isFormula(row[col.key]))),
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

  if (!mounted) {
    return <div className="cv-sheet cv-sheet--empty">Loading spreadsheet…</div>;
  }
  // A rich imported workbook (all sheets, fonts/fills/formats/merges/widths) is
  // rendered as-is; the simple columns/rows path is only for agent-built tables.
  const sheet = artifact.data.sheet;
  if (sheet?.length) {
    return (
      <div className="cv-sheet" ref={rootRef}>
        <Suspense fallback={<div className="cv-sheet--empty">Loading…</div>}>
          <Workbook key={`${dataKey}:rich`} data={sheet as never} />
        </Suspense>
      </div>
    );
  }
  if (columns.length === 0) {
    return <div className="cv-sheet cv-sheet--empty">Waiting for data…</div>;
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
