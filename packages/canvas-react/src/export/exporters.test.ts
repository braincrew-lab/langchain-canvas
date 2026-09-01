import { describe, expect, it } from "vitest";

import type { SlidesData, TableData } from "../protocol/artifacts";
import { dataExporters, slidesToPrintHtml, toStandaloneHtml } from "./exporters";
import { DEFAULT_SLIDE_PAGE_IN, PAGE_DPI } from "../client/slidePage";

describe("slidesToPrintHtml (safe export)", () => {
  it("renders one page per slide", () => {
    const deck: SlidesData = { slides: [{ title: "A" }, { title: "B" }, { title: "C" }] };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html.match(/class="slide"/g)).toHaveLength(3);
  });

  // The page is the deck's own page at the density fontSize is stored at, so a
  // stored px is a CSS px on the printed page and text needs no scaling.
  it.each([
    ["the classic page when the deck has no page", undefined, DEFAULT_SLIDE_PAGE_IN],
    ["the deck page when one is set (4:3 skin)", { widthIn: 10, heightIn: 7.5 }, { widthIn: 10, heightIn: 7.5 }],
    ["a wide 16:9 deck page", { widthIn: 13.333, heightIn: 7.5 }, { widthIn: 13.333, heightIn: 7.5 }],
  ])("prints on %s", (_label, page, expected) => {
    const html = slidesToPrintHtml({ slides: [{ title: "A" }], ...(page ? { page } : {}) }, "Deck");
    const w = Math.round(expected.widthIn * PAGE_DPI);
    const h = Math.round(expected.heightIn * PAGE_DPI);
    expect(html).toContain(`@page { size: ${w}px ${h}px; margin: 0; }`);
    expect(html).toContain(`width: ${w}px; height: ${h}px;`);
  });

  it("prints stored font px unscaled — no viewport units, which resolve against the printing frame", () => {
    const deck: SlidesData = {
      slides: [{ elements: [{ id: "t", type: "text", x: 0, y: 0, w: 50, h: 10, text: "A", fontSize: 18.7 }] }],
    };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html).toContain("font-size:18.7px");
    expect(html).not.toMatch(/font-size:[^;"]*vw/);
  });

  it("writes the text metrics the model carries", () => {
    const deck: SlidesData = {
      slides: [{
        elements: [{
          id: "t", type: "text", x: 0, y: 0, w: 50, h: 10, text: "A",
          fontFamily: "Pretendard", lineHeight: 1.4, highlight: "#ff0000",
          spaceBefore: 6, spaceAfter: 4, verticalAlign: "middle",
        }],
      }],
    };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html).toContain("font-family:Pretendard");
    expect(html).toContain("line-height:1.4");
    expect(html).toContain("background:#ff0000");
    expect(html).toContain("padding-top:6px");
    expect(html).toContain("padding-bottom:4px");
    expect(html).toContain("justify-content:center");
  });

  it("draws a growing box at its grown height and shrinking type at its shrink", () => {
    const long = "가나다라마바사아자차카타파하 ".repeat(8);
    const deck: SlidesData = {
      slides: [{
        elements: [
          { id: "g", type: "text", x: 0, y: 0, w: 40, h: 5, fontSize: 24, text: long, autofit: "shape" },
          { id: "s", type: "text", x: 0, y: 50, w: 40, h: 5, fontSize: 24, text: long, autofit: "text" },
          { id: "f", type: "text", x: 0, y: 70, w: 40, h: 5, fontSize: 24, text: long },
        ],
      }],
    };
    const html = slidesToPrintHtml(deck, "Deck");
    const heights = [...html.matchAll(/height:([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(heights[0]).toBeGreaterThan(20);
    expect(heights[1]).toBe(5);
    expect(heights[2]).toBe(5);
    expect(html).toContain("font-size:24px");
    expect(html).toMatch(/font-size:(\d+\.\d+|[1-9]|1\d|2[0-3])px/);
  });

  it("draws a shape that has only an outline as an outline, with no fill", () => {
    const deck: SlidesData = {
      slides: [{
        elements: [{ id: "s", type: "shape", shape: "rect", x: 0, y: 0, w: 50, h: 10, stroke: "#c00000", strokeWidth: 3 }],
      }],
    };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html).toContain("border:3px solid #c00000");
    expect(html).toContain("background:transparent");
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

describe("slidesToPrintHtml (tables)", () => {
  it("prints a table element as a real table with its spans, widths and grid line", () => {
    const deck: SlidesData = {
      slides: [
        {
          elements: [
            {
              id: "t", type: "table", x: 10, y: 20, w: 80, h: 40,
              rows: [["Header", ""], ["a", "b"]],
              header: true, colWidths: [3, 1], stroke: "#9E9E9E", strokeWidth: 2, fontSize: 16,
              cells: [{ r: 0, c: 0, colSpan: 2, fill: "#DDEEFF" }],
            },
          ],
        },
      ],
    };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html).toContain('<col style="width:75%">');
    expect(html).toContain('rowspan="1" colspan="2"');
    expect(html).toContain("border:2px solid #9E9E9E");
    expect(html).toContain("background:#DDEEFF");
    expect(html).toMatch(/font-weight:700[^>]*>Header</);
    expect(html).toMatch(/font-weight:400[^>]*>a</);
    expect(html.match(/<td/g)).toHaveLength(3); // the covered cell is not drawn
  });

  it("draws the master backdrop behind the elements and never guesses a shape colour", () => {
    const deck: SlidesData = {
      slides: [{
        masterImage: "data:image/png;base64,AAAA",
        elements: [
          { id: "u", type: "shape", shape: "rect", x: 0, y: 0, w: 40, h: 10, fill: "none" },
          { id: "v", type: "shape", shape: "rect", x: 0, y: 20, w: 40, h: 10 },
        ],
      }],
    };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    const fills = [...html.matchAll(/background:([^;"']+)/g)].map((m) => m[1]);
    expect(fills.filter((f) => f === "transparent").length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("currentColor");
  });
});
