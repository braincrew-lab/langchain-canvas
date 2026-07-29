/**
 * HWPX export tests. The strongest check available without 한글 itself is the
 * round trip: bytes from `documentToHwpx` must parse back through the import
 * side (`readZip` + `hwpxToMarkdown` from `hwpx.ts`), which exercises the ZIP
 * container byte layout and the OWPML body against an independent reader.
 */

import { describe, expect, it } from "vitest";

import { hwpxToMarkdown, readZip } from "./hwpx";
import { crc32, documentToHwpx } from "./hwpxWrite";

const enc = new TextEncoder();

const doc = (content: string) => ({ format: "markdown" as const, content });

/** The written buffer, as the ArrayBuffer view the reader expects. */
async function build(content: string): Promise<ArrayBuffer> {
  const bytes = await documentToHwpx(doc(content));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    // The canonical CRC-32 test vector.
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  it("hashes the empty input to zero", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("documentToHwpx container", () => {
  it("puts the stored mimetype first", async () => {
    const bytes = await documentToHwpx(doc("안녕하세요"));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // First local header sits at offset 0: stored (method 0), named "mimetype",
    // with the body immediately after a 30-byte header + 8-byte name.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // method 0 = stored
    const nameLen = view.getUint16(26, true);
    const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLen));
    expect(name).toBe("mimetype");
    const body = new TextDecoder().decode(bytes.subarray(30 + nameLen, 30 + nameLen + 19));
    expect(body).toBe("application/hwp+zip");
  });

  it("writes real CRCs the central directory agrees on", async () => {
    const bytes = await documentToHwpx(doc("CRC 확인"));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // mimetype's local-header CRC must equal CRC32("application/hwp+zip").
    expect(view.getUint32(14, true)).toBe(crc32(enc.encode("application/hwp+zip")));
  });

  it("emits the full OWPML package skeleton", async () => {
    const entries = await readZip(await build("본문"));
    for (const name of [
      "mimetype",
      "version.xml",
      "META-INF/manifest.xml",
      "META-INF/container.xml",
      "Contents/content.hpf",
      "Contents/header.xml",
      "Contents/section0.xml",
      "settings.xml",
    ]) {
      expect(entries.has(name), name).toBe(true);
    }
    const container = new TextDecoder().decode(entries.get("META-INF/container.xml"));
    expect(container).toContain('full-path="Contents/content.hpf"');
    const hpf = new TextDecoder().decode(entries.get("Contents/content.hpf"));
    expect(hpf).toContain('href="Contents/section0.xml"');
  });

  it("emits well-formed XML in every part", async () => {
    // The round trip only parses section0.xml — run the rest through DOMParser
    // too, so a malformed header/manifest can't slip out unnoticed.
    const entries = await readZip(await build("# 제목\n\n**본문** & <검증>"));
    const dec = new TextDecoder();
    for (const name of [...entries.keys()].filter((n) => n !== "mimetype")) {
      const doc = new DOMParser().parseFromString(dec.decode(entries.get(name)), "application/xml");
      expect(doc.querySelector("parsererror"), name).toBeNull();
    }
    // Reference-table invariants the body depends on: borderFills 1 and 2.
    const header = dec.decode(entries.get("Contents/header.xml"));
    expect(header).toContain('<hh:borderFill id="1"');
    expect(header).toContain('<hh:borderFill id="2"');
  });
});

describe("documentToHwpx round trip", () => {
  it("keeps paragraphs and headings as text", async () => {
    const md = await hwpxToMarkdown(
      await build("# 프로젝트 개요\n\n신한은행 수행 과업 정리입니다.\n\n## 일정\n\n7월 중 착수합니다."),
    );
    expect(md).toContain("프로젝트 개요");
    expect(md).toContain("신한은행 수행 과업 정리입니다.");
    expect(md).toContain("일정");
    expect(md).toContain("7월 중 착수합니다.");
  });

  it("prefixes list items and keeps emphasis text", async () => {
    const md = await hwpxToMarkdown(await build("- 첫 항목\n- **굵은** 항목\n1. 순번 *기울임* 항목"));
    expect(md).toContain("• 첫 항목");
    expect(md).toContain("• 굵은 항목"); // markers shed, text preserved
    expect(md).toContain("1. 순번 기울임 항목");
  });

  it("degrades tables to pipe-joined rows", async () => {
    const md = await hwpxToMarkdown(await build("| 구분 | 내용 |\n| --- | --- |\n| 기간 | 7월 |"));
    expect(md).toContain("구분 | 내용");
    expect(md).toContain("기간 | 7월");
    expect(md).not.toContain("---"); // ruler row is dropped
  });

  it("escapes XML metacharacters in text", async () => {
    const md = await hwpxToMarkdown(await build("A < B & C > D"));
    expect(md).toContain("A < B & C > D");
  });

  it("survives an empty document", async () => {
    const md = await hwpxToMarkdown(await build(""));
    expect(md).toBe("");
  });
});
