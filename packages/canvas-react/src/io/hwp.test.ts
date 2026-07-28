import { describe, expect, it } from "vitest";

import { hwpToText } from "./hwp";

/* ------------------------------------------------------------------------- *
 * Synthetic HWP fixture builder
 *
 * Real .hwp files can't live in the repo as fixtures without an opaque binary
 * blob, so the tests construct a minimal-but-valid CFB container from scratch:
 * one FAT sector, one directory sector, one mini-FAT sector, and a mini stream
 * holding both FileHeader (256 B — this is why mini-stream support is
 * mandatory) and BodyText/Section0. Every offset below mirrors [MS-CFB] and
 * the HWP 5.0 spec, so the builder doubles as a readable map of the format.
 * ------------------------------------------------------------------------- */

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** UTF-16LE code units of a JS string (surrogate halves pass through as-is). */
const utf16le = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) v.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
};

/** Raw WCHAR sequence — for control characters and their filler words. */
const wchar = (...codes: number[]): Uint8Array => {
  const out = new Uint8Array(codes.length * 2);
  const v = new DataView(out.buffer);
  codes.forEach((c, i) => v.setUint16(i * 2, c, true));
  return out;
};

/** HWP record: uint32 header (tag | level<<10 | size<<20), 0xFFF = size follows. */
const record = (tag: number, level: number, payload: Uint8Array): Uint8Array => {
  const big = payload.length >= 0xfff;
  const head = new Uint8Array(big ? 8 : 4);
  const v = new DataView(head.buffer);
  v.setUint32(0, (tag | (level << 10) | ((big ? 0xfff : payload.length) << 20)) >>> 0, true);
  if (big) v.setUint32(4, payload.length, true);
  return concat(head, payload);
};

const HWPTAG_PARA_HEADER = 0x10 + 50;
const HWPTAG_PARA_TEXT = 0x10 + 51;
const HWPTAG_CTRL_HEADER = 0x10 + 55;
const HWPTAG_LIST_HEADER = 0x10 + 56;
const HWPTAG_TABLE = 0x10 + 61;

/** "tbl " packed as MAKE_4CHID('t','b','l',' ') — read back as a LE uint32. */
const CTRL_ID_TABLE = 0x74626c20;

/** One paragraph: text WCHARs + the 0x0D paragraph terminator. */
const paraText = (level: number, ...parts: Uint8Array[]) =>
  record(HWPTAG_PARA_TEXT, level, concat(...parts, wchar(13)));

/** Control header: uint32 LE ctrl id, then (here, dummy) control attributes. */
const ctrlHeader = (level: number, ctrlId: number) => {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setUint32(0, ctrlId, true);
  return record(HWPTAG_CTRL_HEADER, level, payload);
};

/** Table body record: 4-byte attr, uint16 nRows, uint16 nCols, trailing fields. */
const tableRecord = (level: number, nRows: number, nCols: number) => {
  const payload = new Uint8Array(12);
  const v = new DataView(payload.buffer);
  v.setUint16(4, nRows, true);
  v.setUint16(6, nCols, true);
  return record(HWPTAG_TABLE, level, payload);
};

/** Cell list header — payload contents are irrelevant to the extractor. */
const listHeader = (level: number) => record(HWPTAG_LIST_HEADER, level, new Uint8Array(6));

/** 128-byte CFB directory entry. */
const dirEntry = (name: string, type: number, start: number, size: number, child = FREESECT): Uint8Array => {
  const e = new Uint8Array(128);
  const v = new DataView(e.buffer);
  e.set(utf16le(name), 0);
  v.setUint16(64, (name.length + 1) * 2, true); // name length in bytes, incl. NUL
  v.setUint8(66, type); // 1 = storage, 2 = stream, 5 = root
  v.setUint8(67, 1); // colour flag (black) — irrelevant to parsing, but valid
  v.setUint32(68, FREESECT, true); // left sibling
  v.setUint32(72, FREESECT, true); // right sibling
  v.setUint32(76, child, true);
  v.setUint32(116, start, true);
  v.setUint32(120, size, true);
  return e;
};

interface FixtureOptions {
  flags?: number; // bit0 compressed, bit1 encrypted, bit2 distribution/DRM
  version?: number; // 0xMMnnPPrr
  signature?: string; // override to build a CFB that is not an HWP
}

