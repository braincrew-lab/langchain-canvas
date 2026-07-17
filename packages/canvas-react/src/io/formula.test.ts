import { describe, expect, it } from "vitest";

import type { TableColumn, TableData } from "../protocol/artifacts";
import { computeFormulas } from "./formula";

const cols: TableColumn[] = [{ key: "a" }, { key: "b" }];
// Display grid: row 1 = header, row 2 = first data row (rows[0]).
const rows: TableData["rows"] = [
  { a: 10, b: 5 },
  { a: 20, b: 15 },
];

describe("computeFormulas", () => {
  it("returns empty when there are no formula cells", async () => {
    const out = await computeFormulas(cols, rows);
    expect(out.size).toBe(0);
  });

  it("computes SUM/AVERAGE over a column range", async () => {
    // Formula lives on the 3rd data row (dataIdx 2) → celldata row key "3".
    const r: TableData["rows"] = [...rows, { a: "=SUM(A2:A3)", b: "=AVERAGE(B2:B3)" }];
    const out = await computeFormulas(cols, r);
    expect(out.get("3,0")).toBe(30); // A: 10 + 20
    expect(out.get("3,1")).toBe(10); // B: (5 + 15) / 2
  });

  it("resolves a formula that references another formula", async () => {
    const r: TableData["rows"] = [{ a: 2, b: "=A2*3" }, { a: "=B2+4", b: 0 }];
    const out = await computeFormulas(cols, r);
    expect(out.get("1,1")).toBe(6); // B2 = A2*3 = 6
    expect(out.get("2,0")).toBe(10); // A3 = B2+4 = 10
  });

  it("degrades a self-referential (cyclic) formula to 0 instead of hanging", async () => {
    const r: TableData["rows"] = [{ a: "=A2", b: 1 }];
    const out = await computeFormulas(cols, r);
    expect(out.get("1,0")).toBe(0);
  });

  it("clamps an over-long range to the data extent instead of iterating it fully", async () => {
    // Formula in column B sums an over-long column-A range; clamps to A2:A4.
    const r: TableData["rows"] = [{ a: 1, b: 0 }, { a: 2, b: 0 }, { a: 3, b: "=SUM(A2:A1000)" }];
    const out = await computeFormulas(cols, r);
    expect(out.get("3,1")).toBe(6); // 1 + 2 + 3; rows 5..1000 are clamped away
  });
});
