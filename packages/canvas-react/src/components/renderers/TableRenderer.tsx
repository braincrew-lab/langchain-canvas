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

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import "@fortune-sheet/react/dist/index.css";

import type { WorkbookInstance } from "@fortune-sheet/react";

import type { TableColumn, TableData } from "../../protocol/artifacts";
import { computeFormulas, type FormulaValues } from "../../io/formula";
import { useCanvasStore } from "../../hooks/useCanvasStore";
import type { RendererProps } from "../../registry/registry";
import { useT } from "../../i18n/i18n";

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
      column: Math.max(columns.length + 2, 8),
      celldata,
      // No frozen pane: a freeze split offsets the initial scroll and hides the
      // first data rows behind the split line. A plain grid scrolls cleanly.
      config: { rowlen: { 0: 28 }, columnlen },
    },
  ];
}

/** Fortune's live sheet objects → the serializable shape the Workbook `data`
 *  prop (and the exporters) can read back: `celldata` rebuilt from the runtime
 *  2-D `data` matrix, the matrix itself dropped (it's bulky and goes stale). */
function normalizeSheets(sheets: Array<Record<string, unknown>>): TableData["sheet"] {
  return (sheets ?? []).map((sheet) => {
    const matrix = sheet.data as Array<Array<unknown>> | undefined;
    if (!Array.isArray(matrix)) return sheet;
    const celldata: Array<{ r: number; c: number; v: unknown }> = [];
    matrix.forEach((row, r) => {
      if (!Array.isArray(row)) return;
      row.forEach((v, c) => {
        if (v != null) celldata.push({ r, c, v });
      });
    });
    const { data: _dropped, ...rest } = sheet;
    return { ...rest, celldata };
  });
}

/** Columns from the union of row keys — a fallback when `columns` is omitted. */
function deriveColumns(rows: TableData["rows"]): TableColumn[] {
  const keys = new Set<string>();
  for (let i = 0; i < Math.min(rows.length, 50); i++) Object.keys(rows[i] ?? {}).forEach((k) => keys.add(k));
  return [...keys].map((key) => ({ key }));
}

const EMPTY_FORMULAS: FormulaValues = new Map();

// Fortune-sheet types derived from the mounted instance — only @fortune-sheet/react
// is a declared dependency, so we can't import these from @fortune-sheet/core.
type FortuneOp = Parameters<WorkbookInstance["applyOp"]>[0][number];
/** A rectangular cell range, `row`/`column` as inclusive `[start, end]` pairs. */
type SheetSelection = { row: number[]; column: number[] };

/** Quick number formats (Fortune `ct.fa` patterns) offered in the Fmt… menu.
 *  Labels are i18n keys, joined with the pattern at render time. */
const NUMBER_FORMATS = [
  { labelKey: "fmtGeneral", suffix: "", fa: "General" },
  { labelKey: "fmtCurrency", suffix: " ₩#,##0", fa: "₩#,##0" },
  { labelKey: "fmtCurrency", suffix: " $#,##0.00", fa: "$#,##0.00" },
  { labelKey: "fmtPercent", suffix: " 0.0%", fa: "0.0%" },
  { labelKey: "fmtThousands", suffix: " #,##0", fa: "#,##0" },
  { labelKey: "fmtDecimal", suffix: " 0.00", fa: "0.00" },
  { labelKey: "fmtDate", suffix: " yyyy-mm-dd", fa: "yyyy-mm-dd" },
] as const;

/** AutoSum-style quick functions offered in the Σ menu. */
const QUICK_FUNCTIONS = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"] as const;

