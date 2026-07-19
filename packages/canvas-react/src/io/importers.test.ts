import { describe, expect, it } from "vitest";

import type { CanvasCreate } from "../protocol/events";
import { canImport, importFile, parseCsv } from "./importers";

// jsdom's File doesn't implement the Blob read methods, so back them with the body.
const file = (name: string, body: string): File =>
  Object.assign(new File([body], name, { type: "text/plain" }), {
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }) as File;
const created = (events: Awaited<ReturnType<typeof importFile>>) =>
  events.find((e): e is CanvasCreate => e.type === "canvas.create")!.artifact;

describe("parseCsv", () => {
  it("parses a header + rows", () => {
    const t = parseCsv("Name,Age\nAlice,30\nBob,25");
    expect(t.columns.map((c) => c.key)).toEqual(["Name", "Age"]);
    expect(t.rows).toEqual([
      { Name: "Alice", Age: 30 },
      { Name: "Bob", Age: 25 },
    ]);
  });

  it("keeps quoted commas and escaped quotes inside one field", () => {
    const t = parseCsv('Name,Role\nBob,"Designer, Lead"\nCarol,"Says ""hi"""');
    expect(t.rows[0].Role).toBe("Designer, Lead");
    expect(t.rows[1].Role).toBe('Says "hi"');
  });

  it("only coerces numbers that round-trip (IDs stay strings)", () => {
    const t = parseCsv("Code,Qty\n00123,5\n1e3,7\n0x10,9\n6.33,1");
    expect(t.rows[0].Code).toBe("00123"); // leading zero preserved
    expect(t.rows[0].Qty).toBe(5);
    expect(t.rows[1].Code).toBe("1e3"); // not 1000
    expect(t.rows[2].Code).toBe("0x10"); // not 16
    expect(t.rows[3].Code).toBe(6.33);
  });

  it("de-duplicates repeated header names", () => {
    const t = parseCsv("A,A,B\n1,2,3");
    expect(t.columns.map((c) => c.key)).toEqual(["A", "A (2)", "B"]);
    expect(t.rows[0]).toEqual({ A: 1, "A (2)": 2, B: 3 });
  });
});

describe("importFile routing", () => {
  it("CSV → table artifact", async () => {
    const a = created(await importFile(file("people.csv", "x,y\n1,2")));
    expect(a.type).toBe("table");
    expect(a.title).toBe("people");
    expect(a.status).toBe("complete");
  });

  it("Markdown → document artifact", async () => {
    const a = created(await importFile(file("notes.md", "# Hi")));
    expect(a.type).toBe("document");
    expect((a.data as { content: string }).content).toBe("# Hi");
  });

  it("HTML → html artifact (source preserved)", async () => {
    const a = created(await importFile(file("page.html", "<h1>Hi</h1>")));
    expect(a.type).toBe("html");
    expect((a.data as { html: string }).html).toBe("<h1>Hi</h1>");
  });

  it("a previously-exported artifact JSON is re-homed under a fresh id", async () => {
    const payload = JSON.stringify({ id: "old", type: "document", title: "T", version: 3, data: { format: "markdown", content: "x" } });
    const a = created(await importFile(file("art.json", payload)));
    expect(a.type).toBe("document");
    expect(a.version).toBe(1);
    expect(a.id).not.toBe("old");
  });

  it("rejects an unsupported extension", async () => {
    await expect(importFile(file("a.exe", "x"))).rejects.toThrow(/Unsupported/);
  });
});

