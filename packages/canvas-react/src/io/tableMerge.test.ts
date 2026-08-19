import { describe, expect, it } from "vitest";

import type { TableColumn, TableData } from "../protocol/artifacts";
import { mergeRowsIntoSheet, projectSheetIntoRows, sameCellContent } from "./tableMerge";

const cols: TableColumn[] = [{ key: "dept", label: "Dept" }, { key: "amount", label: "Amount" }];

const sheetOf = (celldata: Array<{ r: number; c: number; v: unknown }>): TableData["sheet"] =>
  [{ name: "Sheet1", id: "s1", row: 60, column: 8, celldata }] as TableData["sheet"];

const header = [
  { r: 0, c: 0, v: { v: "Dept", m: "Dept", bl: 1 } },
  { r: 0, c: 1, v: { v: "Amount", m: "Amount", bl: 1 } },
];

const findCell = (sheet: TableData["sheet"], r: number, c: number) =>
  ((sheet?.[0] as { celldata?: Array<{ r: number; c: number; v: unknown }> }).celldata ?? []).find(
    (cell) => cell.r === r && cell.c === c,
  )?.v as Record<string, unknown> | undefined;

describe("sameCellContent (type normalization — rule 4)", () => {
  it("treats a number and its string form as equal", () => {
    expect(sameCellContent(80, { v: "80", m: "80" })).toBe(true);
    expect(sameCellContent("80", { v: 80, m: "80" })).toBe(true);
  });
  it("folds empty forms together", () => {
    expect(sameCellContent("", undefined)).toBe(true);
    expect(sameCellContent(null as never, { v: "" })).toBe(true);
  });
  it("compares formulas by source, '=' prefix ignored", () => {
    expect(sameCellContent("=SUM(B2:B4)", { f: "=SUM(B2:B4)", v: 60 })).toBe(true);
    expect(sameCellContent("=SUM(B2:B4)", { f: "SUM(B2:B4)", v: 60 })).toBe(true);
    expect(sameCellContent("=SUM(B2:B5)", { f: "=SUM(B2:B4)", v: 60 })).toBe(false);
    // A formula on either side never equals a plain value.
    expect(sameCellContent(60, { f: "=SUM(B2:B4)", v: 60 })).toBe(false);
  });
});

describe("projectSheetIntoRows (person → rows)", () => {
  it("projects edited values and person-added rows into rows", () => {
    const sheet = sheetOf([
      ...header,
      { r: 1, c: 0, v: { v: "Sales" } },
      { r: 1, c: 1, v: { v: 75, m: "75" } }, // person changed 60 → 75
      { r: 2, c: 0, v: { v: "HR" } }, // person-added row
      { r: 2, c: 1, v: { v: 80 } },
    ]);
    const rows = projectSheetIntoRows(cols, [{ dept: "Sales", amount: 60 }], sheet);
    expect(rows).toEqual([
      { dept: "Sales", amount: 75 },
      { dept: "HR", amount: 80 },
    ]);
  });

  it("projects a typed formula as its source, not its cached value (rule 1)", () => {
    const sheet = sheetOf([
      ...header,
      { r: 1, c: 1, v: { f: "=SUM(B2:B2)", v: 60, m: "60" } },
    ]);
    const rows = projectSheetIntoRows(cols, [{ dept: "x", amount: 0 }], sheet);
    expect(rows[0].amount).toBe("=SUM(B2:B2)");
  });

  it("drops trailing rows the person deleted, keeps mid-table gaps", () => {
    const sheet = sheetOf([
      ...header,
      { r: 1, c: 0, v: { v: "A" } },
      // r2 left fully empty (a separator row), r3 has content, r4+ nothing.
      { r: 3, c: 0, v: { v: "B" } },
    ]);
    const rows = projectSheetIntoRows(
      cols,
      [{ dept: "A" }, { dept: "gone" }, { dept: "B" }, { dept: "extra" }],
      sheet,
    );
    expect(rows).toHaveLength(3);
    expect(rows[1].dept).toBe(""); // the gap row survives as empty (indexes stay aligned)
    expect(rows[2].dept).toBe("B");
  });

  it("carries row keys outside the columns rectangle over untouched", () => {
    const sheet = sheetOf([...header, { r: 1, c: 0, v: { v: "A" } }]);
    const rows = projectSheetIntoRows(cols, [{ dept: "old", note: "keep me" } as never], sheet);
    expect((rows[0] as Record<string, unknown>).note).toBe("keep me");
  });
});

