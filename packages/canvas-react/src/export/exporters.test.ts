import { describe, expect, it } from "vitest";

import type { SlidesData, TableData } from "../protocol/artifacts";
import { dataExporters, slidesToPrintHtml, toStandaloneHtml } from "./exporters";

describe("slidesToPrintHtml (safe export)", () => {
  it("renders one page per slide", () => {
    const deck: SlidesData = { slides: [{ title: "A" }, { title: "B" }, { title: "C" }] };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html.match(/class="slide"/g)).toHaveLength(3);
  });

  it("escapes text so an artifact can't inject markup", () => {
    const deck: SlidesData = {
      slides: [{ elements: [{ id: "t", type: "text", x: 0, y: 0, w: 50, h: 10, text: "<script>alert(1)</script>" }] }],
    };
    const html = slidesToPrintHtml(deck, "x");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops a javascript: image src and can't break out of the attribute", () => {
    const deck: SlidesData = {
      slides: [{ elements: [{ id: "i", type: "image", x: 0, y: 0, w: 50, h: 50, src: 'javascript:alert(1)' }] }],
    };
    const html = slidesToPrintHtml(deck, "x");
    expect(html).not.toContain("javascript:");
  });

  it("escapes a quote-breakout attempt in an image src", () => {
    const deck: SlidesData = {
      slides: [{ elements: [{ id: "i", type: "image", x: 0, y: 0, w: 50, h: 50, src: 'https://x/"><script>evil()</script>' }] }],
    };
    const html = slidesToPrintHtml(deck, "x");
    expect(html).not.toContain("<script>evil()</script>");
  });
});

describe("toStandaloneHtml", () => {
  it("wraps rendered HTML into a full, titled document", () => {
    const out = toStandaloneHtml("My Report", "<p>hi</p>");
    expect(out).toMatch(/^<!doctype html>/i);
    expect(out).toContain("<title>My Report</title>");
    expect(out).toContain("<p>hi</p>");
  });
});

describe("dataExporters", () => {
  it("keeps '=' row values as formulas with cached results in xlsx", async () => {
    const { Workbook } = await import("exceljs");
    const data: TableData = {
      columns: [{ key: "a", label: "A" }],
      rows: [{ a: 10 }, { a: 20 }, { a: "=SUM(A2:A3)" }],
    };
    const xlsx = dataExporters.table.find((e) => e.extension === "xlsx")!;
    const buffer = (await xlsx.build({ id: "t", type: "table", title: "t", version: 1, status: "complete", data })) as ArrayBuffer;
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer);
    const cell = workbook.worksheets[0].getCell(4, 1);
    expect(cell.formula).toBe("SUM(A2:A3)");
    expect(cell.result).toBe(30);
  });

  it("keeps a grid-typed formula (celldata `f`) as a formula in xlsx", async () => {
    const { Workbook } = await import("exceljs");
    const data: TableData = {
      columns: [],
      rows: [],
      sheet: [
        {
          name: "S",
          celldata: [
            { r: 0, c: 0, v: { v: 1 } },
            { r: 1, c: 0, v: { v: 2 } },
            { r: 2, c: 0, v: { v: 3, f: "=SUM(A1:A2)" } },
          ],
        },
      ],
    } as TableData;
    const xlsx = dataExporters.table.find((e) => e.extension === "xlsx")!;
    const buffer = (await xlsx.build({ id: "t", type: "table", title: "t", version: 1, status: "complete", data })) as ArrayBuffer;
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer);
    const cell = workbook.worksheets[0].getCell(3, 1);
    expect(cell.formula).toBe("SUM(A1:A2)");
    expect(cell.result).toBe(3);
  });

  it("exports a table to CSV", async () => {
    const table: TableData = {
      columns: [{ key: "name", label: "Name" }, { key: "n", label: "N" }],
      rows: [{ name: "Ann, Jr", n: 3 }],
    };
    const csv = dataExporters.table.find((e) => e.extension === "csv")!;
    const out = String(await csv.build({ id: "t", type: "table", title: "T", version: 1, status: "complete", data: table }));
    expect(out).toContain("Name,N");
    expect(out).toContain('"Ann, Jr"'); // comma-containing value is quoted
  });
});

import { htmlSlideToPrintHtml } from "./exporters";

describe("htmlSlideToPrintHtml", () => {
  const slide = `<!doctype html><html><head><style>.slide-container{width:1280px;height:720px}</style></head><body><div class="slide-container"><h1>Hi</h1></div></body></html>`;
  it("adds a 16:9 slide-sized @page and pins the slide box", () => {
    const out = htmlSlideToPrintHtml(slide, "16:9");
    expect(out).toContain("@page{size:1280px 720px;margin:0}");
    expect(out).toContain("width:1280px!important");
    expect(out).toContain('<div class="slide-container">'); // content preserved
  });
  it("uses 960×720 for 4:3", () => {
    expect(htmlSlideToPrintHtml(slide, "4:3")).toContain("@page{size:960px 720px;margin:0}");
  });
  it("injects before </head> when present", () => {
    const out = htmlSlideToPrintHtml(slide, "16:9");
    expect(out.indexOf("@page")).toBeLessThan(out.indexOf("</head>"));
  });
});
