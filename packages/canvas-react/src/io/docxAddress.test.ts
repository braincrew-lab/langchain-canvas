/**
 * The address parity test — the load-bearing one for the Word preview.
 *
 * The document tools number body paragraphs by position, blanks counted. If
 * the preview numbers them any other way, a person points at one sentence and
 * the agent edits another, and nothing on screen says so. So this builds a
 * document whose block sequence is written out in full, renders it through the
 * real renderer, and compares **every** block — not a sample.
 *
 * A renderer that starts dropping empty paragraphs, wrapping blocks in a
 * container, or splitting one paragraph across page areas breaks this test,
 * which is the point: those are exactly the changes that would misalign the
 * numbering silently.
 */

import { describe, expect, it } from "vitest";
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import {
  DOCX_ADDRESS_ATTRIBUTE,
  countWords,
  declaredFontFamilies,
  docxStats,
  fitToWidth,
  pickFromNode,
  pickFromSelection,
  stampDocxAddresses,
  substitutedFonts,
} from "./docxAddress";

/** A 2x2 PNG, so the fixture carries a real picture without a fixture file. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z4AATAxIYBRzAgCL3AH917PhzgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** The block sequence the file is built from — and the answer key.
 *
 * Table text is the whole table's, since that is what the addressed node
 * holds; whitespace is squashed away before comparing, so the shape of the
 * markup around the words never decides the result. */
const EXPECTED: { kind: "paragraph" | "table"; text: string }[] = [
  { kind: "paragraph", text: "2026 반영계획안" },
  { kind: "paragraph", text: "" },
  { kind: "paragraph", text: "본 문서는 현장 점검 결과를 정리한 자료입니다." },
  { kind: "paragraph", text: "1. 배경 Background" },
  { kind: "paragraph", text: "검토 결과, 즉시 조치가 필요한 항목이 확인되었습니다." },
  { kind: "paragraph", text: "1.1 세부 항목 detail item 1" },
  { kind: "paragraph", text: "1.2 세부 항목 detail item 2" },
  { kind: "paragraph", text: "" },
  { kind: "table", text: "구분 항목 비고 안전 소화기 재배치 9월 1주" },
  { kind: "paragraph", text: "" },
  { kind: "paragraph", text: "2. 현장 사진 Photographs" },
  { kind: "paragraph", text: "" },
  { kind: "paragraph", text: "사진 1. 점검 당일 현장" },
  { kind: "table", text: "9월 조치 계획 1주 소화기 진행" },
  { kind: "paragraph", text: "" },
  { kind: "paragraph", text: "본 자료는 정보 제공 목적으로만 작성되었습니다." },
];

function row(cells: string[]): TableRow {
  return new TableRow({
    children: cells.map((text) => new TableCell({ children: [new Paragraph(text)] })),
  });
}

async function buildDocument(): Promise<Uint8Array> {
  const document = new Document({
    sections: [
      {
        headers: { default: new Header({ children: [new Paragraph("브레인크루 | Confidential")] }) },
        footers: { default: new Footer({ children: [new Paragraph("대외비")] }) },
        children: [
          new Paragraph({ text: "2026 반영계획안", heading: HeadingLevel.HEADING_1 }),
          new Paragraph(""),
          new Paragraph("본 문서는 현장 점검 결과를 정리한 자료입니다."),
          new Paragraph({ text: "1. 배경 Background", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({
            children: [
              new TextRun("검토 결과, "),
              new TextRun({ text: "즉시 조치", bold: true }),
              new TextRun("가 필요한 항목이 확인되었습니다."),
            ],
          }),
          new Paragraph({ text: "1.1 세부 항목 detail item 1", bullet: { level: 0 } }),
          new Paragraph({ text: "1.2 세부 항목 detail item 2", bullet: { level: 0 } }),
          new Paragraph(""),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              row(["구분", "항목", "비고"]),
              row(["안전", "소화기 재배치", "9월 1주"]),
            ],
          }),
          new Paragraph(""),
          new Paragraph({ text: "2. 현장 사진 Photographs", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({ type: "png", data: PNG, transformation: { width: 80, height: 40 } }),
            ],
          }),
          new Paragraph("사진 1. 점검 당일 현장"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("9월 조치 계획")], columnSpan: 3 }),
                ],
              }),
              row(["1주", "소화기", "진행"]),
            ],
          }),
          new Paragraph(""),
          new Paragraph("본 자료는 정보 제공 목적으로만 작성되었습니다."),
        ],
      },
    ],
  });
  // toBuffer, not toBlob: jsdom's Blob has no arrayBuffer().
  return new Uint8Array(await Packer.toBuffer(document));
}

async function render(): Promise<HTMLElement> {
  // jsdom has no object URLs; the renderer only needs one for pictures.
  URL.createObjectURL ??= () => "blob:test";
  const { renderAsync } = await import("docx-preview");
  const host = document.createElement("div");
  document.body.appendChild(host);
  await renderAsync(await buildDocument(), host, undefined, {
    inWrapper: true,
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    useBase64URL: true,
  });
  return host;
}

const squash = (text: string | null) => (text ?? "").replace(/\s+/g, "").trim();

