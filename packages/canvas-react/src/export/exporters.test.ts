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
    // A grown box's height is `calc(<pct>% + <ink guard>)` (U1), a fixed one's `<pct>%`.
    const heights = [...html.matchAll(/height:(?:calc\()?([\d.]+)%/g)].map((m) => Number(m[1]));
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

describe("the browser Word file (U5)", () => {
  // U5 test 3: the browser's `.docx` carries the same block set as the
  // Python door — a real table, soft-joined lines in one paragraph, numbered
  // items — proven by rendering the bytes with docx-preview in jsdom. When
  // CANVAS_PARITY_EVIDENCE_DIR is set the bytes are also saved for the
  // LibreOffice render gate (D1 / D4), a by-product the assertions never use.
  it("keeps tables, numbered items and joined lines", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixture = readFileSync(path.join(here, "__fixtures__", "parity-document.md"), "utf8");
    const { Packer } = await import("docx");
    const { documentToDocxDocument } = await import("./exporters");
    const document = await documentToDocxDocument({ format: "markdown", content: fixture });
    const bytes = new Uint8Array(await Packer.toBuffer(document));
    const evidenceDir = process.env.CANVAS_PARITY_EVIDENCE_DIR;
    if (evidenceDir) writeFileSync(path.join(evidenceDir, "parity-document.browser.docx"), bytes);
    URL.createObjectURL ??= () => "blob:test";
    const { renderAsync } = await import("docx-preview");
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    await renderAsync(bytes, host, undefined, { inWrapper: true, breakPages: true, useBase64URL: true });
    expect(host.querySelectorAll("table")).toHaveLength(1);
    const paragraphs = Array.from(host.querySelectorAll("p")).map((p) => p.textContent ?? "");
    expect(paragraphs.some((t) => t.includes("협업 범위를 정리한다.") && t.includes("이어지는 줄은 같은 문단이다."))).toBe(true);
    expect(paragraphs.some((t) => t.includes("첫째 항목"))).toBe(true);
    host.remove();
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

describe("slidesToPrintHtml (grown box ink guard, U1)", () => {
  // Plan R3 addendum: a box that grows with its text is printed at the
  // estimator's height plus the face-derived ink guard, evaluated on a
  // `line-height: normal` box whose text child keeps the leading. Fixed boxes
  // are printed exactly as before.
  const grown = {
    id: "g", type: "text" as const, x: 5, y: 5, w: 40, h: 6, fontSize: 24, fontFamily: "Noto Sans CJK KR",
    text: "• " + "가".repeat(40), autofit: "shape" as const,
  };

  it("prints a growing box on a line-height: normal box with the guard, and its text in a child that keeps the leading", () => {
    const html = slidesToPrintHtml({ slides: [{ elements: [grown] }] }, "Deck");
    const box = html.match(/<div class="el"[^>]*>/)?.[0] ?? "";
    expect(box).toContain("height:calc(16% + max(0px, (1lh - 1.2em) / 2))");
    expect(box).toContain("line-height:normal");
    expect(box).toContain("font-size:24px");
    // The child holds the body — here a bullet paragraph (U3), so a hanging block.
    expect(html).toContain('<div class="el__text" style="line-height:1.2"><div class="p-bullet">');
    expect(html).toContain(`•</span>${grown.text.slice(2)}</div></div></div>`);
  });

  it("keeps an explicit leading on the text child and in the guard", () => {
    const html = slidesToPrintHtml({ slides: [{ elements: [{ ...grown, lineHeight: 1.5 }] }] }, "Deck");
    expect(html).toContain("height:calc(20% + max(0px, (1lh - 1.5em) / 2))");
    expect(html).toContain('<div class="el__text" style="line-height:1.5">');
  });

  it("prints a fixed box and a shrink-to-fit box exactly as stored, with no guard and no child", () => {
    const html = slidesToPrintHtml({ slides: [{ elements: [{ ...grown, autofit: undefined }, { ...grown, id: "s", autofit: "text" }] }] }, "Deck");
    expect(html.match(/height:6%/g)).toHaveLength(2);
    expect(html).not.toContain("1lh");
    expect(html).not.toContain("el__text");
    expect(html).not.toContain("line-height:normal");
  });
});

describe("slidesToPrintHtml (square corners, U4)", () => {
  it("the print sheet draws square rectangles and flat lines, and keeps the ellipse round", () => {
    const deck: SlidesData = {
      slides: [{
        elements: [
          { id: "r", type: "shape", shape: "rect", x: 5, y: 48, w: 30, h: 10, fill: "#00aa00" },
          { id: "l", type: "shape", shape: "line", x: 5, y: 62, w: 40, h: 2, fill: "#0000ff", strokeWidth: 2 },
          { id: "e", type: "shape", shape: "ellipse", x: 50, y: 50, w: 10, h: 10, fill: "#000" },
        ],
      }],
    };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html.match(/border-radius:0[;"]/g)).toHaveLength(2);
    expect(html).not.toContain("border-radius:8px");
    expect(html).not.toContain("border-radius:2px");
    expect(html).toContain("border-radius:50%");
  });
});

describe("slidesToPrintHtml (bullet hang, U3)", () => {
  const box = { id: "b", type: "text" as const, x: 0, y: 0, w: 50, h: 10, fontSize: 24 };

  it("a bulleted box prints one hanging paragraph per line", () => {
    const html = slidesToPrintHtml({ slides: [{ elements: [{ ...box, text: "• 하나\n• <b>둘" }] }] }, "Deck");
    expect(html.match(/class="p-bullet"/g)).toHaveLength(2);
    expect(html.match(/<span class="p-bullet__marker">•<\/span>/g)).toHaveLength(2);
    expect(html).toContain("•</span>하나");
    expect(html).not.toContain("• 하나");
    expect(html).toContain("&lt;b&gt;둘");
    expect(html).toContain(".p-bullet { padding-left: 1.2em; text-indent: -1.2em; }");
    expect(html).toContain(".p-bullet__marker { display: inline-block; width: 1.2em; text-indent: 0; }");
  });

  it("keeps plain paragraphs as blocks beside bullets and holds an empty line open", () => {
    const html = slidesToPrintHtml({ slides: [{ elements: [{ ...box, text: "• a\n\nb" }] }] }, "Deck");
    expect(html).toContain("•</span>a</div><div>&#160;</div><div>b</div>");
  });

  it("prints a box with no bullet paragraph exactly as before", () => {
    const html = slidesToPrintHtml({ slides: [{ elements: [{ ...box, text: "plain\ntext" }] }] }, "Deck");
    expect(html).not.toContain('class="p-bullet');
    expect(html).toContain(">plain\ntext</div>");
  });
});

describe("slidesToPrintHtml (default leading, U2)", () => {
  it("the print sheet's default leading is the estimator's", () => {
    // A box that names no `lineHeight` falls to the sheet's `.el` rule, which
    // must be the estimator's `DEFAULT_LINE_HEIGHT` (1.2) — not a print-only 1.25.
    const deck = { slides: [{ elements: [{ id: "t", type: "text" as const, x: 0, y: 0, w: 50, h: 10, text: "no lineHeight set" }] }] };
    const html = slidesToPrintHtml(deck, "Deck");
    expect(html).toMatch(/\.el \{[^}]*line-height: 1\.2;[^}]*\}/);
    expect(html).not.toContain("line-height: 1.25");
  });
});

describe("the browser Word table's widths (U6 / docx-final)", () => {
  // The Python door writes one width three ways — gridCol, tcW on every cell,
  // tblW — all summing to the section's text column (9360 twips on Letter with
  // 1 in margins). docx.js left gridCol at its 100-twip placeholder and no
  // tcW, so a viewer that lays out from the cells saw no widths at all. The
  // markdown table states no widths, so the grid is the equal split.
  it("writes gridCol, tcW and tblW that agree with the section column", async () => {
    const { Packer } = await import("docx");
    const { documentToDocxDocument } = await import("./exporters");
    const content = "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n";
    const document = await documentToDocxDocument({ format: "markdown", content });
    const xml = await zipEntryText(new Uint8Array(await Packer.toBuffer(document)), "word/document.xml");
    const table = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)?.[0] ?? "";
    const gridCols = Array.from(table.matchAll(/<w:gridCol w:w="(\d+)"\/>/g), (m) => Number(m[1]));
    expect(gridCols).toEqual([3120, 3120, 3120]);
    expect(gridCols.reduce((a, b) => a + b, 0)).toBe(9360);
    const tableWidth = table.match(/<w:tblW [^>]*\/>/)?.[0] ?? "";
    expect(tableWidth).toContain('w:type="pct"');
    expect(tableWidth).toMatch(/w:w="(100%|5000)"/);
    const cellWidths = Array.from(table.matchAll(/<w:tcW w:type="dxa" w:w="(\d+)"\/>/g), (m) => Number(m[1]));
    expect(cellWidths).toEqual([3120, 3120, 3120, 3120, 3120, 3120]);
  });

  it("gives the last column the remainder when the column does not split evenly", async () => {
    const { Packer } = await import("docx");
    const { documentToDocxDocument } = await import("./exporters");
    const content = "| a | b | c | d | e | f | g |\n|---|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 |\n";
    const document = await documentToDocxDocument({ format: "markdown", content });
    const xml = await zipEntryText(new Uint8Array(await Packer.toBuffer(document)), "word/document.xml");
    const gridCols = Array.from(xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g), (m) => Number(m[1]));
    expect(gridCols).toEqual([1337, 1337, 1337, 1337, 1337, 1337, 1338]);
  });
});

/** One stored/deflated entry of a zip (the .docx package) as text — a minimal
 *  central-directory walk on node:zlib, so the test needs no zip dependency. */
async function zipEntryText(bytes: Uint8Array, name: string): Promise<string> {
  const { inflateRawSync } = await import("node:zlib");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  let offset = view.getUint32(eocd + 16, true);
  const entries = view.getUint16(eocd + 10, true);
  for (let i = 0; i < entries; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const entryName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (entryName === name) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(start, start + compressedSize);
      return decoder.decode(method === 8 ? inflateRawSync(data) : data);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the package`);
}
