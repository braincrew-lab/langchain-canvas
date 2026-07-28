/**
 * HWPX import tests. The fixtures are ZIPs assembled byte-by-byte in the test
 * (local headers + central directory + EOCD), so the reader is exercised against
 * the real container format without a binary fixture checked into the repo.
 */

import { describe, expect, it } from "vitest";

import { hwpxToMarkdown, readZip } from "./hwpx";

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

/** Compress with deflate-raw, pumping by hand (jsdom's Blob has no .stream()). */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  const wrote = writer.write(data as unknown as BufferSource).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await wrote;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

const SECTION = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p><hp:run><hp:t>프로젝트 개요</hp:t></hp:run></hp:p>
  <hp:p><hp:run><hp:t>신한은행 </hp:t></hp:run><hp:run><hp:t>수행 과업</hp:t></hp:run></hp:p>
  <hp:p>
    <hp:run>
      <hp:tbl>
        <hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>구분</hp:t></hp:run></hp:p></hp:subList></hp:tc><hp:tc><hp:subList><hp:p><hp:run><hp:t>내용</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr>
        <hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>기간</hp:t></hp:run></hp:p></hp:subList></hp:tc><hp:tc><hp:subList><hp:p><hp:run><hp:t>2026-07 | 이후</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr>
      </hp:tbl>
    </hp:run>
  </hp:p>
</hs:sec>`;

describe("readZip", () => {
  it("reads stored entries", async () => {
    const zip = makeZip([{ name: "a.txt", data: enc.encode("hello"), method: 0 }]);
    const entries = await readZip(zip);
    expect(new TextDecoder().decode(entries.get("a.txt"))).toBe("hello");
  });

  it("reads deflated entries", async () => {
    const body = enc.encode("압축된 한글 본문입니다 — deflate round-trip.");
    const zip = makeZip([{ name: "b.txt", data: await deflateRaw(body), method: 8 }]);
    const entries = await readZip(zip);
    expect(new TextDecoder().decode(entries.get("b.txt"))).toBe("압축된 한글 본문입니다 — deflate round-trip.");
  });

  it("rejects non-ZIP data", async () => {
    await expect(readZip(enc.encode("not a zip at all").buffer as ArrayBuffer)).rejects.toThrow(/ZIP/);
  });
});

describe("hwpxToMarkdown", () => {
  it("extracts paragraphs and tables from section XML", async () => {
    const zip = makeZip([
      { name: "mimetype", data: enc.encode("application/hwp+zip"), method: 0 },
      { name: "Contents/section0.xml", data: enc.encode(SECTION), method: 0 },
    ]);
    const md = await hwpxToMarkdown(zip);
    // Adjacent runs join without injected whitespace.
    expect(md).toContain("프로젝트 개요");
    expect(md).toContain("신한은행 수행 과업");
    // Table becomes GFM, with pipes escaped inside cells.
    expect(md).toContain("| 구분 | 내용 |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 기간 | 2026-07 \\| 이후 |");
  });

  it("orders multiple sections numerically", async () => {
    const section = (text: string) =>
      enc.encode(`<hs:sec xmlns:hs="x" xmlns:hp="y"><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hs:sec>`);
    const zip = makeZip([
      { name: "Contents/section10.xml", data: section("열 번째"), method: 0 },
      { name: "Contents/section2.xml", data: section("두 번째"), method: 0 },
      { name: "Contents/section0.xml", data: section("첫 번째"), method: 0 },
    ]);
    const md = await hwpxToMarkdown(zip);
    expect(md.indexOf("첫 번째")).toBeLessThan(md.indexOf("두 번째"));
    expect(md.indexOf("두 번째")).toBeLessThan(md.indexOf("열 번째"));
  });

  it("rejects a ZIP with no section XML", async () => {
    const zip = makeZip([{ name: "mimetype", data: enc.encode("application/hwp+zip"), method: 0 }]);
    await expect(hwpxToMarkdown(zip)).rejects.toThrow(/section/i);
  });
});

/** Wrap OWPML body markup in a section root with the usual namespaces bound. */
const sectionXml = (body: string) =>
  enc.encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">${body}</hs:sec>`,
  );

/** A real 1×1 transparent PNG, inlined byte-by-byte. */
const PNG_1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const PNG_1PX_B64 = btoa(String.fromCharCode(...PNG_1PX));

