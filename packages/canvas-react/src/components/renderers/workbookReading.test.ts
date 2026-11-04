import type { CellWithRowAndCol, Selection, Sheet } from "@fortune-sheet/core";
import type { WorkbookInstance } from "@fortune-sheet/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWorkbookView, connectWorkbookReading, parseCellAddress, summarizeSelection, type WorkbookView } from "./workbookReading";

afterEach(() => vi.unstubAllGlobals());

describe("workbook address navigation", () => {
  it.each([
    ["A1", { row: 0, column: 0 }],
    [" e8 ", { row: 7, column: 4 }],
    ["$AA$12", { row: 11, column: 26 }],
    ["XFD1048576", { row: 1048575, column: 16383 }],
  ])("accepts %s within Excel bounds", (address, expected) => {
    expect(parseCellAddress(address as string)).toEqual(expected);
  });
  it.each(["", "A0", "A01", "XFE1", "A1048577", "AAAA1", "A1:B2", "Sheet1!A1", "=A1", "A-1", "A1.5"])("rejects %s", (address) => {
    expect(parseCellAddress(address)).toBeNull();
  });
});

describe("source-only selection summaries", () => {
  it("uses sparse finite stored numbers, excluding formula caches and merged placeholders", () => {
    const cells: CellWithRowAndCol[] = [
      { r: 0, c: 0, v: { v: 5, m: "five" } },
      { r: 1048575, c: 16383, v: { v: 15 } },
      { r: 1, c: 0, v: { v: 99, f: "=SUM(A1:A2)" } },
      { r: 2, c: 0, v: { v: "40" } },
      { r: 3, c: 0, v: { v: true } },
      { r: 4, c: 0, v: { v: Infinity } },
      { r: 5, c: 0, v: { v: 5, mc: { r: 0, c: 0 } } },
      { r: 6, c: 0, v: null },
    ];
    expect(summarizeSelection(cells, { row: [0, 1048575], column: [0, 16383] })).toEqual({ count: 2, sum: 20, average: 10 });
    expect(summarizeSelection(cells, { row: [0, 0], column: [0, 0] })).toEqual({ count: 1, sum: 5, average: 5 });
    expect(summarizeSelection(cells, { row: [20, 30], column: [0, 0] })).toEqual({ count: 0, sum: 0, average: 0 });
  });
  it("keeps numeric zero and negative numbers", () => {
    expect(summarizeSelection([{ r: 0, c: 0, v: { v: 0 } }, { r: 1, c: 0, v: { v: -4 } }], { row: [0, 1], column: [0, 0] })).toEqual({ count: 2, sum: -4, average: -2 });
  });
});

