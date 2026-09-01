import { describe, expect, it } from "vitest";

import { computeSheetFormulas } from "./sheetFormula";

const cell = (r: number, c: number, v: unknown) => ({ r, c, v });

describe("computeSheetFormulas", () => {
  it("evaluates in the sheet's own coordinates, dependents included", async () => {
    const values = await computeSheetFormulas([
      cell(0, 0, { v: 10 }),
      cell(1, 0, { v: 20 }),
      // A3 sums the column above it; B3 doubles A3 — a dependent chain.
      cell(2, 0, { f: "=SUM(A1:A2)" }),
      cell(2, 1, { f: "=A3*2" }),
    ]);
    expect(values.get("2,0")).toBe(30);
    expect(values.get("2,1")).toBe(60);
  });

  it("reads plain (non-dict) cell values too", async () => {
    const values = await computeSheetFormulas([cell(0, 0, 7), cell(0, 1, { f: "=A1+1" })]);
    expect(values.get("0,1")).toBe(8);
  });

  it("answers #ERR for what the grid cannot run, and 0 for a cycle", async () => {
    const values = await computeSheetFormulas([
      cell(0, 0, { f: "=XLOOKUP(1,B1:B2,C1:C2)" }),
      cell(1, 0, { f: "=A2" }),
    ]);
    expect(values.get("0,0")).toBe("#ERR");
    expect(values.get("1,0")).toBe(0);
  });

  it("computes ROUND over references the way the agent writes them", async () => {
    const values = await computeSheetFormulas([
      cell(1, 7, { v: 5 }), // H2
      cell(1, 8, { v: 14300 }), // I2
      cell(1, 9, { f: "=ROUND(H2*I2*2,0)" }), // J2 — the measured blank cell
    ]);
    expect(values.get("1,9")).toBe(143000);
  });
});
