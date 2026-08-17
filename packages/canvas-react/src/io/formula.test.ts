import { describe, expect, it } from "vitest";

import type { TableColumn, TableData } from "../protocol/artifacts";
import { computeFormulas } from "./formula";
import { SUPPORTED_FORMULA_FUNCTIONS } from "./formulaFunctions";

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

  it("evaluates the registered classics: SUMIFS / AVERAGEIFS / COUNTIFS", async () => {
    // region | amount — two Wests (10, 30), one East (20).
    const c: TableColumn[] = [{ key: "region" }, { key: "amount" }, { key: "out" }];
    const r: TableData["rows"] = [
      { region: "West", amount: 10, out: '=SUMIFS(B2:B4, A2:A4, "West")' },
      { region: "East", amount: 20, out: '=AVERAGEIFS(B2:B4, A2:A4, "West")' },
      { region: "West", amount: 30, out: '=COUNTIFS(A2:A4, "West", B2:B4, ">15")' },
    ];
    const out = await computeFormulas(c, r);
    expect(out.get("1,2")).toBe(40); // 10 + 30
    expect(out.get("2,2")).toBe(20); // (10 + 30) / 2
    expect(out.get("3,2")).toBe(1); // only the 30-West row passes both
  });

  it("evaluates MATCH exact and approximate", async () => {
    const r: TableData["rows"] = [
      { a: 10, b: "=MATCH(20, A2:A4, 0)" },
      { a: 20, b: "=MATCH(25, A2:A4, 1)" },
      { a: 30, b: "=MATCH(99, A2:A4, 0)" },
    ];
    const out = await computeFormulas(cols, r);
    expect(out.get("1,1")).toBe(2); // exact: 20 is the 2nd value
    expect(out.get("2,1")).toBe(2); // approximate: last value <= 25
    expect(out.get("3,1")).toBe("#ERR"); // no exact match
  });

  it("evaluates MAX / MIN over ranges", async () => {
    const r: TableData["rows"] = [
      { a: 7, b: "=MAX(A2:A4)" },
      { a: 2, b: "=MIN(A2:A4)" },
      { a: 5, b: 0 },
    ];
    const out = await computeFormulas(cols, r);
    expect(out.get("1,1")).toBe(7);
    expect(out.get("2,1")).toBe(2);
  });

  it("evaluates TEXTJOIN with ignore-empty", async () => {
    const c: TableColumn[] = [{ key: "name" }, { key: "out" }];
    const r: TableData["rows"] = [
      { name: "Kim", out: '=TEXTJOIN(", ", TRUE, A2:A4)' },
      { name: "", out: 0 },
      { name: "Lee", out: 0 },
    ];
    const out = await computeFormulas(c, r);
    expect(out.get("1,1")).toBe("Kim, Lee");
  });

  it("evaluates every function on the supported list (no silent drift)", async () => {
    // Data grid: A = 10 / 20 / 30, B = "x" / "" / "y". One probe per function;
    // `expected` is a value, or "number" for date functions whose serial varies.
    const probes: Record<string, { formula: string; expected: string | number }> = {
      AVERAGE: { formula: "=AVERAGE(A2:A4)", expected: 20 },
      AVERAGEIF: { formula: '=AVERAGEIF(A2:A4, ">10")', expected: 25 },
      AVERAGEIFS: { formula: '=AVERAGEIFS(A2:A4, A2:A4, ">10")', expected: 25 },
      COUNT: { formula: "=COUNT(A2:A4)", expected: 3 },
      COUNTIF: { formula: '=COUNTIF(A2:A4, ">10")', expected: 2 },
      COUNTIFS: { formula: '=COUNTIFS(A2:A4, ">10")', expected: 2 },
      DATE: { formula: "=DATE(2024, 1, 31)", expected: "number" },
      EOMONTH: { formula: "=EOMONTH(DATE(2024, 1, 15), 0)", expected: "number" },
      IF: { formula: '=IF(1 > 0, "yes", "no")', expected: "yes" },
      IFERROR: { formula: '=IFERROR(1/0, "fallback")', expected: "fallback" },
      INDEX: { formula: "=INDEX(A2:A4, 2)", expected: 20 },
      MATCH: { formula: "=MATCH(20, A2:A4, 0)", expected: 2 },
      MAX: { formula: "=MAX(A2:A4)", expected: 30 },
      MIN: { formula: "=MIN(A2:A4)", expected: 10 },
      ROUND: { formula: "=ROUND(1.235, 1)", expected: 1.2 },
      SUM: { formula: "=SUM(A2:A4)", expected: 60 },
      SUMIF: { formula: '=SUMIF(A2:A4, ">10")', expected: 50 },
      SUMIFS: { formula: '=SUMIFS(A2:A4, A2:A4, ">10")', expected: 50 },
      TEXTJOIN: { formula: '=TEXTJOIN("-", TRUE, B2:B4)', expected: "x-y" },
      TODAY: { formula: "=TODAY()", expected: "number" },
      VLOOKUP: { formula: "=VLOOKUP(30, A2:B4, 2, 0)", expected: "y" },
    };
    expect(Object.keys(probes).sort()).toEqual([...SUPPORTED_FORMULA_FUNCTIONS].sort());

    const c: TableColumn[] = [{ key: "a" }, { key: "b" }, { key: "probe" }];
    for (const [name, { formula, expected }] of Object.entries(probes)) {
      const r: TableData["rows"] = [
        { a: 10, b: "x", probe: formula },
        { a: 20, b: "", probe: 0 },
        { a: 30, b: "y", probe: 0 },
      ];
      const out = await computeFormulas(c, r);
      const got = out.get("1,2");
      if (expected === "number") expect(typeof got, name).toBe("number");
      else expect(got, name).toBe(expected);
    }
  });

  it("clamps an over-long range to the data extent instead of iterating it fully", async () => {
    // Formula in column B sums an over-long column-A range; clamps to A2:A4.
    const r: TableData["rows"] = [{ a: 1, b: 0 }, { a: 2, b: 0 }, { a: 3, b: "=SUM(A2:A1000)" }];
    const out = await computeFormulas(cols, r);
    expect(out.get("3,1")).toBe(6); // 1 + 2 + 3; rows 5..1000 are clamped away
  });
});
