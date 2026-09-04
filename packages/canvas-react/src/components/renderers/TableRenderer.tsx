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

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Fortune-sheet's grid styles. In source/dev consumers this resolves from the
// (dev)dependency; the tsup build bundles it (Fortune is noExternal) so the
// published package carries the styling without a runtime dependency.
import "@fortune-sheet/react/dist/index.css";

import type { WorkbookInstance } from "@fortune-sheet/react";

import type { TableColumn, TableData } from "../../protocol/artifacts";
import { computeFormulas, type FormulaValues } from "../../io/formula";
import { mergeRowsIntoSheet } from "../../io/tableMerge";
import { useCanvasStore } from "../../hooks/useCanvasStore";
import { useLabels } from "../chrome";
import type { RendererProps } from "../../registry/registry";

const Workbook = lazy(() => import("@fortune-sheet/react").then((m) => ({ default: m.Workbook })));

const isFormula = (v: unknown): v is string => typeof v === "string" && v.startsWith("=");

/**
 * True when a serialized Fortune sheet set holds any actual cell content.
 * Fortune fires `onChange` with an empty workbook when it mounts before its
 * data settles; treating that as real state would mask the artifact's rows
 * (and, persisted, survive reloads). Checked both when choosing what to
 * render and before writing sheet state back onto the artifact.
 */
export function sheetHasContent(sheet: TableData["sheet"]): boolean {
  if (!sheet?.length) return false;
  return sheet.some((s) => {
    const celldata = s.celldata as Array<{ v?: unknown }> | undefined;
    if (celldata?.some((cell) => cell?.v != null)) return true;
    const data = s.data as Array<Array<unknown>> | undefined;
    return !!data?.some((row) => row?.some((cell) => cell != null));
  });
}

/**
 * Canonicalize serialized sheets to the `celldata` form the Workbook accepts.
 * Fortune's `onChange` payload carries live state as a dense `data` matrix,
 * but `<Workbook data={...}>` only reads the sparse `celldata` list — feeding
 * the matrix form back (a reload of persisted state) renders an empty grid.
 * Volatile view state (`luckysheet_select_save`) is dropped along the way so
 * persisted sheets stay byte-stable across mounts.
 */
export function normalizeSheets(sheet: TableData["sheet"]): TableData["sheet"] {
  if (!sheet?.length) return sheet;
  return sheet.map((s) => {
    const { luckysheet_select_save: _selection, data, ...rest } = s as {
      luckysheet_select_save?: unknown;
      data?: Array<Array<unknown>>;
      celldata?: unknown;
    } & Record<string, unknown>;
    if (!data || rest.celldata) return rest;
    const celldata: Array<{ r: number; c: number; v: unknown }> = [];
    data.forEach((row, r) =>
      row?.forEach((cell, c) => {
        if (cell != null) celldata.push({ r, c, v: cell });
      }),
    );
    return { ...rest, celldata };
  });
}

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
      column: Math.max(columns.length + 2, 8),
      celldata,
      // No frozen pane: a freeze split offsets the initial scroll and hides the
      // first data rows behind the split line. A plain grid scrolls cleanly.
      config: { rowlen: { 0: 28 }, columnlen },
    },
  ];
}

/** Columns from the union of row keys — a fallback when `columns` is omitted. */
/**
 * The key the mounted workbook lives under. It changes only when the data
 * itself changes from outside (`dataKey`: agent writes, reloads) or a
 * sort/filter view takes over. It deliberately does NOT depend on whether the
 * artifact carries a `sheet` yet: the person's first edit of an agent-written
 * table is what creates `sheet`, and re-keying on that remounted the grid
 * under their hands — a sheet they had just added snapped back to Sheet1.
 */
export function workbookKey(dataKey: string, view: string): string {
  return `${dataKey}:${view}`;
}

function deriveColumns(rows: TableData["rows"]): TableColumn[] {
  const keys = new Set<string>();
  for (let i = 0; i < Math.min(rows.length, 50); i++) Object.keys(rows[i] ?? {}).forEach((k) => keys.add(k));
  return [...keys].map((key) => ({ key }));
}