/** 0-based column index → spreadsheet letters (0 → "A", 26 → "AA"). */
const colToLetters = (c: number): string => {
  let s = "";
  for (let n = c; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};

/** 0-based cell coordinates → A1 notation ("B3"). */
const toA1 = (r: number, c: number) => `${colToLetters(c)}${r + 1}`;

/** Fortune stores an edited formula as syntax-highlighted HTML — flatten it to
 *  the plain "=…" text (entities decoded) for the formula bar. */
const plainFormula = (f: string): string => {
  if (!f.includes("<")) return f;
  const div = document.createElement("div");
  div.innerHTML = f;
  return div.textContent ?? f;
};

/** Does the selection contain a merged cell? Merged cells carry `mc`; the scan is
 *  capped so a whole-sheet selection can't stall the selection-change hook. */
const selectionHasMerge = (wb: WorkbookInstance, sel: SheetSelection): boolean => {
  let scanned = 0;
  for (let r = sel.row[0]; r <= sel.row[1]; r++) {
    for (let c = sel.column[0]; c <= sel.column[1]; c++) {
      if (scanned++ >= 400) return false;
      if (wb.getCellValue?.(r, c, { type: "mc" })) return true;
    }
  }
  return false;
};

/** Excel-style alignment glyph: four rules flushed to the given edge. */
function AlignIcon({ mode }: { mode: "left" | "center" | "right" }) {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden focusable="false">
      {[0, 1, 2, 3].map((i) => {
        const w = i % 2 ? 8.5 : 13;
        const x = mode === "left" ? 0 : mode === "right" ? 14 - w : (14 - w) / 2;
        return <rect key={i} x={x} y={i * 3.1} width={w} height="1.7" rx="0.85" fill="currentColor" />;
      })}
    </svg>
  );
}

/** Paint-bucket stand-in for the fill swatch (diamond + droplet). */
function FillIcon() {
  return (
    <svg width="13" height="12" viewBox="0 0 13 12" aria-hidden focusable="false">
      <path d="M5.6 1.2 10 5.6a1.1 1.1 0 0 1 0 1.6L7.4 9.8a1.1 1.1 0 0 1-1.6 0L1.4 5.4a1.1 1.1 0 0 1 0-1.6L4 1.2a1.1 1.1 0 0 1 1.6 0Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M12.6 9.4c0 .9-.55 1.6-1.25 1.6s-1.25-.7-1.25-1.6c0-.85 1.25-2.3 1.25-2.3s1.25 1.45 1.25 2.3Z" fill="currentColor" />
    </svg>
  );
}

/** One captioned ribbon group — the Excel model: controls above, name below. */
function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cv-ribbon__group" role="group" aria-label={label}>
      <div className="cv-ribbon__items">{children}</div>
      <span className="cv-ribbon__label">{label}</span>
    </div>
  );
}