describe("mergeRowsIntoSheet (agent → sheet)", () => {
  it("is a no-op (same reference) when rows and sheet agree — number vs string included", () => {
    const sheet = sheetOf([
      ...header,
      { r: 1, c: 0, v: { v: "Sales" } },
      { r: 1, c: 1, v: { v: "80", m: "80" } },
    ]);
    const out = mergeRowsIntoSheet(cols, [{ dept: "Sales", amount: 80 }], sheet);
    expect(out).toBe(sheet); // rule 4: no false differences, no churn
  });

  it("overrides changed values while preserving the cell's styling", () => {
    const sheet = sheetOf([
      ...header,
      { r: 1, c: 1, v: { v: 80, m: "80", bl: 1, bg: "#ff0", ct: { fa: "General", t: "n" } } },
    ]);
    const out = mergeRowsIntoSheet(cols, [{ dept: "", amount: 95 }], sheet);
    const cell = findCell(out, 1, 1)!;
    expect(cell.v).toBe(95);
    expect(cell.bl).toBe(1); // person's bold survives
    expect(cell.bg).toBe("#ff0"); // person's fill survives
  });

  it("appends agent-added rows, with cached formula results when provided", () => {
    const sheet = sheetOf([...header, { r: 1, c: 1, v: { v: 10 } }]);
    const rows = [
      { dept: "", amount: 10 },
      { dept: "Total", amount: "=SUM(B2:B2)" },
    ];
    const out = mergeRowsIntoSheet(cols, rows, sheet, new Map([["2,1", 10]]));
    expect(findCell(out, 2, 0)!.v).toBe("Total");
    const formulaCell = findCell(out, 2, 1)!;
    expect(formulaCell.f).toBe("=SUM(B2:B2)");
    expect(formulaCell.v).toBe(10);
  });

  it("truncates trailing sheet rows the agent deleted — their styling goes too (rule 2)", () => {
    const sheet = sheetOf([
      ...header,
      { r: 1, c: 0, v: { v: "keep" } },
      { r: 2, c: 0, v: { v: "ghost", bl: 1 } },
    ]);
    const out = mergeRowsIntoSheet(cols, [{ dept: "keep" }], sheet);
    expect(findCell(out, 1, 0)!.v).toBe("keep");
    expect(findCell(out, 2, 0)).toBeUndefined();
  });

  it("preserves cells outside the rows rectangle (rule 3 — margin notes)", () => {
    const sheet = sheetOf([
      ...header,
      { r: 1, c: 0, v: { v: "A" } },
      { r: 5, c: 4, v: { v: "margin note" } }, // beyond columns AND beyond rows
    ]);
    const out = mergeRowsIntoSheet(cols, [{ dept: "changed" }], sheet);
    expect(findCell(out, 1, 0)!.v).toBe("changed");
    expect(findCell(out, 5, 4)!.v).toBe("margin note");
  });

  it("an agent-cleared cell keeps its styling but loses its value", () => {
    const sheet = sheetOf([...header, { r: 1, c: 1, v: { v: 80, m: "80", bg: "#ff0" } }]);
    const out = mergeRowsIntoSheet(cols, [{ dept: "", amount: "" }], sheet);
    const cell = findCell(out, 1, 1)!;
    expect(cell.v).toBeUndefined();
    expect(cell.bg).toBe("#ff0");
  });

  it("round-trip is stable: project, then merge, changes nothing", () => {
    const sheet = sheetOf([
      ...header,
      { r: 1, c: 0, v: { v: "Sales", it: 1 } },
      { r: 1, c: 1, v: { f: "=SUM(B2:B2)", v: 60, m: "60", bl: 1 } },
      { r: 3, c: 3, v: { v: "note" } },
    ]);
    const rows = projectSheetIntoRows(cols, [], sheet);
    expect(mergeRowsIntoSheet(cols, rows, sheet)).toBe(sheet);
  });
});
