/** sheetHasContent — the guard that keeps empty serializations from masking rows. */

import { describe, expect, it } from "vitest";

import { normalizeSheets, sheetHasContent } from "./TableRenderer";

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
