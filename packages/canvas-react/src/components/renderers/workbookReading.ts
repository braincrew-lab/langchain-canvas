import type { CellWithRowAndCol, Selection, Sheet } from "@fortune-sheet/core";
import type { WorkbookInstance } from "@fortune-sheet/react";

export type WorkbookView = {
  activeSheet?: string;
  sheets: Record<string, { zoom: number; left: number; top: number; selection: Selection[] }>;
};

export function parseCellAddress(value: string): { row: number; column: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(value.trim());
  if (!match) return null;
  let column = 0;
  for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return column <= 16384 && row <= 1048576 ? { row: row - 1, column: column - 1 } : null;
}

/** Iterate stored cells, never the (potentially full-Excel-size) selected rectangle. */
export function summarizeSelection(cells: readonly CellWithRowAndCol[], selection: Selection) {
  let count = 0;
  let sum = 0;
  let average = 0;
  const [firstRow, lastRow = firstRow] = selection.row;
  const [firstColumn, lastColumn = firstColumn] = selection.column;
  for (const { r, c, v } of cells) {
    if (r < firstRow || r > lastRow || c < firstColumn || c > lastColumn || v?.f || typeof v?.v !== "number" || !Number.isFinite(v.v)) continue;
    // A merge placeholder is not another stored numeric value.
    if (v.mc && (v.mc.r !== r || v.mc.c !== c)) continue;
    count++;
    sum += v.v;
    average = average * ((count - 1) / count) + v.v / count;
  }
  return { count, sum, average };
}

export function copySelection(selection: Selection[]): Selection[] {
  return selection.map(({ row, column, row_focus, column_focus }) => ({
    row: [...row], column: [...column], row_focus, column_focus,
  }));
}

/** Mount-only view overlays; source sheets and cells are never written back. */
export function applyWorkbookView(sheets: Sheet[], view: WorkbookView): Sheet[] {
  return sheets.map((sheet, index) => {
    const id = sheet.id ?? `viewer-sheet-${index}`;
    const saved = view.sheets[id];
    return {
      ...sheet, id,
      ...(view.activeSheet ? { status: id === view.activeSheet ? 1 : 0 } : {}),
      ...(saved ? { zoomRatio: saved.zoom } : {}),
    };
  });
}

type ReadingLabels = { zoomIn: string; zoomOut: string };
export type WorkbookReadingConnection = (() => void) & {
  selectionChanged: (sheetId: string, selection: Selection) => void;
  select: (sheetId: string, selection: Selection) => void;
};

/**
 * Fortune exposes selection/scroll APIs but no zoom setter or activation hook.
 * Its native tab click also restores zoom and its internal scroll record (unlike
 * activateSheet). Keep that supported UI path, enhance its semantics, and capture
 * view-only state from native tab/zoom metadata and afterSelectionChange. The
 * public getSheet serializes the dense matrix; getSelection omits focus.
 */
