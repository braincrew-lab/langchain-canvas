/** sheetHasContent — the guard that keeps empty serializations from masking rows. */

import { describe, expect, it } from "vitest";

import { normalizeSheets, sheetHasContent, workbookKey } from "./TableRenderer";

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
