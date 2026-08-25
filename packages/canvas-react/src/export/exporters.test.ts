import { describe, expect, it } from "vitest";

import type { SlidesData, TableData } from "../protocol/artifacts";
import { dataExporters, slidesToPrintHtml, toStandaloneHtml } from "./exporters";

describe("slidesToPrintHtml (safe export)", () => {
  it("renders one page per slide", () => {
    const deck: SlidesData = { slides: [{ title: "A" }, { title: "B" }, { title: "C" }] };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html.match(/class="slide"/g)).toHaveLength(3);
  });

  it("keeps the classic 1280x720 page when the deck has no page", () => {
    const html = slidesToPrintHtml({ slides: [{ title: "A" }] }, "Deck");
    expect(html).toContain("@page { size: 1280px 720px; margin: 0; }");
  });

  it("prints on the deck page when one is set (4:3 skin)", () => {
    const deck: SlidesData = { slides: [{ title: "A" }], page: { widthIn: 10, heightIn: 7.5 } };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html).toContain("@page { size: 1280px 960px; margin: 0; }");
    expect(html).toContain("width: 1280px; height: 960px;");
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

  it("CSV shows the person's grid edits (sheet projected into rows)", async () => {
    const table: TableData = {
      columns: [{ key: "m", label: "M" }, { key: "n", label: "N" }],
      rows: [{ m: "Jan", n: 100 }],
      sheet: [
        {
          name: "S",
          celldata: [
            { r: 0, c: 0, v: { v: "M" } },
            { r: 0, c: 1, v: { v: "N" } },
            { r: 1, c: 0, v: { v: "Jan" } },
            { r: 1, c: 1, v: { v: 150 } }, // person changed 100 -> 150
          ],
        },
      ],
    } as TableData;
    const csv = dataExporters.table.find((e) => e.extension === "csv")!;
    const out = String(await csv.build({ id: "t", type: "table", title: "T", version: 1, status: "complete", data: table }));
    expect(out).toContain("Jan,150");
  });

  it("xlsx merges agent rows into the person's sheet and keeps their styling", async () => {
    const { Workbook } = await import("exceljs");
    const data: TableData = {
      columns: [{ key: "m", label: "M" }, { key: "n", label: "N" }],
      rows: [
        { m: "Jan", n: 100 },
        { m: "Total", n: "=SUM(B2:B2)" }, // agent-added after the person's edit
      ],
      sheet: [
        {
          name: "S",
          celldata: [
            { r: 1, c: 0, v: { v: "Jan" } },
            { r: 1, c: 1, v: { v: 100, bl: 1 } }, // person's bold
          ],
        },
      ],
    } as TableData;
    const xlsx = dataExporters.table.find((e) => e.extension === "xlsx")!;
    const buffer = (await xlsx.build({ id: "t", type: "table", title: "t", version: 1, status: "complete", data })) as ArrayBuffer;
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer);
    const ws = workbook.worksheets[0];
    expect(ws.getCell(2, 2).font?.bold).toBe(true); // person's bold survives
    expect(ws.getCell(3, 2).formula).toBe("SUM(B2:B2)"); // agent row exported
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

import { PRINT_COLOR_CSS } from "./exporters";

describe("printed background colours", () => {
  // A slide draws its shapes as div backgrounds, so a print that drops
  // backgrounds drops the shapes and keeps only the text.
  it("every route into the print pipeline asks for exact colours", () => {
    const deck: SlidesData = {
      slides: [{ elements: [{ id: "s", type: "shape", shape: "rect", fill: "#111827", x: 0, y: 0, w: 50, h: 50 }] }],
    };
    const slideHtml = `<!doctype html><html><head></head><body><div class="slide-container"></div></body></html>`;
    for (const html of [
      slidesToPrintHtml(deck, "Deck"),
      htmlSlideToPrintHtml(slideHtml, "16:9"),
      toStandaloneHtml("Report", "<p>hi</p>"),
    ]) {
      expect(html).toContain(PRINT_COLOR_CSS);
    }
  });

  it("names both the prefixed and the standard property", () => {
    expect(PRINT_COLOR_CSS).toContain("-webkit-print-color-adjust:exact");
    expect(PRINT_COLOR_CSS).toContain("print-color-adjust:exact");
  });
});