describe("docx address parity", () => {
  it("numbers every body block the way the document tools number it", async () => {
    const host = await render();
    const blocks = stampDocxAddresses(host);

    expect(blocks.map((b) => b.kind)).toEqual(EXPECTED.map((b) => b.kind));
    blocks.forEach((block, position) => {
      expect(squash(block.element.textContent)).toBe(squash(EXPECTED[position].text));
    });

    // The addresses themselves: each counter runs independently from zero.
    expect(blocks.filter((b) => b.kind === "paragraph").map((b) => b.address)).toEqual([
      "p0", "p1", "p2", "p3", "p4", "p5", "p6",
      "p7", "p8", "p9", "p10", "p11", "p12", "p13",
    ]);
    expect(blocks.filter((b) => b.kind === "table").map((b) => b.address)).toEqual(["t0", "t1"]);
  });

  it("keeps blank paragraphs in the numbering", async () => {
    const blocks = stampDocxAddresses(await render());
    const blanks = blocks.filter((b) => b.kind === "paragraph" && squash(b.element.textContent) === "");
    expect(blanks.map((b) => b.address)).toEqual(["p1", "p7", "p8", "p10", "p12"]);
  });

  it("leaves headers and footers unaddressed", async () => {
    const host = await render();
    stampDocxAddresses(host);
    for (const story of Array.from(host.querySelectorAll("header, footer"))) {
      expect(story.querySelector(`[${DOCX_ADDRESS_ATTRIBUTE}]`)).toBeNull();
    }
  });

  it("writes the address onto the node a click will land on", async () => {
    const host = await render();
    stampDocxAddresses(host);
    const target = host.querySelector(`[${DOCX_ADDRESS_ATTRIBUTE}="p2"]`)!;
    const pick = pickFromNode(host, target.firstChild ?? target);
    expect(pick).toMatchObject({ address: "p2", kind: "paragraph", label: "[p2]" });
    expect(pick!.text).toContain("본 문서는");
  });

  it("resolves a table click to the table, not the cell paragraph", async () => {
    const host = await render();
    stampDocxAddresses(host);
    const cell = host.querySelector(`[${DOCX_ADDRESS_ATTRIBUTE}="t0"] td`)!;
    expect(pickFromNode(host, cell)).toMatchObject({ address: "t0", kind: "table" });
  });

  it("returns nothing for a click outside the addressed body", async () => {
    const host = await render();
    stampDocxAddresses(host);
    expect(pickFromNode(host, host)).toBeNull();
    const header = host.querySelector("header");
    expect(header && pickFromNode(host, header)).toBeNull();
  });

  it("carries the selected words as the anchor when the user drags", async () => {
    const host = await render();
    stampDocxAddresses(host);
    const paragraph = host.querySelector(`[${DOCX_ADDRESS_ATTRIBUTE}="p4"]`)!;
    const text = paragraph.querySelector("span")?.firstChild ?? paragraph.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const pick = pickFromSelection(host, selection);
    expect(pick?.address).toBe("p4");
    expect(pick?.literal).toBe("검토 결과,");
    expect(pick?.label).toBe("“검토 결과,”");
  });

  it("says nothing about pages it did not compute", async () => {
    const stats = docxStats(await render());
    expect(stats.paginates).toBe(false);
    expect(stats.pagesDrawn).toBeGreaterThanOrEqual(1);
    expect(stats.words).toBeGreaterThan(20);
  });
});

describe("word counting", () => {
  it("counts a run of Latin letters as one word", () => {
    expect(countWords("Hello canvas, hello again")).toBe(4);
  });

  it("counts each CJK character, the way word processors do", () => {
    expect(countWords("반영계획안")).toBe(5);
    expect(countWords("현장 점검 report")).toBe(5);
  });

  it("counts nothing in an empty paragraph", () => {
    expect(countWords("   \n  ")).toBe(0);
  });
});


describe("fonts the page asks for", () => {
  it("reads a family out of the rendered page's stylesheet, not only inline styles", async () => {
    const host = await render();
    // The renderer keeps the document's fonts in the <style> it injects, and
    // puts none on the elements — a scan of element.style would find nothing
    // on any document at all.
    expect(host.querySelector("style")).not.toBeNull();
    expect(declaredFontFamilies(host)).not.toContain("Batang");
    const sheet = document.createElement("style");
    sheet.textContent = "section.docx { font-family: 'Batang', serif }";
    host.appendChild(sheet);
    expect(declaredFontFamilies(host)).toContain("Batang");
  });

  it("ignores css variables and the generic families", () => {
    const host = document.createElement("div");
    host.innerHTML =
      "<style>.a{font-family:var(--docx-minorHAnsi-font)}" +
      ".b{font-family:'Malgun Gothic', sans-serif}" +
      ".c{font-family:monospace}</style>";
    expect(declaredFontFamilies(host)).toEqual(["Malgun Gothic"]);
  });

  it("claims no substitution where nothing can be measured", () => {
    const host = document.createElement("div");
    host.innerHTML = "<style>.a{font-family:'Nowhere Sans'}</style>";
    // jsdom has no 2D canvas: an honest empty answer beats a guessed one.
    expect(substitutedFonts(host)).toEqual([]);
  });
});

describe("fitting the page to the panel", () => {
  it("leaves a document it cannot measure alone", () => {
    const host = document.createElement("div");
    expect(fitToWidth(host, 400)).toBe(1);
  });

  it("never enlarges a page that already fits", async () => {
    const host = await render();
    // jsdom reports every box as zero-sized, so this only pins the guard:
    // no width to fit against must mean no scaling, never a division blow-up.
    expect(fitToWidth(host, 0)).toBe(1);
    expect(host.querySelector<HTMLElement>(".docx-wrapper")?.style.zoom ?? "").toBe("");
  });
});