export function TableRenderer({ artifact }: RendererProps<TableData>) {
  const t = useT();
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

  const hasSheet = !!artifact.data.sheet?.length;

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
  const wbKey = `${dataKey}:${viewActive ? `view-s${sortCol}${sortDir}-f${appliedFilter}` : hasSheet ? "sheet" : "rows"}`;

  // The workbook's data is frozen at mount (keyed by wbKey). In-sheet edits are
  // owned by Fortune and mirrored back via onChange — they must NOT feed back into
  // this prop or it resets mid-edit.
  const initialData = useMemo(
    () =>
      viewActive
        ? toWorkbook(columns, viewRows, formulas)
        : hasSheet
          ? artifact.data.sheet!
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
  //
  // Two hard-won rules guard this path:
  // 1. The FIRST onChange after every mount is Fortune echoing the data it was
  //    mounted with — not an edit. Persisting it is how a still-streaming table
  //    got bricked: the empty first mount's echo landed in `data.sheet` after
  //    the rows arrived, and the remount then preferred that empty sheet over
  //    the real rows. The echo is consumed and dropped.
  // 2. Fortune's live sheets carry the grid as a 2-D `data` matrix and let
  //    `celldata` go stale — but the Workbook `data` prop and our exporters
  //    read `celldata`. Persisting the raw object round-trips to an empty grid,
  //    so sheets are normalized (celldata rebuilt from the matrix, matrix
  //    dropped) before they're stored.
  const applyEvent = useCanvasStore((s) => s.applyUserEvent);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountEcho = useRef(1);
  const handleChange = useCallback(
    (sheets: unknown) => {
      if (mountEcho.current > 0) {
        mountEcho.current--;
        return;
      }
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        applyEvent({
          type: "canvas.patch",
          id: artifact.id,
          patch: { sheet: normalizeSheets(sheets as Array<Record<string, unknown>>) },
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
    const sel = wbRef.current?.getSelection?.();
    const range = sel?.[0]?.[type] ?? [0, 0];
    wbRef.current?.insertRowOrColumn(type, Math.max(0, range[1]), 1, "rightbottom");
  };

  // ── Cell formatting ────────────────────────────────────────────────────────
  // The formatting controls mirror the live selection: Fortune reports every
  // selection move via the `afterSelectionChange` hook, and we read the anchor
  // cell's bold flag so the Bold button reflects what's under the cursor. All
  // mutations below go through the instance API, which updates Fortune's own
  // context — so onChange fires and the existing debounced persist picks it up.
  const [selection, setSelection] = useState<SheetSelection | null>(null);
  const [boldOn, setBoldOn] = useState(false);
  const [fillColor, setFillColor] = useState("#fef3c7");
  const [textColor, setTextColor] = useState("#111827");
  // Whether the selection touches a merged cell — enables Unmerge.
  const [selHasMerge, setSelHasMerge] = useState(false);
  // Formula bar: the anchor cell's formula (or value), plus the user's in-progress
  // draft. The draft overlays the mirrored value and commits on Enter only.
  const [fxValue, setFxValue] = useState("");
  const [fxDraft, setFxDraft] = useState<string | null>(null);
  const handleSelectionChange = useCallback((_sheetId: string, sel: SheetSelection) => {
    setSelection({ row: [...sel.row], column: [...sel.column] });
    const wb = wbRef.current;
    const [r, c] = [sel.row[0], sel.column[0]];
    const bl = wb?.getCellValue?.(r, c, { type: "bl" });
    setBoldOn(bl === 1 || bl === "1");
    // The formula bar mirrors the anchor cell: its formula if it has one, else its
    // value. Fortune stores an edited formula as syntax-highlighted HTML
    // (`<span class="luckysheet-formula-text-…">`), so it's flattened to text.
    const f = wb?.getCellValue?.(r, c, { type: "f" });
    const v = wb?.getCellValue?.(r, c);
    setFxValue(typeof f === "string" && f ? plainFormula(f) : v == null ? "" : String(v));
    setFxDraft(null);
    setSelHasMerge(wb ? selectionHasMerge(wb, sel) : false);
  }, []);
  const workbookHooks = useMemo(() => ({ afterSelectionChange: handleSelectionChange }), [handleSelectionChange]);

  /** Apply one cell attribute to every selected range (multi-select included). */
  const applyFormat = (attr: "bl" | "bg" | "fc" | "ht", value: number | string) => {
    const sel = wbRef.current?.getSelection?.();
    if (!sel?.length) return;
    const ranges = sel.map((s) => ({ row: [s.row[0], s.row[1]], column: [s.column[0], s.column[1]] }));
    wbRef.current?.setCellFormatByRange(attr, value, ranges);
  };
  const toggleBold = () => {
    applyFormat("bl", boldOn ? 0 : 1);
    setBoldOn((b) => !b);
  };

  // Number format for the selection. `setCellFormat("ct", {fa, t})` recomputes the
  // display string itself (`m = SSF.format(fa, v)`), so cells re-render formatted.
  // `t` is derived per cell exactly like Fortune's own format menu (updateFormatCell):
  // dates are "d", General keeps text cells as "g", every numeric format is "n" —
  // batched through batchCallApis so the whole range is one context update.
  const applyNumberFormat = (fa: string) => {
    const wb = wbRef.current;
    const sel = wb?.getSelection?.();
    if (!wb || !sel?.length) return;
    const isDate = fa === "yyyy-mm-dd";
    const calls: { name: string; args: unknown[] }[] = [];
    sel.forEach((s) => {
      for (let r = s.row[0]; r <= s.row[1]; r++) {
        for (let c = s.column[0]; c <= s.column[1]; c++) {
          const v = wb.getCellValue?.(r, c);
          const numeric = v != null && v !== "" && Number.isFinite(Number(v));
          const t = isDate ? "d" : fa === "General" ? (numeric ? "n" : "g") : "n";
          calls.push({ name: "setCellFormat", args: [r, c, "ct", { fa, t }] });
        }
      }
    });
    wb.batchCallApis(calls);
  };

  // Merge / unmerge the selection. Fortune's API takes the same `{row, column}[]`
  // ranges getSelection returns; "merge-all" keeps the first non-empty value at
  // the anchor, "merge-cancel" (via cancelMerge) restores independent cells.
  const mergeSelection = () => {
    const sel = wbRef.current?.getSelection?.();
    if (!sel?.length) return;
    wbRef.current?.mergeCells(sel, "merge-all");
    setSelHasMerge(true);
  };
  const unmergeSelection = () => {
    const sel = wbRef.current?.getSelection?.();
    if (!sel?.length) return;
    wbRef.current?.cancelMerge(sel);
    setSelHasMerge(false);
  };

  // AutoSum-style quick function: write "=FN(range)" just below the selection —
  // or to its right when the selection is a single row. setCellValue routes a
  // "=…" string through Fortune's own commit path (updateCell → execfunction),
  // so the result is computed and rendered immediately, no remount.
  const insertQuickFormula = (fn: string) => {
    const wb = wbRef.current;
    const sel = wb?.getSelection?.()?.[0];
    if (!wb || !sel) return;
    const [r1, r2] = [sel.row[0], sel.row[1]];
    const [c1, c2] = [sel.column[0], sel.column[1]];
    const singleRow = r1 === r2;
    const [tr, tc] = singleRow ? [r1, c2 + 1] : [r2 + 1, c1];
    const sheet = wb.getSheet?.();
    if (tr >= (sheet?.row ?? 0) || tc >= (sheet?.column ?? 0)) return; // no cell beyond the grid
    wb.setCellValue(tr, tc, `=${fn}(${toA1(r1, c1)}:${toA1(r2, c2)})`);
  };

  // Commit the formula-bar draft to the anchor cell. A "=…" string commits as a
  // live formula (same updateCell path as above); anything else as a literal.
  const commitFormulaBar = () => {
    const wb = wbRef.current;
    if (!wb || !selection || fxDraft == null) return;
    wb.setCellValue(selection.row[0], selection.column[0], fxDraft);
    setFxValue(fxDraft);
    setFxDraft(null);
  };

  // One-click de-garishing: strip every per-cell fill (`bg`) and font color
  // (`fc`) on the current sheet — values, bold, borders, and merges stay. Cells
  // are removed via `applyOp` patches (not `setCellFormat(attr, undefined)`)
  // so the keys are truly deleted: Fortune's renderer checks `"bg" in cell`,
  // and a lingering `bg: undefined` would still hit that branch. Inline-string
  // cells carry colors per text run (`ct.s[i]`), so those are cleared too.
  const cleanStyling = () => {
    const wb = wbRef.current;
    const sheet = wb?.getSheet?.();
    const sheetId = sheet?.id;
    if (!wb || !sheet || !sheetId) return;
    const ops: FortuneOp[] = [];
    sheet.celldata.forEach(({ r, c, v }) => {
      if (!v || typeof v !== "object") return;
      const cell = v as Record<string, unknown>;
      if (cell.bg != null) ops.push({ op: "remove", id: sheetId, path: ["data", r, c, "bg"] });
      if (cell.fc != null) ops.push({ op: "remove", id: sheetId, path: ["data", r, c, "fc"] });
      const spans = (cell.ct as { s?: unknown[] } | undefined)?.s;
      if (!Array.isArray(spans)) return;
      spans.forEach((span, i) => {
        if (!span || typeof span !== "object") return;
        const run = span as Record<string, unknown>;
        if (run.bg != null) ops.push({ op: "remove", id: sheetId, path: ["data", r, c, "ct", "s", i, "bg"] });
        if (run.fc != null) ops.push({ op: "remove", id: sheetId, path: ["data", r, c, "ct", "s", i, "fc"] });
      });
    });
    if (ops.length) wb.applyOp(ops); // one batch → one context update → one persist
  };

  // Opt-in header freeze (OFF by default — an always-on freeze used to offset
  // the initial scroll, see the toWorkbook comment). ON pins row 0 via the
  // `freeze` API; OFF removes `sheet.frozen` with an `applyOp` patch, the same
  // deletion Fortune's own "cancel freeze" menu performs (there's no public
  // unfreeze method). Both mutate the sheet, so the toggle state persists.
  const [frozen, setFrozen] = useState(false);
  const toggleFreeze = () => {
    const wb = wbRef.current;
    if (!wb) return;
    if (frozen) {
      const sheetId = wb.getSheet?.()?.id;
      if (sheetId) wb.applyOp([{ op: "remove", id: sheetId, path: ["frozen"] }]);
    } else {
      wb.freeze("row", { row: 0, column: 0 });
    }
    setFrozen((f) => !f);
  };
  // A remount (new data, sort/filter view, first persist) starts a fresh
  // workbook: resync the freeze toggle from the mounting sheet's own frozen
  // state and drop the stale selection.
  useEffect(() => {
    mountEcho.current = 1; // the next onChange is the new workbook's mount echo
    setFrozen(!viewActive && hasSheet && !!artifact.data.sheet?.[0]?.frozen);
    setSelection(null);
    setBoldOn(false);
    setSelHasMerge(false);
    setFxValue("");
    setFxDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wbKey]);

  if (!mounted) {
    return <div className="cv-sheet cv-sheet--empty">{t("loadingSheet")}</div>;
  }
  if (!hasSheet && columns.length === 0) {
    return <div className="cv-sheet cv-sheet--empty">{t("waitingData")}</div>;
  }
  // Wait for formula pre-computation before mounting, so the workbook mounts once
  // with final values — no remount that could interrupt an in-progress edit.
  if (!hasSheet && !formulasReady) {
    return <div className="cv-sheet cv-sheet--empty">{t("calculating")}</div>;
  }

  return (
    <div className="cv-sheet-panel">
      <div className="cv-sheet-tools cv-ribbon">
        <RibbonGroup label={t("groupInsert")}>
          <button type="button" className="cv-ribbon__btn" onClick={() => insert("column")}>{t("addColumn")}</button>
          <button type="button" className="cv-ribbon__btn" onClick={() => insert("row")}>{t("addRow")}</button>
        </RibbonGroup>

        <RibbonGroup label={t("groupFont")}>
          <button
            type="button"
            className={`cv-ribbon__btn cv-ribbon__btn--glyph cv-ribbon__bold${boldOn ? " is-on" : ""}`}
            title={t("bold")}
            aria-pressed={boldOn}
            disabled={!selection}
            onClick={toggleBold}
          >
            {t("boldGlyph")}
          </button>
          {/* Excel-style swatches: the glyph shows WHAT it colors, the bar shows
              the current color; clicking opens the native picker. */}
          <label className={`cv-ribbon__swatch${!selection ? " is-disabled" : ""}`} title={t("textColor")}>
            <span className="cv-ribbon__swatch-glyph">{t("textGlyph")}</span>
            <span className="cv-ribbon__swatch-bar" style={{ background: textColor }} />
            <input
              type="color"
              className="cv-sheet-tools__color cv-sheet-tools__color--text"
              disabled={!selection}
              value={textColor}
              onChange={(e) => { setTextColor(e.target.value); applyFormat("fc", e.target.value); }}
            />
          </label>
          <label className={`cv-ribbon__swatch${!selection ? " is-disabled" : ""}`} title={t("fillColor")}>
            <span className="cv-ribbon__swatch-glyph"><FillIcon /></span>
            <span className="cv-ribbon__swatch-bar" style={{ background: fillColor }} />
            <input
              type="color"
              className="cv-sheet-tools__color cv-sheet-tools__color--fill"
              disabled={!selection}
              value={fillColor}
              onChange={(e) => { setFillColor(e.target.value); applyFormat("bg", e.target.value); }}
            />
          </label>
        </RibbonGroup>

        <RibbonGroup label={t("groupAlign")}>
          {/* Fortune's `ht` codes: 1 = left (default), 0 = center, 2 = right. */}
          <button type="button" className="cv-ribbon__btn cv-ribbon__btn--icon cv-sheet-tools__align" title={t("alignLeft")} disabled={!selection} onClick={() => applyFormat("ht", 1)}><AlignIcon mode="left" /></button>
          <button type="button" className="cv-ribbon__btn cv-ribbon__btn--icon" title={t("alignCenter")} disabled={!selection} onClick={() => applyFormat("ht", 0)}><AlignIcon mode="center" /></button>
          <button type="button" className="cv-ribbon__btn cv-ribbon__btn--icon" title={t("alignRight")} disabled={!selection} onClick={() => applyFormat("ht", 2)}><AlignIcon mode="right" /></button>
          <span className="cv-ribbon__gap" />
          <button
            type="button"
            className="cv-ribbon__btn cv-sheet-tools__merge"
            title={t("mergeTip")}
            disabled={!selection || (selection.row[0] === selection.row[1] && selection.column[0] === selection.column[1])}
            onClick={mergeSelection}
          >
            {t("mergeCells")}
          </button>
          <button type="button" className="cv-ribbon__btn cv-sheet-tools__unmerge" title={t("unmergeTip")} disabled={!selHasMerge} onClick={unmergeSelection}>
            {t("unmergeCells")}
          </button>
        </RibbonGroup>

        <RibbonGroup label={t("groupNumber")}>
          {/* Renders as a menu: value stays "" so it snaps back to the label. */}
          <select
            className="cv-ribbon__select cv-sheet-tools__numfmt"
            value=""
            title={t("numberFormatTip")}
            disabled={!selection}
            onChange={(e) => { if (e.target.value) applyNumberFormat(e.target.value); }}
          >
            <option value="">{t("numberFormat")}</option>
            {NUMBER_FORMATS.map((f) => (
              <option key={f.fa} value={f.fa}>{t(f.labelKey) + f.suffix}</option>
            ))}
          </select>
        </RibbonGroup>

        <RibbonGroup label={t("groupEdit")}>
          <select
            className="cv-ribbon__select cv-sheet-tools__fx"
            value=""
            title={t("quickFunctionTip")}
            disabled={!selection}
            onChange={(e) => { if (e.target.value) insertQuickFormula(e.target.value); }}
          >
            <option value="">{t("autoSum")}</option>
            {QUICK_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>{fn}</option>
            ))}
          </select>
          {columns.length > 0 && (
            <>
              <select
                className="cv-ribbon__select cv-sheet-tools__sort"
                value={sortCol}
                title={t("sortByColumn")}
                onChange={(e) => setSortCol(e.target.value)}
              >
                <option value="">{t("sortBy")}</option>
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>{c.label ?? c.key}</option>
                ))}
              </select>
              {sortCol && (
                <button type="button" className="cv-ribbon__btn cv-ribbon__btn--icon" title={sortDir === 1 ? t("ascending") : t("descending")} onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))}>
                  {sortDir === 1 ? "▲" : "▼"}
                </button>
              )}
              <input
                className="cv-ribbon__input cv-sheet-tools__filter"
                value={filter}
                placeholder={t("filterRows")}
                onChange={(e) => setFilter(e.target.value)}
                title={t("filterTip")}
              />
            </>
          )}
        </RibbonGroup>

        <RibbonGroup label={t("groupView")}>
          <button
            type="button"
            className={`cv-ribbon__btn cv-sheet-tools__freeze${frozen ? " is-on" : ""}`}
            title={frozen ? t("freezeOffTip") : t("freezeOnTip")}
            aria-pressed={frozen}
            onClick={toggleFreeze}
          >
            {t("freezeHeader")}
          </button>
          <button type="button" className="cv-ribbon__btn cv-sheet-tools__clean" title={t("cleanStylingTip")} onClick={cleanStyling}>
            {t("cleanStyling")}
          </button>
        </RibbonGroup>
      </div>
      {/* Formula bar: mirrors the anchor cell (formula over value); Enter commits,
          Escape drops the draft back to the mirrored value. */}
      <div className="cv-sheet-fxbar">
        <span className="cv-sheet-fxbar__cell">
          {selection ? toA1(selection.row[0], selection.column[0]) : "—"}
        </span>
        <input
          className="cv-sheet-fxbar__input"
          value={fxDraft ?? fxValue}
          placeholder={t("fxPlaceholder")}
          disabled={!selection}
          onChange={(e) => setFxDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitFormulaBar();
            } else if (e.key === "Escape") {
              setFxDraft(null);
            }
          }}
          title="Formula bar"
        />
      </div>
      <div className="cv-sheet" ref={rootRef}>
        <Suspense fallback={<div className="cv-sheet--empty">{t("loading")}</div>}>
          <Workbook key={wbKey} ref={wbRef} data={initialData as never} onChange={handleChange} hooks={workbookHooks} />
        </Suspense>
      </div>
    </div>
  );
}