export function connectWorkbookReading(
  root: HTMLElement,
  getWorkbook: () => WorkbookInstance | null,
  view: WorkbookView,
  sheetIds: readonly string[],
  labels: ReadingLabels,
  inspect: (sheetId: string, selection: Selection) => void,
  onFooter?: (footer: HTMLElement) => void,
): WorkbookReadingConnection {
  let active: string | undefined;
  let restoring = false;
  let frame = 0;
  let restoreFrame = 0;
  let stopped = false;
  const tabs = () => [...root.querySelectorAll<HTMLElement>(".luckysheet-sheets-item")].filter((tab) => tab.style.display !== "none");
  const activeId = () => root.querySelector<HTMLElement>(".luckysheet-sheets-item-active")?.dataset.cvSheetId;
  const capture = () => {
    if (restoring || !active || activeId() !== active) return;
    const previous = view.sheets[active];
    const zoom = Number.parseFloat(root.querySelector(".fortune-zoom-ratio-current")?.textContent ?? "") / 100;
    view.activeSheet = active;
    view.sheets[active] = {
      zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : previous?.zoom ?? 1,
      left: root.querySelector(".luckysheet-scrollbar-x")?.scrollLeft ?? 0,
      top: root.querySelector(".luckysheet-scrollbar-y")?.scrollTop ?? 0,
      selection: previous?.selection ?? [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
    };
  };
  const decorate = () => {
    const footer = root.querySelector<HTMLElement>(".luckysheet-sheet-area");
    if (footer) onFooter?.(footer);
    root.querySelector(".fortune-sheettab-container-c")?.setAttribute("role", "tablist");
    root.querySelectorAll<HTMLElement>(".luckysheet-sheets-item").forEach((tab, index) => {
      if (sheetIds[index]) tab.dataset.cvSheetId = sheetIds[index];
    });
    for (const tab of tabs()) {
      const selected = tab.classList.contains("luckysheet-sheets-item-active");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    const zoom = root.querySelectorAll<HTMLElement>(".fortune-zoom-container > .fortune-zoom-button");
    zoom[0]?.setAttribute("aria-label", labels.zoomOut);
    zoom[1]?.setAttribute("aria-label", labels.zoomIn);
    root.querySelector(".fortune-zoom-container")?.removeAttribute("title");
    root.querySelectorAll(".fortune-zoom-ratio-current, .fortune-zoom-ratio-item").forEach((item) => item.setAttribute("role", "button"));
  };
  const showSelection = () => {
    const selection = active ? view.sheets[active]?.selection[0] : undefined;
    if (active && selection) inspect(active, selection);
  };
  const sync = () => {
    frame = 0;
    if (stopped) return;
    decorate();
    const workbook = getWorkbook();
    if (!workbook || !root.querySelector(".luckysheet-sheet-area")) return;
    const id = activeId();
    if (!id) return;
    if (id !== active) {
      active = id;
      view.activeSheet = id;
      const saved = view.sheets[id];
      restoring = true;
      cancelAnimationFrame(restoreFrame);
      // Native SheetItem effects reset selection/scroll on activation; replay only
      // after those effects, using the public API, not workbook document writes.
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = requestAnimationFrame(() => {
          if (stopped || activeId() !== id) return;
          if (saved) {
            if (saved.selection.length) getWorkbook()?.setSelection(copySelection(saved.selection));
            getWorkbook()?.scroll({ scrollLeft: saved.left, scrollTop: saved.top });
          }
          // setSelection schedules React state; do not snapshot the old API ref
          // until Fortune has committed the restored selection.
          restoreFrame = requestAnimationFrame(() => {
            if (stopped || activeId() !== id) return;
            restoring = false;
            capture();
            showSelection();
          });
        });
      });
    } else if (!restoring) {
      capture();
      showSelection();
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target?.closest<HTMLElement>(".luckysheet-sheets-item");
    if (tab) {
      const items = tabs();
      const index = items.indexOf(tab);
      let next = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % items.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + items.length - 1) % items.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      capture();
      items[next]?.click();
      items[next]?.focus();
      schedule();
    } else if (target?.closest(".fortune-zoom-button, .fortune-zoom-ratio-item")) {
      // Footer keyboard gestures must not leak into Fortune's grid shortcuts.
      event.stopPropagation();
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      target.closest<HTMLElement>(".fortune-zoom-button, .fortune-zoom-ratio-item")?.click();
    }
  };
  const beforeClick = () => { capture(); schedule(); };
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("click", beforeClick, true);
  root.addEventListener("scroll", capture, true);
  root.addEventListener("pointerup", schedule, true);
  root.addEventListener("keyup", schedule, true);
  schedule();
  const disconnect = () => {
    capture();
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    cancelAnimationFrame(restoreFrame);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("click", beforeClick, true);
    root.removeEventListener("scroll", capture, true);
    root.removeEventListener("pointerup", schedule, true);
    root.removeEventListener("keyup", schedule, true);
  };
  disconnect.selectionChanged = (sheetId: string, selection: Selection) => {
    if (restoring || active !== sheetId) return;
    capture();
    const saved = view.sheets[sheetId];
    if (!saved) return;
    // Only the hook carries the focused cell. Never overwrite it with a reduced
    // getSelection result on scroll, DOM updates, or unmount.
    const ranges = getWorkbook()?.getSelection() ?? [];
    saved.selection = copySelection(ranges.length ? ranges : [selection]);
    const first = saved.selection[0];
    if (first.row[0] === selection.row[0] && first.row[1] === selection.row[1]
      && first.column[0] === selection.column[0] && first.column[1] === selection.column[1]) {
      first.row_focus = selection.row_focus;
      first.column_focus = selection.column_focus;
    } else saved.selection = copySelection([selection]);
    inspect(sheetId, selection);
  };
  disconnect.select = (sheetId: string, selection: Selection) => {
    cancelAnimationFrame(restoreFrame);
    restoring = false;
    capture();
    const saved = view.sheets[sheetId];
    if (saved) saved.selection = copySelection([selection]);
    getWorkbook()?.setSelection(copySelection([selection]));
    inspect(sheetId, selection);
  };
  return disconnect;
}
