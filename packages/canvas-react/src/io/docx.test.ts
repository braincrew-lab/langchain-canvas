/**
 * DOCX import tests. The fixtures are ZIPs assembled byte-by-byte in the test
 * (local headers + central directory + EOCD) around hand-written
 * WordprocessingML, so no binary fixture is checked into the repo.
 */

import { describe, expect, it } from "vitest";

import { docxToMarkdown } from "./docx";

const enc = new TextEncoder();

type ZipEntry = { name: string; data: Uint8Array; method: 0 | 8 };

/** Assemble a minimal valid ZIP (CRCs zeroed — the reader doesn't verify them). */
function makeZip(entries: ZipEntry[]): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const { name, data, method } of entries) {
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size (unused by reader)
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cdir = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdir.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdir.set(nameBytes, 46);
    central.push(cdir);

    offset += local.length + data.length;
  }

  const cdirSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdirSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) { out.set(c, pos); pos += c.length; }
  return out.buffer;
}

/** Wrap WordprocessingML body content into a stored-entry docx ZIP. */
function makeDocx(bodyXml: string): ArrayBuffer {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`;
  return makeZip([
    { name: "[Content_Types].xml", data: enc.encode("<Types/>"), method: 0 },
    { name: "word/document.xml", data: enc.encode(xml), method: 0 },
  ]);
}

describe("docxToMarkdown", () => {
  it("extracts plain paragraphs, joining adjacent runs without injected whitespace", async () => {
    const md = await docxToMarkdown(makeDocx(`
      <w:p><w:r><w:t>프로젝트 개요</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">신한은행 </w:t></w:r><w:r><w:t>수행 과업</w:t></w:r></w:p>
    `));
    expect(md).toBe("프로젝트 개요\n\n신한은행 수행 과업");
  });

  it("maps Heading1/Heading2 style ids to # / ##", async () => {
    const heading = (style: string, text: string) =>
      `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const md = await docxToMarkdown(makeDocx(`
      ${heading("Heading1", "제목")}
      ${heading("Heading2", "소제목")}
      <w:p><w:r><w:t>본문</w:t></w:r></w:p>
    `));
    expect(md).toBe("# 제목\n\n## 소제목\n\n본문");
  });

  it("wraps bold/italic runs and merges adjacent same-format runs", async () => {
    // Word splits "굵은 텍스트" across two bold runs — the output must not
    // close and reopen ** mid-phrase.
    const md = await docxToMarkdown(makeDocx(`
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">굵은 </w:t></w:r>
        <w:r><w:rPr><w:b/></w:rPr><w:t>텍스트</w:t></w:r>
        <w:r><w:t xml:space="preserve"> and </w:t></w:r>
        <w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r>
        <w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t xml:space="preserve"> off</w:t></w:r>
      </w:p>
    `));
    expect(md).toBe("**굵은 텍스트** and *italic* off");
  });

  it("renders a table as GFM with the first row as header and pipes escaped", async () => {
    const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
    const md = await docxToMarkdown(makeDocx(`
      <w:tbl>
        <w:tr>${cell("구분")}${cell("내용")}</w:tr>
        <w:tr>${cell("기간")}${cell("2026-07 | 이후")}</w:tr>
      </w:tbl>
    `));
    expect(md).toBe("| 구분 | 내용 |\n| --- | --- |\n| 기간 | 2026-07 \\| 이후 |");
  });

  it("renders numbered paragraphs as one bullet list with ilvl nesting", async () => {
    const item = (level: number, text: string) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const md = await docxToMarkdown(makeDocx(`
      ${item(0, "첫 항목")}
      ${item(1, "하위 항목")}
      ${item(0, "second item")}
      <w:p><w:r><w:t>본문</w:t></w:r></w:p>
    `));
    expect(md).toBe("- 첫 항목\n  - 하위 항목\n- second item\n\n본문");
  });

  it("rejects a ZIP without word/document.xml", async () => {
    const zip = makeZip([{ name: "mimetype", data: enc.encode("application/zip"), method: 0 }]);
    await expect(docxToMarkdown(zip)).rejects.toThrow(/DOCX/);
  });
});
