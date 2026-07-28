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