/** Assemble the full container around one BodyText/Section0 byte stream. */
function buildHwp(section: Uint8Array, { flags = 0, version = 0x05000300, signature = "HWP Document File" }: FixtureOptions = {}): ArrayBuffer {
  // FileHeader stream: 32-byte signature, uint32 version, uint32 flags.
  const fileHeader = new Uint8Array(256);
  for (let i = 0; i < signature.length && i < 32; i++) fileHeader[i] = signature.charCodeAt(i);
  const fh = new DataView(fileHeader.buffer);
  fh.setUint32(32, version, true);
  fh.setUint32(36, flags, true);

  // Mini stream layout: FileHeader at mini sector 0 (4 × 64 B), Section0 next.
  const pad64 = (u: Uint8Array) => concat(u, new Uint8Array((64 - (u.length % 64)) % 64));
  const mini = concat(pad64(fileHeader), pad64(section));
  const sectionMiniStart = 4;
  const sectionMiniCount = Math.ceil(section.length / 64);

  // Regular sectors: 0 = FAT, 1 = directory, 2 = mini FAT, 3… = mini stream.
  const miniStreamSectors = Math.ceil(mini.length / 512);
  const file = new Uint8Array(512 * (1 + 3 + miniStreamSectors));
  const v = new DataView(file.buffer);

  // --- CFB header.
  file.set(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 0);
  v.setUint16(24, 0x003e, true); // minor version
  v.setUint16(26, 0x0003, true); // major version (512-byte sectors)
  v.setUint16(28, 0xfffe, true); // little-endian marker
  v.setUint16(30, 9, true); // sector shift → 512
  v.setUint16(32, 6, true); // mini sector shift → 64
  v.setUint32(44, 1, true); // FAT sector count
  v.setUint32(48, 1, true); // first directory sector
  v.setUint32(56, 4096, true); // mini stream cutoff
  v.setUint32(60, 2, true); // first mini FAT sector
  v.setUint32(64, 1, true); // mini FAT sector count
  v.setUint32(68, ENDOFCHAIN, true); // no extra DIFAT sectors
  v.setUint32(72, 0, true);
  v.setUint32(76, 0, true); // DIFAT[0] → FAT lives in sector 0
  for (let i = 1; i < 109; i++) v.setUint32(76 + i * 4, FREESECT, true);

  // --- FAT (sector 0).
  const fatAt = 512;
  for (let i = 0; i < 128; i++) v.setUint32(fatAt + i * 4, FREESECT, true);
  v.setUint32(fatAt + 0 * 4, FATSECT, true);
  v.setUint32(fatAt + 1 * 4, ENDOFCHAIN, true); // directory
  v.setUint32(fatAt + 2 * 4, ENDOFCHAIN, true); // mini FAT
  for (let i = 0; i < miniStreamSectors; i++) {
    v.setUint32(fatAt + (3 + i) * 4, i === miniStreamSectors - 1 ? ENDOFCHAIN : 3 + i + 1, true);
  }

  // --- Directory (sector 1): Root, FileHeader, BodyText storage, Section0.
  file.set(
    concat(
      dirEntry("Root Entry", 5, 3, mini.length, 1),
      dirEntry("FileHeader", 2, 0, 256),
      dirEntry("BodyText", 1, 0, 0, 3),
      dirEntry("Section0", 2, sectionMiniStart, section.length),
    ),
    512 * 2,
  );

  // --- Mini FAT (sector 2): FileHeader chain 0→1→2→3, then Section0's chain.
  const mfAt = 512 * 3;
  for (let i = 0; i < 128; i++) v.setUint32(mfAt + i * 4, FREESECT, true);
  for (let i = 0; i < 4; i++) v.setUint32(mfAt + i * 4, i === 3 ? ENDOFCHAIN : i + 1, true);
  for (let i = 0; i < sectionMiniCount; i++) {
    const s = sectionMiniStart + i;
    v.setUint32(mfAt + s * 4, i === sectionMiniCount - 1 ? ENDOFCHAIN : s + 1, true);
  }

  // --- Mini stream body (sectors 3…).
  file.set(mini, 512 * 4);
  return file.buffer;
}

/** deflate-raw (windowBits −15) — mirrors what Hangul does per section stream. */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // Cast: lib.dom's BufferSource wants Uint8Array<ArrayBuffer>, ours is wider.
  const writing = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close());
  writing.catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concat(...chunks);
}

/* ------------------------------------------------------------------------- *
 * Tests
 * ------------------------------------------------------------------------- */