describe("importFile xlsx (robust to real spreadsheets)", () => {
  it("reads the full range, fills merged cells, and names blank headers by letter", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("s");
    ws.getCell("A1").value = "Name"; // B1 left blank → should become column "B"
    ws.getCell("C1").value = "Role";
    ws.getCell("A2").value = "Alice";
    ws.getCell("B2").value = 30;
    ws.getCell("C2").value = "Eng";
    ws.mergeCells("A3:A4"); // vertical merge — value only on the master A3
    ws.getCell("A3").value = "Team X";
    ws.getCell("C3").value = "PM";
    ws.getCell("C4").value = "Designer";
    const buf = await wb.xlsx.writeBuffer();
    const f = Object.assign(new File([], "sheet.xlsx"), { arrayBuffer: async () => buf }) as File;

    const events = await importFile(f);
    const table = created(events).data as { columns: { key: string }[]; rows: Record<string, unknown>[]; sheet?: any[] };
    expect(table.columns.map((c) => c.key)).toEqual(["Name", "B", "Role"]);
    expect(table.rows[0]).toEqual({ Name: "Alice", B: 30, Role: "Eng" });
    // merged A3:A4 → both rows carry "Team X"
    expect(table.rows[1].Name).toBe("Team X");
    expect(table.rows[2].Name).toBe("Team X");
    expect(table.rows[2].Role).toBe("Designer");
  });

  it("keeps every sheet, real merges, and cell styling in the rich `sheet` blob", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const cover = wb.addWorksheet("Cover");
    cover.mergeCells("A1:C1"); // real merge, value on master only
    cover.getCell("A1").value = "Deep Agent Builder";
    cover.getCell("A1").font = { bold: true, size: 14 };
    cover.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEEFF" } } as any;
    wb.addWorksheet("WBS").getCell("A1").value = "task"; // a second sheet with content
    const buf = await wb.xlsx.writeBuffer();
    const f = Object.assign(new File([], "doc.xlsx"), { arrayBuffer: async () => buf }) as File;

    const table = created(await importFile(f)).data as { sheet: any[] };
    expect(table.sheet).toHaveLength(2); // both sheets imported (not just the cover)
    expect(table.sheet[1].name).toBe("WBS");
    // merge preserved (not duplicated across cells)
    expect(table.sheet[0].config.merge["0_0"]).toMatchObject({ r: 0, c: 0, rs: 1, cs: 3 });
    // styling preserved on the master cell
    const master = table.sheet[0].celldata.find((d: any) => d.r === 0 && d.c === 0);
    expect(master.v.bl).toBe(1);
    expect(master.v.bg).toBe("#DDEEFF");
    expect(master.v.m).toBe("Deep Agent Builder");
    expect(master.v.mc).toMatchObject({ r: 0, c: 0, rs: 1, cs: 3 }); // master carries the span
    // covered cells point back to the master and hold no value (content shows once)
    const covered = table.sheet[0].celldata.find((d: any) => d.r === 0 && d.c === 1);
    expect(covered.v).toEqual({ mc: { r: 0, c: 0 } });
  });

  it("resolves theme-indexed text and fill colours (not just literal ARGB)", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("s");
    const cell = ws.getCell("A1");
    cell.value = "themed";
    cell.font = { color: { theme: 0 } as any }; // theme 0 = white text
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { theme: 4 } as any }; // accent1 blue
    const buf = await wb.xlsx.writeBuffer();
    const f = Object.assign(new File([], "c.xlsx"), { arrayBuffer: async () => buf }) as File;

    const table = created(await importFile(f)).data as { sheet: any[] };
    const c = table.sheet[0].celldata.find((d: any) => d.r === 0 && d.c === 0);
    expect(c.v.fc).toBe("#FFFFFF"); // white, resolved from theme 0
    expect(c.v.bg).toBe("#4472C4"); // accent1, resolved from theme 4
  });

  it("carries cell borders and legacy indexed fill colours", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("s");
    const cell = ws.getCell("B2");
    cell.value = "boxed";
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { indexed: 22 } as any }; // #C0C0C0
    cell.border = {
      top: { style: "thin", color: { argb: "FFBFBFBF" } },
      bottom: { style: "medium" },
      left: { style: "thin" },
      right: { style: "thin" },
    };
    const buf = await wb.xlsx.writeBuffer();
    const f = Object.assign(new File([], "b.xlsx"), { arrayBuffer: async () => buf }) as File;

    const table = created(await importFile(f)).data as { sheet: any[] };
    const border = table.sheet[0].config.borderInfo.find(
      (b: any) => b.value.row_index === 1 && b.value.col_index === 1,
    );
    expect(border.rangeType).toBe("cell");
    expect(border.value.t).toEqual({ style: 1, color: "#BFBFBF" }); // thin
    expect(border.value.b).toEqual({ style: 8, color: "#000000" }); // medium, default colour
    const cd = table.sheet[0].celldata.find((d: any) => d.r === 1 && d.c === 1);
    expect(cd.v.bg).toBe("#C0C0C0"); // resolved from indexed 22
  });

  it("renders numbers and dates using their Excel number format", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("s");
    ws.getCell("A1").value = 1234.5; ws.getCell("A1").numFmt = "#,##0.00";
    ws.getCell("A2").value = 0.156; ws.getCell("A2").numFmt = "0.0%";
    ws.getCell("A3").value = 1000; ws.getCell("A3").numFmt = "$#,##0";
    ws.getCell("A4").value = new Date(2026, 6, 11); ws.getCell("A4").numFmt = "yyyy-mm-dd";
    const buf = await wb.xlsx.writeBuffer();
    const f = Object.assign(new File([], "n.xlsx"), { arrayBuffer: async () => buf }) as File;

    const table = created(await importFile(f)).data as { sheet: any[] };
    const m = (r: number) => table.sheet[0].celldata.find((d: any) => d.r === r && d.c === 0)?.v.m;
    expect(m(0)).toBe("1,234.50"); // thousands + 2 decimals
    expect(m(1)).toBe("15.6%"); // percent
    expect(m(2)).toBe("$1,000"); // currency + thousands
    expect(m(3)).toBe("2026-07-11"); // date pattern, local calendar day
  });
});

describe("canImport", () => {
  it("accepts known extensions, rejects others", () => {
    expect(canImport(file("a.csv", ""))).toBe(true);
    expect(canImport(file("a.XLSX", ""))).toBe(true);
    expect(canImport(file("a.png", ""))).toBe(false);
  });
});
