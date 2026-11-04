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

import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
// @ts-expect-error — react-dom is a peer dependency; this package does not ship its types.
import { createPortal } from "react-dom";

// Fortune-sheet's grid styles. In source/dev consumers this resolves from the
// (dev)dependency; the tsup build bundles it (Fortune is noExternal) so the
// published package carries the styling without a runtime dependency.
import "@fortune-sheet/react/dist/index.css";
import "./sheet-viewer.css";

import type { WorkbookInstance } from "@fortune-sheet/react";
import type { Cell, Selection, Sheet } from "@fortune-sheet/core";

import type { TableColumn, TableData } from "../../protocol/artifacts";
import { computeFormulas, type FormulaValues } from "../../io/formula";
import { mergeRowsIntoSheet } from "../../io/tableMerge";
import { useCanvasStore } from "../../hooks/useCanvasStore";
import { useViewerSession } from "../../hooks/viewerSession";
import { applyWorkbookView, connectWorkbookReading, parseCellAddress, summarizeSelection, type WorkbookReadingConnection, type WorkbookView } from "./workbookReading";
import { SHEET_PAINT_HOOKS } from "./sheetPaint";
import { useLabels } from "../chrome";
import type { RendererProps } from "../../registry/registry";
import { sameElementReference, useElementSelection } from "../../hooks/elementSelection";
import type { CanvasElement, CanvasElementReference } from "../../protocol/elements";

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

/** The sheets a workbook mounts with, outside a sort/filter view. */
export function baseSheets(
  columns: TableColumn[],
  rows: TableData["rows"],
  sheet: TableData["sheet"],
  formulas: FormulaValues,
  readOnly: boolean,
): TableData["sheet"] {
  // A read-only workbook is the file as the host parsed it, pictures included
  // (a chart-only sheet has no cell values). Its rows are a lossy first-sheet
  // projection (header taken, empty rows dropped), so they never overlay it.
  if (readOnly && sheet?.length) return normalizeSheets(sheet);
  // Rows the agent wrote after the person's last edit win their cells; the
  // person's formatting and out-of-table cells survive.
  if (!sheetHasContent(sheet)) return toWorkbook(columns, rows, formulas);
  return mergeRowsIntoSheet(columns, rows, normalizeSheets(sheet), formulas)!;
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

/** Fortune-sheet settings for a grid that is looked at, not typed into. */
const READ_ONLY_SETTINGS = {
  allowEdit: false,
  showToolbar: false,
  showFormulaBar: false,
  showSheetTabs: true,
  forceCalculation: false,
  cellContextMenu: [],
  headerContextMenu: [],
  sheetTabContextMenu: [],
  filterContextMenu: [],
};

/** Fortune-sheet's column width and row height (px) for an unsized column/row. */
const DEFAULT_COLUMN_PX = 73;
const DEFAULT_ROW_PX = 19;

function countToCover(
  count: number,
  lengths: Record<string, number> | undefined,
  fallback: number,
  span: number,
): number {
  let covered = 0;
  for (let i = 0; i < count; i++) covered += lengths?.[i] ?? fallback;
  return covered >= span ? count : count + Math.ceil((span - covered) / fallback);
}

/**
 * Grow each sheet's row and column count until the grid covers `width` × `height`
 * px. Fortune draws nothing past a sheet's last row or column, so a sheet sized to
 * its data leaves a blank strip once the panel is wider or taller than that data.
 * Counts only grow; stored row heights and column widths are counted as they are.
 */
export function padSheetsToArea(
  sheets: TableData["sheet"],
  width: number,
  height: number,
): TableData["sheet"] {
  return sheets?.map((sheet) => {
    const config = (sheet.config ?? {}) as {
      columnlen?: Record<string, number>;
      rowlen?: Record<string, number>;
    };
    return {
      ...sheet,
      column: countToCover(Number(sheet.column) || 0, config.columnlen, DEFAULT_COLUMN_PX, width),
      row: countToCover(Number(sheet.row) || 0, config.rowlen, DEFAULT_ROW_PX, height),
    };
  });
}

/**
 * Call `onChange` (at most once per frame) when the element's box actually changes
 * size. Returns the cleanup.
 */
export function watchBoxSize(element: HTMLElement, onChange: () => void): () => void {
  let last = `${element.clientWidth}x${element.clientHeight}`;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    const size = `${element.clientWidth}x${element.clientHeight}`;
    if (size === last) return;
    last = size;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(onChange);
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}

function cellAddress(row: number, column: number): string {
  let letters = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  }
  return `${letters}${row + 1}`;
}

