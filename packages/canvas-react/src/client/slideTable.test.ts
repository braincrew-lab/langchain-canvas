import { describe, expect, it } from "vitest";

import type { SlideElement } from "../protocol/artifacts";
import { cellKey, cellLook, shares, tableGrid } from "./slideTable";

const table = (extra: Partial<SlideElement> = {}): SlideElement => ({
  id: "t",
  type: "table",
  x: 10,
  y: 20,
  w: 80,
  h: 40,
  rows: [
    ["Header", ""],
    ["a", "b"],
  ],
  ...extra,
});

describe("tableGrid", () => {
  it("shares the box equally when no widths are given, and scales given ones to 100", () => {
    expect(shares(undefined, 4)).toEqual([25, 25, 25, 25]);
    expect(shares([3, 1], 2)).toEqual([75, 25]);
    expect(shares([3, 1, 1], 2)).toEqual([50, 50]); // the wrong length is ignored
    expect(shares([0, 1], 2)).toEqual([50, 50]); // so is a zero share
  });

  it("marks the cells a span covers and clamps a span to the grid", () => {
    const grid = tableGrid(table({ cells: [{ r: 0, c: 0, colSpan: 5 }] }));
    expect(grid?.spans.get(cellKey(0, 0))).toEqual([1, 2]);
    expect(grid?.covered.has(cellKey(0, 1))).toBe(true);
    expect(grid?.covered.has(cellKey(1, 0))).toBe(false);
  });

  it("has no grid for a ragged or empty table", () => {
    expect(tableGrid(table({ rows: [["a", "b"], ["c"]] }))).toBeNull();
    expect(tableGrid(table({ rows: [] }))).toBeNull();
    expect(tableGrid(table({ rows: [[]] }))).toBeNull();
  });
});

describe("cellLook", () => {
  it("lays the cell's own look over the table's, and bolds a header row", () => {
    const el = table({ header: true, fontSize: 18, color: "#111", fill: "#eee" });
    expect(cellLook(el, 0, undefined)).toEqual({ fontSize: 18, bold: true, color: "#111", align: "left", fill: "#eee" });
    expect(cellLook(el, 1, undefined).bold).toBe(false);
    expect(cellLook(el, 1, { r: 1, c: 0, bold: true, fill: "#ddeeff", fontSize: 12 })).toMatchObject({
      fontSize: 12,
      bold: true,
      fill: "#ddeeff",
    });
    expect(cellLook(table({ header: true, bold: false }), 0, undefined).bold).toBe(false);
  });
});