describe("ephemeral workbook view overlays", () => {
  it("restores per-sheet zoom and active status without mutating source content", () => {
    const source: Sheet[] = [{ name: "First", celldata: [{ r: 0, c: 0, v: { v: 7 } }] }, { id: "two", name: "Second", zoomRatio: 1 }];
    const before = JSON.stringify(source);
    const view: WorkbookView = { activeSheet: "two", sheets: { two: { zoom: 1.4, top: 40, left: 30, selection: [{ row: [5, 5], column: [3, 3] }] } } };
    const mounted = applyWorkbookView(source, view);
    expect(mounted[0].id).toBe("viewer-sheet-0");
    expect(mounted[0].status).toBe(0);
    expect(mounted[1]).toMatchObject({ status: 1, zoomRatio: 1.4 });
    expect(JSON.stringify(source)).toBe(before);
    expect(mounted[0].celldata).toBe(source[0].celldata);
  });

  it("restores selection/scroll through APIs and makes native tabs/zoom keyboard accessible", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const flush = async () => {
      for (let step = 0; step < 5; step++) {
        await Promise.resolve();
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(0));
      }
    };
    const root = document.createElement("div");
    root.innerHTML = '<div class="luckysheet-scrollbar-x"></div><div class="luckysheet-scrollbar-y"></div><div class="luckysheet-sheet-area"><div class="fortune-sheettab-container-c"><div class="luckysheet-sheets-item luckysheet-sheets-item-active">First</div><div class="luckysheet-sheets-item">Second</div></div><aside class="fortune-zoom-container" title="Zoom settings"><div class="fortune-zoom-button"></div><div class="fortune-zoom-ratio"><div class="fortune-zoom-ratio-current fortune-zoom-button">100%</div></div><div class="fortune-zoom-button"></div></aside></div>';
    document.body.appendChild(root);
    let active = 0;
    let selection: Selection[] = [{ row: [0, 0], column: [0, 0] }];
    const setSelection = vi.fn((next: Selection[]) => {
      for (const item of next) {
        item.row = [...item.row];
        Object.freeze(item.row);
        Object.freeze(item.column);
        Object.freeze(item);
      }
      Object.freeze(next);
      selection = next;
    });
    const scroll = vi.fn(({ scrollLeft, scrollTop }: { scrollLeft?: number; scrollTop?: number }) => {
      root.querySelector(".luckysheet-scrollbar-x")!.scrollLeft = scrollLeft ?? 0;
      root.querySelector(".luckysheet-scrollbar-y")!.scrollTop = scrollTop ?? 0;
    });
    const getSheet = vi.fn(() => { throw new Error("getSheet must never serialize the workbook during reading"); });
    const getSelection = vi.fn(() => selection.map(({ row, column }) => ({ row, column })));
    const workbook = { getSheet, getSelection, setSelection, scroll } as unknown as WorkbookInstance;
    const view: WorkbookView = { sheets: { one: { zoom: 1, left: 25, top: 75, selection: [{ row: [7, 7], column: [4, 4] }] }, two: { zoom: 1.3, left: 50, top: 150, selection: [{ row: [2, 2], column: [1, 1] }] } } };
    const tabs = root.querySelectorAll<HTMLElement>(".luckysheet-sheets-item");
    tabs.forEach((tab, index) => tab.addEventListener("click", () => {
      active = index;
      selection = [{ row: [0, 0], column: [0, 0] }];
      root.querySelector(".fortune-zoom-ratio-current")!.textContent = index === 0 ? "100%" : "130%";
      tabs.forEach((item, i) => item.classList.toggle("luckysheet-sheets-item-active", index === i));
    }));
    const inspect = vi.fn();
    const stop = connectWorkbookReading(root, () => workbook, view, ["one", "two"], { zoomIn: "확대", zoomOut: "축소" }, inspect);
    await flush();
    expect(setSelection).toHaveBeenCalledWith([{ row: [7, 7], column: [4, 4] }]);
    expect(scroll).toHaveBeenCalledWith({ scrollLeft: 25, scrollTop: 75 });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await flush();
    expect(active).toBe(1);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(scroll).toHaveBeenLastCalledWith({ scrollLeft: 50, scrollTop: 150 });
    expect(view.activeSheet).toBe("two");
    expect(view.sheets.one.selection[0].row).toEqual([7, 7]);
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    expect(active).toBe(0);
    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await flush();
    expect(active).toBe(1);
    const zoomIn = root.querySelector<HTMLElement>('[aria-label="확대"]')!;
    const click = vi.fn();
    zoomIn.addEventListener("click", click);
    zoomIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(click).toHaveBeenCalledOnce();
    expect(root.querySelector('[aria-label="축소"]')).not.toBeNull();
    const focused = { row: [2, 6], column: [1, 5], row_focus: 6, column_focus: 5 };
    selection = [focused];
    stop.selectionChanged("two", focused);
    expect(getSelection()).toEqual([{ row: [2, 6], column: [1, 5] }]);
    const selectionCalls = getSelection.mock.calls.length;
    const scrollbar = root.querySelector(".luckysheet-scrollbar-y")!;
    scrollbar.scrollTop = 220;
    scrollbar.dispatchEvent(new Event("scroll", { bubbles: true }));
    root.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    await flush();
    expect(getSelection).toHaveBeenCalledTimes(selectionCalls);
    expect(view.sheets.two.selection[0]).toEqual(focused);
    expect(inspect).toHaveBeenLastCalledWith("two", focused);
    expect(getSheet).not.toHaveBeenCalled();
    stop();
    const reconnect = connectWorkbookReading(root, () => workbook, view, ["one", "two"], { zoomIn: "확대", zoomOut: "축소" }, inspect);
    await flush();
    expect(setSelection).toHaveBeenLastCalledWith([focused]);
    expect(scroll).toHaveBeenLastCalledWith({ scrollLeft: 50, scrollTop: 220 });
    expect(view.sheets.two.selection[0]).toEqual(focused);
    expect(Object.isFrozen(view.sheets.two.selection)).toBe(false);
    expect(Object.isFrozen(view.sheets.two.selection[0])).toBe(false);
    expect(getSheet).not.toHaveBeenCalled();
    reconnect();
    const pending = connectWorkbookReading(root, () => workbook, view, ["one", "two"], { zoomIn: "확대", zoomOut: "축소" }, inspect);
    const explicit = { row: [7, 7], column: [4, 4], row_focus: 7, column_focus: 4 };
    pending.select("two", explicit);
    await flush();
    expect(view.sheets.two.selection[0]).toEqual(explicit);
    expect(inspect).toHaveBeenLastCalledWith("two", explicit);
    pending();
    root.remove();
    expect(frames.size).toBe(0);
  });
});