describe("hwpxToMarkdown images", () => {
  it("inlines a picture as a data-URL image via the content.hpf manifest", async () => {
    // The manifest maps the ref id to a differently-named BinData entry, so
    // this passes only when the manifest (not the basename guess) resolves it.
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf/">
  <opf:manifest>
    <opf:item id="image1" href="BinData/pic7.png" media-type="image/png"/>
  </opf:manifest>
</opf:package>`;
    const zip = makeZip([
      { name: "mimetype", data: enc.encode("application/hwp+zip"), method: 0 },
      { name: "Contents/content.hpf", data: enc.encode(manifest), method: 0 },
      { name: "BinData/pic7.png", data: PNG_1PX, method: 0 },
      {
        name: "Contents/section0.xml",
        data: sectionXml(
          `<hp:p><hp:run><hp:t>그림 앞</hp:t><hp:pic><hc:img binaryItemIDRef="image1"/></hp:pic></hp:run></hp:p>`,
        ),
        method: 0,
      },
    ]);
    const md = await hwpxToMarkdown(zip);
    expect(md).toContain(`![](data:image/png;base64,${PNG_1PX_B64})`);
    // The image block follows the paragraph's own text.
    expect(md.indexOf("그림 앞")).toBeLessThan(md.indexOf("![]("));
  });

  it("resolves a picture directly against BinData without a manifest, and skips unresolvable refs silently", async () => {
    const zip = makeZip([
      { name: "BinData/photo.jpg", data: PNG_1PX, method: 0 },
      {
        name: "Contents/section0.xml",
        data: sectionXml(
          `<hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="photo"/></hp:pic><hp:pic><hc:img binaryItemIDRef="missing"/></hp:pic><hp:t>본문</hp:t></hp:run></hp:p>`,
        ),
        method: 0,
      },
    ]);
    const md = await hwpxToMarkdown(zip);
    // Mime comes from the entry's extension; the dangling ref emits nothing.
    expect(md).toContain(`![](data:image/jpeg;base64,${PNG_1PX_B64})`);
    expect(md.match(/!\[\]\(/g)).toHaveLength(1);
    expect(md).toContain("본문");
    expect(md).not.toContain("생략");
  });

  it("omits images past the base64 budget and appends a bilingual note", async () => {
    // ~7 MiB of raw bytes → ~9.3 M base64 chars, over the 8 M budget; the tiny
    // PNG after it still fits (the budget is spent per image, not slammed shut).
    const huge = new Uint8Array(7 * 1024 * 1024);
    const zip = makeZip([
      { name: "BinData/huge.jpg", data: huge, method: 0 },
      { name: "BinData/tiny.png", data: PNG_1PX, method: 0 },
      {
        name: "Contents/section0.xml",
        data: sectionXml(
          `<hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="huge"/></hp:pic><hp:pic><hc:img binaryItemIDRef="tiny"/></hp:pic></hp:run></hp:p>`,
        ),
        method: 0,
      },
    ]);
    const md = await hwpxToMarkdown(zip);
    expect(md).not.toContain("image/jpeg");
    expect(md).toContain(`![](data:image/png;base64,${PNG_1PX_B64})`);
    expect(md).toContain("> (이미지 1장 생략 / 1 images omitted)");
  });
});

describe("hwpxToMarkdown headings", () => {
  it("maps outline/heading style names from header.xml to markdown headings", async () => {
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head">
  <hh:refList>
    <hh:styles>
      <hh:style id="0" type="PARA" name="바탕글" paraPrIDRef="0"/>
      <hh:style id="2" type="PARA" name="개요 1" paraPrIDRef="20"/>
      <hh:style id="5" type="PARA" name="Heading 3" paraPrIDRef="23"/>
    </hh:styles>
  </hh:refList>
</hh:head>`;
    const zip = makeZip([
      { name: "Contents/header.xml", data: enc.encode(header), method: 0 },
      {
        name: "Contents/section0.xml",
        data: sectionXml(
          `<hp:p styleIDRef="2" paraPrIDRef="20"><hp:run><hp:t>프로젝트 개요</hp:t></hp:run></hp:p>` +
            `<hp:p styleIDRef="5"><hp:run><hp:t>세부 항목</hp:t></hp:run></hp:p>` +
            `<hp:p paraPrIDRef="20"><hp:run><hp:t>스타일 없는 개요</hp:t></hp:run></hp:p>` +
            `<hp:p styleIDRef="0" paraPrIDRef="0"><hp:run><hp:t>바탕글 본문</hp:t></hp:run></hp:p>` +
            `<hp:p><hp:run><hp:t>속성 없는 본문</hp:t></hp:run></hp:p>`,
        ),
        method: 0,
      },
    ]);
    const md = await hwpxToMarkdown(zip);
    expect(md).toContain("# 프로젝트 개요");
    expect(md).toContain("### 세부 항목");
    // No styleIDRef: the style's paraPrIDRef still identifies the outline level.
    expect(md).toContain("# 스타일 없는 개요");
    // Non-heading styles (and style-less paragraphs) stay plain.
    expect(md).toContain("\n\n바탕글 본문");
    expect(md).toContain("\n\n속성 없는 본문");
  });

  it("falls back to plain paragraphs when header.xml is absent", async () => {
    const zip = makeZip([
      {
        name: "Contents/section0.xml",
        data: sectionXml(`<hp:p styleIDRef="2"><hp:run><hp:t>제목일 수도 있는 문단</hp:t></hp:run></hp:p>`),
        method: 0,
      },
    ]);
    const md = await hwpxToMarkdown(zip);
    expect(md).toBe("제목일 수도 있는 문단");
  });
});