const EMPTY_FORMULAS: FormulaValues = new Map();

export function TableRenderer({ artifact }: RendererProps<TableData>) {
  const labels = useLabels();
  // A table written by hand or by an agent may carry only `sheet`, or only
  // `rows`; neither absence is a reason to crash the tab.
  const rows = artifact.data.rows ?? [];
  const declaredColumns = artifact.data.columns ?? [];
  // Fall back to deriving columns from the row keys, so a table that arrives with
  // rows but no explicit `columns` still renders instead of "Waiting for data".
  const columns = useMemo(
    () => (declaredColumns.length ? declaredColumns : deriveColumns(rows)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [artifact.id, artifact.version, declaredColumns.length, rows.length],
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
  // bumped on `canvas.replace`; the content signature covers agent writes that
  // change cell values without changing the row count (an in-place edit must
  // reach the screen). Human edits patch only `sheet`, so typing never re-keys.
  const rowsSig = useMemo(() => {
    const json = JSON.stringify(rows);
    let hash = 5381;
    for (let i = 0; i < json.length; i++) hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
  }, [rows]);
  // `remoteSeq` counts the agent's (and reload's) writes: a sheet-only change
  // from the agent leaves version, columns and rows untouched, and without
  // this the grid kept showing the old cells until a page reload.
  const remoteSeq = typeof artifact.meta?.remoteSeq === "number" ? artifact.meta.remoteSeq : 0;
  const dataKey = `${artifact.id}:v${artifact.version}:r${remoteSeq}:${columns.length}x${rows.length}:${rowsSig}`;
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

  const hasSheet = sheetHasContent(artifact.data.sheet);

  // Non-destructive sort / filter over the structured rows. Only offered for a
  // rows-backed table — once the user edits into a Fortune sheet, that sheet is the
  // source of truth and its own header menu owns sorting. The filter is debounced
  // so the workbook doesn't remount on every keystroke.
  const [sortCol, setSortCol] = useState("");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setAppliedFilter(filter), 300);
    return () => clearTimeout(t);
  }, [filter]);
  const viewRows = useMemo(() => {
    let r = rows;
    const q = appliedFilter.trim().toLowerCase();
    if (q) r = r.filter((row) => columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q)));
    if (sortCol) {
      r = [...r].sort((a, b) => {
        const av = a[sortCol];
        const bv = b[sortCol];
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av ?? "").localeCompare(String(bv ?? ""));
        return cmp * sortDir;
      });
    }
    return r;
  }, [rows, columns, appliedFilter, sortCol, sortDir]);
  // A sort or filter takes over the view: the workbook renders the transformed
  // rows (Fortune auto-serializes a `sheet` on mount, so we can't gate on that).
  // With no sort/filter, normal behavior — a rich sheet as-is, else the rows.
  const viewActive = !!appliedFilter.trim() || !!sortCol;
  const wbKey = workbookKey(dataKey, viewActive ? `view-s${sortCol}${sortDir}-f${appliedFilter}` : "live");

  // The workbook's data is frozen at mount (keyed by wbKey). In-sheet edits are
  // owned by Fortune and mirrored back via onChange — they must NOT feed back into
  // this prop or it resets mid-edit.
  const initialData = useMemo(
    () =>
      viewActive
        ? toWorkbook(columns, viewRows, formulas)
        : hasSheet
          ? // Rows the agent wrote after the person's last edit win their cells;
            // the person's formatting and out-of-table cells survive.
            mergeRowsIntoSheet(columns, rows, normalizeSheets(artifact.data.sheet), formulas)!
          : toWorkbook(columns, rows, formulas),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wbKey, formulasReady],
  );

  // Persist in-sheet edits (cell values, inserted rows/columns, images, styling)
  // back onto the artifact so they survive re-renders and flow into exports.
  // Debounced, since Fortune fires onChange on every keystroke; writes only
  // `data.sheet` with no version bump, so the workbook is never remounted.
  // A user edit — routed through applyUserEvent so it lands on the undo stack and
  // fires the host's onUserEdit write-back hook.
  const applyEvent = useCanvasStore((s) => s.applyUserEvent);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fortune normalises the workbook it was handed and reports that back through
  // onChange on mount — column widths, border records — before anyone touched
  // it. Persisting that wrote a version of every opened spreadsheet with no
  // edit in it. A change counts once the person has pointed at or typed into
  // the grid; the workbook remounts (new wbKey) re-arm the gate.
  const interactedRef = useRef(false);
  useEffect(() => {
    interactedRef.current = false;
  }, [wbKey]);
  const handleChange = useCallback(
    (sheets: unknown) => {
      if (!interactedRef.current) return;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        // Never let an empty mount-time serialization replace real content —
        // it would blank the table and, persisted, survive reloads. (The rare
        // hand edit that clears every cell is the accepted trade-off.)
        if (!sheetHasContent(sheets as TableData["sheet"])) return;
        applyEvent({
          type: "canvas.patch",
          id: artifact.id,
          patch: { sheet: normalizeSheets(sheets as TableData["sheet"]) },
        });
      }, 400);
    },
    [applyEvent, artifact.id],
  );
  useEffect(() => () => { if (persistTimer.current) clearTimeout(persistTimer.current); }, []);

  // Discoverable row/column inserts (the right-click menu is easy to miss). Insert
  // next to the current selection, or at the top-left if nothing is selected.
  const wbRef = useRef<WorkbookInstance>(null);
  const insert = (type: "row" | "column") => {
    interactedRef.current = true; // the toolbar sits outside the grid, but this is an edit
    const sel = wbRef.current?.getSelection?.();
    const range = sel?.[0]?.[type] ?? [0, 0];
    wbRef.current?.insertRowOrColumn(type, Math.max(0, range[1]), 1, "rightbottom");
  };

  if (!mounted) {
    return <div className="cv-sheet cv-sheet--empty">{labels.tableLoading}</div>;
  }
  if (!hasSheet && columns.length === 0) {
    return <div className="cv-sheet cv-sheet--empty">{labels.tableWaiting}</div>;
  }
  // Wait for formula pre-computation before mounting, so the workbook mounts once
  // with final values — no remount that could interrupt an in-progress edit.
  // (Applies to sheet-backed tables too: the merge seeds cached results for
  // agent-written formula cells.)
  if (!formulasReady) {
    return <div className="cv-sheet cv-sheet--empty">{labels.tableCalculating}</div>;
  }

  return (
    <div className="cv-sheet-panel">
      <div className="cv-sheet-tools">
        <button type="button" onClick={() => insert("column")}>{labels.addColumn}</button>
        <button type="button" onClick={() => insert("row")}>{labels.addRow}</button>
        {columns.length > 0 && (
          <>
            <span className="cv-sheet-tools__sep" />
            <select
              className="cv-sheet-tools__sort"
              value={sortCol}
              title={labels.sortBy}
              onChange={(e) => setSortCol(e.target.value)}
            >
              <option value="">{labels.sortPick}</option>
              {columns.map((c) => (
                <option key={c.key} value={c.key}>{c.label ?? c.key}</option>
              ))}
            </select>
            {sortCol && (
              <button type="button" title={sortDir === 1 ? labels.ascending : labels.descending} onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))}>
                {sortDir === 1 ? "▲" : "▼"}
              </button>
            )}
            <input
              className="cv-sheet-tools__filter"
              value={filter}
              placeholder={labels.filterPlaceholder}
              onChange={(e) => setFilter(e.target.value)}
              title={labels.filterRows}
            />
          </>
        )}
        <span className="cv-sheet-tools__hint">{labels.tableHint}</span>
      </div>
      <div
        className="cv-sheet"
        ref={rootRef}
        onPointerDownCapture={() => {
          interactedRef.current = true;
        }}
        onKeyDownCapture={() => {
          interactedRef.current = true;
        }}
      >
        <Suspense fallback={<div className="cv-sheet--empty">{labels.loading}</div>}>
          <Workbook key={wbKey} ref={wbRef} data={initialData as never} onChange={handleChange} />
        </Suspense>
      </div>
    </div>
  );
}