describe("hwpToText", () => {
  it("extracts paragraphs (incl. Korean and surrogate pairs) from an uncompressed file", async () => {
    const section = concat(
      // A non-text record first — the extractor must skip records it doesn't know.
      record(HWPTAG_PARA_HEADER, 0, new Uint8Array(22)),
      paraText(0, utf16le("Hello, HWP 😀")),
      // Level 1 (e.g. inside a table): flat extraction still keeps the text.
      paraText(1, utf16le("안녕하세요 한글 문서")),
      // Empty paragraph — must not produce stray blank paragraphs in the join.
      paraText(0),
    );
    const text = await hwpToText(buildHwp(section));
    expect(text).toBe("Hello, HWP 😀\n\n안녕하세요 한글 문서");
  });

  it("skips 8-WCHAR inline/extended controls, keeping tab and line break", async () => {
    const filler = [0x2020, 0x2020, 0x2020, 0x2020, 0x2020, 0x2020, 0x2020]; // † if leaked
    const section = paraText(
      0,
      wchar(9, ...filler), // tab: 8-WCHAR control whose text form is "\t"
      utf16le("A"),
      wchar(1, ...filler), // extended control (e.g. shape anchor): no text form
      utf16le("B"),
      wchar(10), // in-paragraph line break
      utf16le("C"),
    );
    const text = await hwpToText(buildHwp(section));
    expect(text).toBe("\tAB\nC");
    expect(text).not.toContain("†"); // control payload must never leak
  });

  it("round-trips a deflate-raw compressed section, incl. the 0xFFF extended-size record", async () => {
    const long = "가".repeat(2100); // 4200 B payload → forces the extra-uint32 size path
    const section = concat(paraText(0, utf16le(long)), paraText(0, utf16le("압축 확인")));
    const compressed = await deflateRaw(section);
    expect(compressed.length).toBeLessThan(4096); // must still fit the mini stream
    const text = await hwpToText(buildHwp(compressed, { flags: 0b1 }));
    expect(text).toBe(`${long}\n\n압축 확인`);
  });

  it("renders a table control as a GFM table between surrounding paragraphs", async () => {
    const section = concat(
      paraText(0, utf16le("표 앞 문단")),
      // Table control: CTRL_HEADER("tbl ") → TABLE(2×2) → 4 cells, row-major,
      // each a LIST_HEADER one level below the control plus its paragraphs.
      ctrlHeader(1, CTRL_ID_TABLE),
      tableRecord(2, 2, 2),
      listHeader(2), paraText(3, utf16le("구분")),
      listHeader(2), paraText(3, utf16le("내용 | 비고")),
      listHeader(2), paraText(3, utf16le("기간")),
      listHeader(2), paraText(3, utf16le("2026-07")),
      paraText(0, utf16le("표 뒤 문단")),
    );
    const text = await hwpToText(buildHwp(section));
    // Exact equality also proves the cell texts are not duplicated as flat
    // paragraphs, and that pipes inside cells are escaped.
    expect(text).toBe(
      [
        "표 앞 문단",
        "| 구분 | 내용 \\| 비고 |\n| --- | --- |\n| 기간 | 2026-07 |",
        "표 뒤 문단",
      ].join("\n\n"),
    );
  });

  it("falls back to plain paragraphs when the cell count contradicts the table record", async () => {
    const section = concat(
      ctrlHeader(1, CTRL_ID_TABLE),
      tableRecord(2, 3, 2), // claims 6 cells…
      listHeader(2), paraText(3, utf16le("하나")),
      listHeader(2), paraText(3, utf16le("둘")),
      listHeader(2), paraText(3, utf16le("셋")),
      listHeader(2), paraText(3, utf16le("넷")), // …but only 4 exist
      paraText(0, utf16le("본문 계속")),
    );
    const text = await hwpToText(buildHwp(section));
    // Malformed structure must never throw or drop text — every cell paragraph
    // survives as plain text, and no half-built table row is emitted.
    expect(text).toBe("하나\n\n둘\n\n셋\n\n넷\n\n본문 계속");
    expect(text).not.toContain("|");
  });

  it("throws a bilingual error for password-encrypted files", async () => {
    const fixture = buildHwp(paraText(0, utf16le("x")), { flags: 0b10 });
    await expect(hwpToText(fixture)).rejects.toThrow(/암호.*password-encrypted/is);
  });

  it("throws a bilingual error for distribution (DRM) files", async () => {
    const fixture = buildHwp(paraText(0, utf16le("x")), { flags: 0b100 });
    await expect(hwpToText(fixture)).rejects.toThrow(/배포용.*DRM/is);
  });

  it("throws for pre-5.0 documents", async () => {
    const fixture = buildHwp(paraText(0, utf16le("x")), { version: 0x04010000 });
    await expect(hwpToText(fixture)).rejects.toThrow(/버전.*4\.1 < 5\.0/is);
  });

  it("throws a 'not a HWP' style error for non-CFB garbage", async () => {
    const garbage = new Uint8Array(1024).map((_, i) => (i * 37 + 11) & 0xff);
    await expect(hwpToText(garbage.buffer)).rejects.toThrow(/HWP 파일이 아닙니다.*not a valid HWP/is);
    // Too short to even hold a CFB header.
    await expect(hwpToText(new TextEncoder().encode("hello").buffer as ArrayBuffer)).rejects.toThrow(/not a valid HWP/i);
  });

  it("throws when the container is CFB but the HWP signature is wrong", async () => {
    const fixture = buildHwp(paraText(0, utf16le("x")), { signature: "NOT A HWP FILE!!" });
    await expect(hwpToText(fixture)).rejects.toThrow(/HWP 문서가 아닙니다.*not an HWP document/is);
  });
});