/** Preserve the actual native rectangle, not the focused cell used by the inspector. */
export function selectionRange(selection: Selection): string | null {
  const coordinates = [...selection.row, ...selection.column];
  if (selection.row.length !== 2 || selection.column.length !== 2 ||
    coordinates.some((n) => !Number.isInteger(n) || n < 0) ||
    selection.row.some((n) => n >= 1048576) || selection.column.some((n) => n >= 16384)) return null;
  if ((Math.abs(selection.row[1] - selection.row[0]) + 1) *
    (Math.abs(selection.column[1] - selection.column[0]) + 1) > 10000) return null;
  const first = cellAddress(Math.min(...selection.row), Math.min(...selection.column));
  const last = cellAddress(Math.max(...selection.row), Math.max(...selection.column));
  return first === last ? first : `${first}:${last}`;
}

type CellInspection = { sheet: string; address: string; range: string | null; sourceKey: string; formula: string; value: string; missing: boolean; count: number; sum: number; average: number };

// These hooks supplement allowEdit=false; no mutation menu or paste path is
// needed by the viewer. Selection, copying, scrolling and sheet activation stay native.
const READ_ONLY_HOOKS = {
  ...SHEET_PAINT_HOOKS,
  beforeUpdateCell: () => false,
  beforePaste: () => false,
  beforeAddSheet: () => false,
  beforeDeleteSheet: () => false,
  beforeUpdateSheetName: () => false,
  beforeUpdateComment: () => false,
  beforeInsertComment: () => false,
  beforeDeleteComment: () => false,
};

