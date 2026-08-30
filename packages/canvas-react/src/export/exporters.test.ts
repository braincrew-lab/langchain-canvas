import { describe, expect, it } from "vitest";

import type { TableData } from "../protocol/artifacts";
import { dataExporters, slidesToPrintHtml, toStandaloneHtml } from "./exporters";

/** A canonical `*.slides.html` document with one slide per `bodies` entry. */
function deckHtml(ratio: string, ...bodies: string[]): string {
  const templates = bodies
    .map((body, i) => `<template data-slide-id="s${i + 1}">${body}</template>`)
    .join("\n");
  return `<!doctype html><html data-ratio="${ratio}"><head><title>Deck</title></head><body>${templates}</body></html>`;
}

describe("slidesToPrintHtml (deck HTML -> print HTML)", () => {
  it("renders one page per slide, in slide order", () => {
    const html = slidesToPrintHtml(deckHtml("16:9", "<h1>A</h1>", "<h1>B</h1>", "<h1>C</h1>"), "Deck");
    expect(html.match(/class="cv-print-slide"/g)).toHaveLength(3);
    expect(html.indexOf(">A<")).toBeLessThan(html.indexOf(">B<"));
    expect(html.indexOf(">B<")).toBeLessThan(html.indexOf(">C<"));
  });

  it("page-breaks after every slide except the last", () => {
    const html = slidesToPrintHtml(deckHtml("16:9", "<h1>A</h1>", "<h1>B</h1>"), "Deck");
    expect(html.match(/page-break-after:always/g)).toHaveLength(1);
  });

  it("sizes a 16:9 deck to 1280x720 (via htmlSlideToPrintHtml)", () => {
    const html = slidesToPrintHtml(deckHtml("16:9", "<h1>A</h1>"), "Deck");
    expect(html).toContain("@page{size:1280px 720px;margin:0}");
    expect(html).toContain("width:1280px;height:720px");
  });

  it("sizes a 4:3 deck to 960x720", () => {
    const html = slidesToPrintHtml(deckHtml("4:3", "<h1>A</h1>"), "Deck");
    expect(html).toContain("@page{size:960px 720px;margin:0}");
    expect(html).toContain("width:960px;height:720px");
  });

  it("keeps each slide's own styleCss scoped to its own section", () => {
    const html = slidesToPrintHtml(
      deckHtml("16:9", "<style>.title{color:red}</style><h1 class=\"title\">A</h1>", "<h1>B</h1>"),
      "Deck",
    );
    expect(html).toContain(".title{color:red}");
  });

  it("renders a single empty-state page for a deck with no slides", () => {
    const html = slidesToPrintHtml(deckHtml("16:9"), "Deck");
    expect(html.match(/class="cv-print-slide"/g)).toHaveLength(1);
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
  // A slide draws its shapes as CSS backgrounds, so a print that drops
  // backgrounds drops the shapes and keeps only the text.
  it("every route into the print pipeline asks for exact colours", () => {
    const slideHtml = `<!doctype html><html><head></head><body><div class="slide-container"></div></body></html>`;
    for (const html of [
      slidesToPrintHtml(deckHtml("16:9", `<div style="background:#111827"></div>`), "Deck"),
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

