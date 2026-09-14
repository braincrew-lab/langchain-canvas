/** sheetHasContent — the guard that keeps empty serializations from masking rows. */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeSheets,
  padSheetsToArea,
  sheetHasContent,
  watchBoxSize,
  workbookKey,
} from "./TableRenderer";

describe("sheetHasContent", () => {
  it("is false for missing or empty sheet arrays", () => {
    expect(sheetHasContent(undefined)).toBe(false);
    expect(sheetHasContent([])).toBe(false);
  });

  it("is false for a mount-time serialization with no cell content", () => {
    expect(sheetHasContent([{ name: "Sheet1", row: 60, column: 26 }])).toBe(false);
    expect(sheetHasContent([{ name: "Sheet1", celldata: [] }])).toBe(false);
    expect(sheetHasContent([{ name: "Sheet1", data: [[null, null], [null, null]] }])).toBe(false);
    expect(sheetHasContent([{ name: "Sheet1", celldata: [{ r: 0, c: 0, v: null }] }])).toBe(false);
  });

  it("is true when any cell holds content", () => {
    expect(sheetHasContent([{ name: "Sheet1", celldata: [{ r: 0, c: 0, v: { v: "hi" } }] }])).toBe(true);
    expect(sheetHasContent([{ name: "Empty" }, { name: "Data", data: [[null, { v: 1 }]] }])).toBe(true);
  });
});

describe("normalizeSheets", () => {
  it("converts a serialized data matrix to the celldata form the Workbook reads", () => {
    const cell = { v: "Model", m: "Model", bl: 1 };
    const sheets = normalizeSheets([
      {
        name: "Sheet1",
        row: 3,
        column: 2,
        data: [
          [cell, null],
          [null, { v: 91 }],
        ],
        luckysheet_select_save: [{ row: [0, 0] }],
      },
    ])!;
    expect(sheets[0].data).toBeUndefined();
    expect(sheets[0].luckysheet_select_save).toBeUndefined();
    expect(sheets[0].celldata).toEqual([
      { r: 0, c: 0, v: cell },
      { r: 1, c: 1, v: { v: 91 } },
    ]);
    expect(sheets[0].name).toBe("Sheet1");
  });

  it("leaves celldata-form sheets alone (minus volatile selection state)", () => {
    const sheets = normalizeSheets([
      { name: "S", celldata: [{ r: 0, c: 0, v: { v: "x" } }], luckysheet_select_save: [] },
    ])!;
    expect(sheets[0].celldata).toEqual([{ r: 0, c: 0, v: { v: "x" } }]);
    expect(sheets[0].luckysheet_select_save).toBeUndefined();
  });
});

describe("workbookKey", () => {
  it("re-keys only for outside data changes and sort/filter views — never for the sheet appearing", () => {
    // The person's first edit turns a rows-only table into one with a `sheet`;
    // the grid must keep its mount (and the sheet they are on).
    expect(workbookKey("t:v1:r0:3x3:abc", "live")).toBe(workbookKey("t:v1:r0:3x3:abc", "live"));
    // An agent write bumps remoteSeq inside dataKey.
    expect(workbookKey("t:v1:r1:3x3:abc", "live")).not.toBe(workbookKey("t:v1:r0:3x3:abc", "live"));
    // A sort/filter view is its own mount.
    expect(workbookKey("t:v1:r0:3x3:abc", "view-sname1-f")).not.toBe(workbookKey("t:v1:r0:3x3:abc", "live"));
  });
});

describe("padSheetsToArea", () => {
  it("adds default-sized columns and rows until the grid covers the area", () => {
    // 12 columns: two stored at 200 px, ten at Fortune's 73 px default = 1130 px.
    // 29 rows at the 19 px default = 551 px.
    const [sheet] = padSheetsToArea(
      [{ name: "S", row: 29, column: 12, config: { columnlen: { 0: 200, 1: 200 } } }],
      1500,
      900,
    )!;
    expect(sheet.column).toBe(12 + Math.ceil((1500 - 1130) / 73));
    expect(sheet.row).toBe(29 + Math.ceil((900 - 551) / 19));
    expect(sheet.name).toBe("S");
  });

  it("never shrinks a sheet that already covers the area", () => {
    const [sheet] = padSheetsToArea([{ name: "S", row: 400, column: 40 }], 1500, 900)!;
    expect(sheet.row).toBe(400);
    expect(sheet.column).toBe(40);
  });

  it("counts stored row heights, not the default, for sized rows", () => {
    const [sheet] = padSheetsToArea(
      [{ name: "S", row: 2, column: 30, config: { rowlen: { 0: 100, 1: 100 } } }],
      100,
      390,
    )!;
    expect(sheet.row).toBe(2 + Math.ceil((390 - 200) / 19));
  });

  it("passes a missing sheet list through", () => {
    expect(padSheetsToArea(undefined, 1500, 900)).toBeUndefined();
  });
});

describe("watchBoxSize", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeObserver() {
    const state: { fire?: () => void; disconnected: boolean } = { disconnected: false };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          state.fire = callback;
        }
        observe() {}
        disconnect() {
          state.disconnected = true;
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
      run();
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return state;
  }

  it("notifies once per real size change and ignores same-size callbacks", () => {
    const observer = fakeObserver();
    const box = { clientWidth: 600, clientHeight: 400 } as HTMLElement;
    const onChange = vi.fn();
    const stop = watchBoxSize(box, onChange);

    observer.fire!();
    expect(onChange).not.toHaveBeenCalled();

    (box as { clientWidth: number }).clientWidth = 1100;
    observer.fire!();
    observer.fire!();
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    expect(observer.disconnected).toBe(true);
  });
});