export function TableRenderer({
  artifact,
  readOnly = false,
  elementSource,
}: RendererProps<TableData> & {
  /** Read-only means the parsed `sheet` is the truth; `rows` are never merged into it. */
  readOnly?: boolean;
  /** Only a native stored workbook can supply authoritative sheet/range references. */
  elementSource?: { path: string; revision?: string };
}) {
  const labels = useLabels();
  const elementSelection = useElementSelection();
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

  // Forward wheel gestures to Fortune's scrollbars in pixel units. Preserve
  // native edge propagation when the grid cannot move any further vertically.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      // Native tabs and zoom own their gestures, not the grid scrollbars.
      if (readOnly && (e.ctrlKey || (e.target instanceof Element && e.target.closest(".luckysheet-sheet-area")))) return;
      const y = root.querySelector<HTMLElement>(".luckysheet-scrollbar-y");
      const x = root.querySelector<HTMLElement>(".luckysheet-scrollbar-x");
      const lineHeight = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? Number.parseFloat(getComputedStyle(root).lineHeight) || 16 : 1;
      const deltaY = e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? (y?.clientHeight || root.clientHeight) : lineHeight);
      const deltaX = e.deltaX * (e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? (x?.clientWidth || root.clientWidth) : lineHeight);
      let moved = false;
      if (y && e.deltaY && y.scrollHeight > y.clientHeight) {
        const max = y.scrollHeight - y.clientHeight;
        const next = Math.max(0, Math.min(max, y.scrollTop + deltaY));
        if (next !== y.scrollTop) { y.scrollTop = next; moved = true; }
      }
      if (x && e.deltaX && x.scrollWidth > x.clientWidth) {
        const max = x.scrollWidth - x.clientWidth;
        const next = Math.max(0, Math.min(max, x.scrollLeft + deltaX));
        if (next !== x.scrollLeft) { x.scrollLeft = next; moved = true; }
      }
      // A horizontal-dominant gesture must stay inside the sheet even at (or past)
      // the scroll edge — otherwise it leaks out and the surrounding layout grabs
      // it, so left–right scrolling feels like it "catches on the outside".
      const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
      if (moved || (horizontal && e.deltaX)) { e.preventDefault(); e.stopPropagation(); }
    };
    root.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => root.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
  }, [mounted, readOnly]);

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
  const viewerSession = useViewerSession<WorkbookView>(`workbook:${artifact.id}`, dataKey, () => ({ sheets: {} }));
  const hasFormulas = useMemo(
    () => !(readOnly && artifact.data.sheet?.length) && rows.slice(0, 400).some((row) => columns.some((col) => isFormula(row[col.key]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey, readOnly, artifact.data.sheet],
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

  // Fortune-sheet re-measures its canvas only on a window resize. A host that
  // resizes the panel without one (a drag handle, a collapsing sidebar) left the
  // grid at its old size beside a blank area, so replay that resize here.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    return watchBoxSize(root, () => window.dispatchEvent(new Event("resize")));
  }, [mounted, formulasReady, hasSheet, columns.length]);

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
  const initialData = useMemo(() => {
    const sheets = viewActive
      ? toWorkbook(columns, viewRows, formulas)
      : baseSheets(columns, rows, artifact.data.sheet, formulas, readOnly);
    if (!readOnly || typeof window === "undefined") return sheets;
    // A read-only grid is sized to its data; cover the largest area the panel can
    // grow to (the screen) so resizing never reveals the end of the sheet.
    return padSheetsToArea(
      sheets,
      Math.max(window.innerWidth, window.screen?.availWidth ?? 0),
      Math.max(window.innerHeight, window.screen?.availHeight ?? 0),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wbKey, formulasReady, readOnly]);
  const viewerData = useMemo(() => readOnly && initialData
    ? applyWorkbookView(initialData as Sheet[], viewerSession.current)
    : initialData, [initialData, readOnly, viewerSession]);

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

  // Inspect the parsed source, not Fortune's mutable calculation state: original
  // formula text, formatting and saved results remain the authority in a preview.
  const sheetIndex = useMemo(() => readOnly ? (initialData as Sheet[] | undefined)?.map((sheet, index) => {
    const cells = new Map<string, Cell | null>();
    let rowCount = sheet.row ?? 84;
    let columnCount = sheet.column ?? 60;
    for (const { r, c, v } of sheet.celldata ?? []) {
      cells.set(`${r},${c}`, v);
      rowCount = Math.max(rowCount, r + 1);
      columnCount = Math.max(columnCount, c + 1);
    }
    return { sheet, id: sheet.id ?? `viewer-sheet-${index}`, cells, rowCount, columnCount };
  }) ?? [] : [], [initialData, readOnly]);
  const sheetIds = useMemo(() => (viewerData as Sheet[] | undefined)?.map((sheet) => ({ id: sheet.id!, order: Number(sheet.order) }))
    .sort((a, b) => (Number.isNaN(a.order) ? Infinity : a.order) - (Number.isNaN(b.order) ? Infinity : b.order))
    .map(({ id }) => id) ?? [], [viewerData]);
  const readingConnection = useRef<WorkbookReadingConnection | null>(null);
  const [inspection, setInspection] = useState<CellInspection | null>(null);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const addressErrorId = useId();
  const selectionSourceKey = JSON.stringify([dataKey, elementSource?.path, elementSource?.revision]);
  const addressEditing = useRef(false);
  const lastInspection = useRef<{ source: Sheet; key: string } | null>(null);
  const inspectSelection = useCallback((sheetId: string, selection: Selection) => {
    const source = sheetIndex.find(({ id }) => id === sheetId);
    if (!source || !selection) { setInspection(null); return; }
    const multipleRanges = (wbRef.current?.getSelection()?.length ?? 1) > 1;
    const key = `${selectionSourceKey}:${sheetId}:${selection.row.join(",")}:${selection.column.join(",")}:${selection.row_focus}:${selection.column_focus}:${multipleRanges}`;
    if (lastInspection.current?.source === source.sheet && lastInspection.current.key === key) return;
    lastInspection.current = { source: source.sheet, key };
    let row = selection.row_focus ?? selection.row[0];
    let column = selection.column_focus ?? selection.column[0];
    let cell: Cell | null | undefined = source.cells.get(`${row},${column}`);
    const merge = cell?.mc ?? Object.values(source.sheet.config?.merge ?? {}).find(
      (range) => row >= range.r && row < range.r + range.rs && column >= range.c && column < range.c + range.cs,
    );
    if (merge) {
      row = merge.r;
      column = merge.c;
      cell = source.cells.get(`${row},${column}`);
    }
    const richText = cell?.ct?.t === "inlineStr" && Array.isArray(cell.ct.s)
      ? cell.ct.s.map((run: { v?: unknown }) => String(run.v ?? "")).join("") : undefined;
    const value = cell?.m ?? cell?.v ?? richText;
    const next = {
      ...summarizeSelection(source.sheet.celldata ?? [], selection),
      sheet: source.sheet.name,
      address: cellAddress(row, column),
      range: multipleRanges ? null : selectionRange(selection),
      sourceKey: selectionSourceKey,
      formula: cell?.f ?? "",
      value: value == null ? "" : String(value),
      // The wire format uses an empty string for both absent and empty caches.
      missing: !!cell?.f && (value == null || value === ""),
    };
    setInspection((previous) => previous && Object.keys(next).every((key) => previous[key as keyof CellInspection] === next[key as keyof CellInspection]) ? previous : next);
    if (!addressEditing.current) setAddress(next.address);
  }, [sheetIndex, viewerSession, selectionSourceKey]);
  const viewerHooks = useMemo(() => ({ ...READ_ONLY_HOOKS, afterSelectionChange: (sheetId: string, selection: Selection) => {
    if (readingConnection.current) readingConnection.current.selectionChanged(sheetId, selection);
    else inspectSelection(sheetId, selection);
  } }), [inspectSelection]);
  const captureViewerZoom = useCallback((sheets: Sheet[]) => {
    for (const sheet of sheets) {
      const saved = sheet.id ? viewerSession.current.sheets[sheet.id] : undefined;
      if (saved && sheet.zoomRatio != null) saved.zoom = sheet.zoomRatio;
    }
  }, [viewerSession]);

  useEffect(() => {
    const root = rootRef.current;
    if (!readOnly || !root) return;
    const connection = connectWorkbookReading(root, () => wbRef.current, viewerSession.current, sheetIds, {
      zoomIn: labels.viewerZoomIn, zoomOut: labels.viewerZoomOut,
    }, inspectSelection, setFooter);
    readingConnection.current = connection;
    return () => { connection(); readingConnection.current = null; };
  }, [mounted, readOnly, wbKey, formulasReady, viewerSession, sheetIds, inspectSelection, labels.viewerZoomIn, labels.viewerZoomOut]);

  const navigateToAddress = () => {
    const target = parseCellAddress(address);
    if (!target) { setAddressError(labels.sheetInvalidAddress); return; }
    const workbook = wbRef.current;
    const sheet = sheetIndex.find(({ id }) => id === viewerSession.current.activeSheet);
    if (!workbook || !sheet || target.row >= sheet.rowCount || target.column >= sheet.columnCount) {
      setAddressError(labels.sheetAddressUnavailable);
      return;
    }
    const selection = { row: [target.row, target.row], column: [target.column, target.column], row_focus: target.row, column_focus: target.column };
    readingConnection.current?.select(sheet.id, selection);
    workbook.scroll({ targetRow: target.row, targetColumn: target.column });
    setAddress(cellAddress(target.row, target.column));
    setAddressError("");
  };
  const copyInspection = async (formula: boolean) => {
    if (!inspection) return;
    try {
      await navigator.clipboard.writeText(formula ? inspection.formula : inspection.value);
      setCopyFeedback(labels.sheetCopied);
    } catch {
      setCopyFeedback(labels.sheetCopyFailed);
    }
  };
  useEffect(() => {
    if (!copyFeedback) return;
    const timer = setTimeout(() => setCopyFeedback(""), 3000);
    return () => clearTimeout(timer);
  }, [copyFeedback]);

  const rangeReference: CanvasElementReference | null = elementSource?.revision && inspection?.range &&
    inspection.sourceKey === selectionSourceKey && inspection.sheet ? {
      path: elementSource.path, revision: elementSource.revision, element_id: "sheet-range",
      sheet_name: inspection.sheet, range: inspection.range,
    } : null;
  const rangeAdded = !!rangeReference && (elementSelection.selectedElements?.some((reference) => sameElementReference(reference, rangeReference)) ?? false);
  const addRange = () => {
    if (!rangeReference || !inspection || !elementSelection.onAddElement) return;
    const element: CanvasElement = { id: "sheet-range", kind: "sheet-range",
      label: `${inspection.sheet}!${inspection.range}`, locator: { sheet_name: inspection.sheet, range: inspection.range! } };
    elementSelection.onAddElement({ ...rangeReference }, element);
  };

  if (!mounted) {
    return <div className="cv-sheet cv-sheet--empty">{labels.tableLoading}</div>;
  }
  // A read-only workbook mounts with any parsed sheet, even one with no cell
  // values (a chart-only sheet holds just a picture).
  const mountable = hasSheet || (readOnly && !!artifact.data.sheet?.length);
  if (!mountable && columns.length === 0) {
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
    <div className={"cv-sheet-panel" + (readOnly ? " cv-sheet-panel--readonly" : "")}>
      {readOnly && (
        <>
          <div className="cv-sheet-viewer__inspector">
            <span className="cv-sheet-viewer__badge" title={`${labels.viewerReadOnly} · ${inspection?.sheet ?? ""} · ${labels.sheetCount(sheetIndex.filter(({ sheet }) => !sheet.hide).length)}`}>{labels.viewerReadOnly}</span>
            <label className="cv-sheet-viewer__address">
              <span>{labels.sheetCellAddress}</span>
              <input value={address} placeholder="A1" aria-label={labels.sheetCellAddress} aria-invalid={!!addressError} aria-describedby={addressError ? addressErrorId : undefined}
                onFocus={() => { addressEditing.current = true; }} onBlur={() => { addressEditing.current = false; }}
                onChange={(event) => { setAddress(event.target.value); setAddressError(""); }}
                onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); navigateToAddress(); } }} />
            </label>
            {addressError && <span id={addressErrorId} className="cv-sheet-viewer__feedback cv-sheet-viewer__feedback--error" role="alert" title={addressError}>{addressError}</span>}
            <span className="cv-sheet-viewer__fx" aria-hidden="true">ƒx</span>
            <label className="cv-sheet-viewer__value">
              <span>{inspection?.formula ? labels.sheetFormula : labels.sheetValue}</span>
              <textarea readOnly rows={1} value={inspection?.formula || inspection?.value || ""} placeholder={inspection ? labels.sheetEmptyCell : labels.sheetSelectCell} aria-label={inspection?.formula ? labels.sheetFormula : labels.sheetValue} />
            </label>
            {inspection?.formula && (
              <label className="cv-sheet-viewer__result" title={labels.sheetCachedValues}>
                <span>{labels.sheetValue}</span>
                <textarea readOnly rows={1} value={inspection.missing ? labels.sheetMissingValue : inspection.value} aria-label={labels.sheetValue} title={labels.sheetCachedValues} />
              </label>
            )}
            <button type="button" className="cv-sheet-viewer__copy" disabled={!inspection || inspection.missing} title={labels.sheetCopyValue} aria-label={labels.sheetCopyValue} onClick={() => void copyInspection(false)}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
            </button>
            {inspection?.formula && <button type="button" className="cv-sheet-viewer__copy" title={labels.sheetCopyFormula} aria-label={labels.sheetCopyFormula} onClick={() => void copyInspection(true)}>ƒx</button>}
            <span className="cv-sheet-viewer__feedback" role="status" aria-live="polite">{copyFeedback}</span>
          </div>
          {elementSelection.selectionMode === "elements" && elementSource && <div className="cv-elements__range">
            {!elementSource.revision ? <span role="status">{labels.elementUnavailable}</span> : <>
              <span>{rangeReference ? `${rangeReference.sheet_name}!${rangeReference.range}` : inspection ? labels.elementRangeUnavailable : labels.sheetSelectCell}</span>
              <button type="button" disabled={!rangeReference || !elementSelection.onAddElement} aria-pressed={rangeAdded} onClick={addRange}>
                {rangeAdded ? labels.elementAdded(`${rangeReference!.sheet_name}!${rangeReference!.range}`) : labels.elementAddRange}
              </button>
            </>}
          </div>}
        </>
      )}
      {!readOnly && (
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
      )}
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
          <Workbook
            key={wbKey}
            ref={wbRef}
            data={viewerData as never}
            onChange={readOnly ? captureViewerZoom : handleChange}
            {...(readOnly ? { ...READ_ONLY_SETTINGS, hooks: viewerHooks } : {})}
          />
        </Suspense>
        {readOnly && footer && inspection && createPortal(
          <span className="cv-sheet-viewer__summary" tabIndex={0} aria-label={`${labels.sheetRangeSummary(inspection.count, inspection.sum, inspection.average)}. ${labels.sheetRangeSummaryHint}`} title={`${labels.sheetRangeSummary(inspection.count, inspection.sum, inspection.average)} · ${labels.sheetRangeSummaryHint}`}><span>{labels.sheetRangeSummary(inspection.count, inspection.sum, inspection.average)}</span></span>, footer,
        )}
      </div>
    </div>
  );
}
