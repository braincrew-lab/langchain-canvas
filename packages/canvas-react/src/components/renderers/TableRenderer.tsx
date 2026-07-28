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

import "@fortune-sheet/react/dist/index.css";

import type { WorkbookInstance } from "@fortune-sheet/react";

import type { TableColumn, TableData } from "../../protocol/artifacts";
import { computeFormulas, type FormulaValues } from "../../io/formula";
import { useCanvasStore } from "../../hooks/useCanvasStore";
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
      column: Math.max(columns.length + 2, 8),
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

// Fortune-sheet types derived from the mounted instance — only @fortune-sheet/react
// is a declared dependency, so we can't import these from @fortune-sheet/core.
type FortuneOp = Parameters<WorkbookInstance["applyOp"]>[0][number];
/** A rectangular cell range, `row`/`column` as inclusive `[start, end]` pairs. */
type SheetSelection = { row: number[]; column: number[] };

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
  const applyEvent = useCanvasStore((s) => s.applyUserEvent);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = useCallback(
    (sheets: unknown) => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        applyEvent({ type: "canvas.patch", id: artifact.id, patch: { sheet: sheets as TableData["sheet"] } });
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
  const handleSelectionChange = useCallback((_sheetId: string, sel: SheetSelection) => {
    setSelection({ row: [...sel.row], column: [...sel.column] });
    const bl = wbRef.current?.getCellValue?.(sel.row[0], sel.column[0], { type: "bl" });
    setBoldOn(bl === 1 || bl === "1");
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
    setFrozen(!viewActive && hasSheet && !!artifact.data.sheet?.[0]?.frozen);
    setSelection(null);
    setBoldOn(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wbKey]);

  if (!mounted) {
    return <div className="cv-sheet cv-sheet--empty">Loading spreadsheet…</div>;
  }
  if (!hasSheet && columns.length === 0) {
    return <div className="cv-sheet cv-sheet--empty">Waiting for data…</div>;
  }
  // Wait for formula pre-computation before mounting, so the workbook mounts once
  // with final values — no remount that could interrupt an in-progress edit.
  if (!hasSheet && !formulasReady) {
    return <div className="cv-sheet cv-sheet--empty">Calculating…</div>;
  }

  return (
    <div className="cv-sheet-panel">
      <div className="cv-sheet-tools">
        <button type="button" onClick={() => insert("column")}>＋ Column</button>
        <button type="button" onClick={() => insert("row")}>＋ Row</button>
        <span className="cv-sheet-tools__sep" />
        {/* Selection formatting — enabled once a range is selected in the grid. */}
        <span className="cv-sheet-tools__fmt">
          <button
            type="button"
            className={`cv-sheet-tools__bold${boldOn ? " cv-sheet-tools__bold--on" : ""}`}
            title="Bold"
            aria-pressed={boldOn}
            disabled={!selection}
            onClick={toggleBold}
          >
            B
          </button>
          <input
            type="color"
            className="cv-sheet-tools__color cv-sheet-tools__color--fill"
            title="Fill color"
            disabled={!selection}
            value={fillColor}
            onChange={(e) => { setFillColor(e.target.value); applyFormat("bg", e.target.value); }}
          />
          <input
            type="color"
            className="cv-sheet-tools__color cv-sheet-tools__color--text"
            title="Text color"
            disabled={!selection}
            value={textColor}
            onChange={(e) => { setTextColor(e.target.value); applyFormat("fc", e.target.value); }}
          />
          {/* Fortune's `ht` codes: 1 = left (default), 0 = center, 2 = right. */}
          <button type="button" className="cv-sheet-tools__align" title="Align left" disabled={!selection} onClick={() => applyFormat("ht", 1)}>⇤</button>
          <button type="button" className="cv-sheet-tools__align" title="Align center" disabled={!selection} onClick={() => applyFormat("ht", 0)}>↔</button>
          <button type="button" className="cv-sheet-tools__align" title="Align right" disabled={!selection} onClick={() => applyFormat("ht", 2)}>⇥</button>
        </span>
        <span className="cv-sheet-tools__sep" />
        <button type="button" className="cv-sheet-tools__clean" title="Remove all cell fills and font colors" onClick={cleanStyling}>
          Clean styling
        </button>
        <button
          type="button"
          className={`cv-sheet-tools__freeze${frozen ? " cv-sheet-tools__freeze--on" : ""}`}
          title={frozen ? "Unfreeze the header row" : "Keep the header row visible while scrolling"}
          aria-pressed={frozen}
          onClick={toggleFreeze}
        >
          Freeze header
        </button>
        {columns.length > 0 && (
          <>
            <span className="cv-sheet-tools__sep" />
            <select
              className="cv-sheet-tools__sort"
              value={sortCol}
              title="Sort by column"
              onChange={(e) => setSortCol(e.target.value)}
            >
              <option value="">Sort…</option>
              {columns.map((c) => (
                <option key={c.key} value={c.key}>{c.label ?? c.key}</option>
              ))}
            </select>
            {sortCol && (
              <button type="button" title={sortDir === 1 ? "Ascending" : "Descending"} onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))}>
                {sortDir === 1 ? "▲" : "▼"}
              </button>
            )}
            <input
              className="cv-sheet-tools__filter"
              value={filter}
              placeholder="Filter…"
              onChange={(e) => setFilter(e.target.value)}
              title="Filter rows"
            />
          </>
        )}
        <span className="cv-sheet-tools__hint">Right-click a header for more, or drag to edit</span>
      </div>
      <div className="cv-sheet" ref={rootRef}>
        <Suspense fallback={<div className="cv-sheet--empty">Loading…</div>}>
          <Workbook key={wbKey} ref={wbRef} data={initialData as never} onChange={handleChange} hooks={workbookHooks} />
        </Suspense>
      </div>
    </div>
  );
}
