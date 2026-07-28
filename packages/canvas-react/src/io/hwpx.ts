/**
 * `.hwpx` (Hancom HWPX / OWPML) → markdown import, dependency-free.
 *
 * An HWPX file is a ZIP of XML parts (the OOXML model): the document body lives
 * in `Contents/section*.xml` as OWPML — `<hp:p>` paragraphs of `<hp:run>`s whose
 * `<hp:t>` nodes carry the text, with `<hp:tbl>` tables nested inside runs.
 *
 * Everything here is built on platform primitives so the import costs zero
 * bundle bytes: the ZIP is parsed by hand (central directory + local headers)
 * with `DecompressionStream("deflate-raw")` inflating compressed entries, and
 * the XML goes through `DOMParser`. Namespace prefixes are matched by
 * `localName`, so files that bind `hp:` differently still parse.
 */

// --- minimal ZIP reader --------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Inflate raw-deflate bytes via the platform's DecompressionStream. The stream
 *  is pumped by hand (no Blob/Response round-trip) so it works in every runtime
 *  that has the streams API — browsers, Node, and jsdom-based tests alike. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("이 브라우저는 압축 해제를 지원하지 않습니다 (DecompressionStream unavailable).");
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  // Don't await the write before draining the readable — on large inputs the
  // internal queue fills and write() only resolves once the output is consumed.
  const wrote = writer.write(bytes as unknown as BufferSource).then(() => writer.close());
  const reader = ds.readable.getReader();
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

/**
 * Read a ZIP's entries into a name → bytes map. Supports stored and deflated
 * entries — the only methods HWPX (and every mainstream zipper) emits. Zip64 is
 * out of scope for document files and rejected explicitly.
 */
export async function readZip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // The end-of-central-directory record sits at the tail, before an optional
  // comment (≤ 64 KiB) — scan backwards for its signature.
  let eocd = -1;
  const floor = Math.max(0, buffer.byteLength - 22 - 0xffff);
  for (let i = buffer.byteLength - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("ZIP 형식이 아닙니다 (no end-of-central-directory).");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== CDIR_SIG) {
      throw new Error("ZIP 중앙 디렉터리가 손상되었습니다 (corrupt central directory).");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("Zip64 형식은 지원하지 않습니다 (Zip64 not supported).");
    }
    if (name.endsWith("/")) continue; // directory entry

    // Data offset comes from the LOCAL header's own name/extra lengths — they
    // can differ from the central directory's copy.
    if (localOffset + 30 > buffer.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error("ZIP 로컬 헤더가 손상되었습니다 (corrupt local header).");
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(start, start + compressedSize);

    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, await inflateRaw(data));
    else throw new Error(`지원하지 않는 압축 방식입니다 (compression method ${method}).`);
  }
  return entries;
}

// --- OWPML → markdown ----------------------------------------------------------

/** Text of a paragraph: its `<hp:t>` descendants, skipping any nested table
 *  (tables are emitted separately, after the paragraph's own text). */
function paragraphText(p: Element): string {
  let out = "";
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.localName;
      if (tag === "tbl") continue; // nested table — rendered by the caller
      if (tag === "t") out += child.textContent ?? "";
      else if (tag === "lineBreak") out += "\n";
      else walk(child);
    }
  };
  walk(p);
  return out;
}

/** Render an OWPML `<hp:tbl>` as a GFM table (first row as header). Cell text
 *  flattens its paragraphs; pipes are escaped so they can't break the row. */
function tableToMarkdown(tbl: Element): string {
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.getElementsByTagNameNS("*", "tr"))) {
    if (tr.closest("tbl") !== tbl) continue; // belongs to a nested table
    const cells: string[] = [];
    for (const tc of Array.from(tr.children)) {
      if (tc.localName !== "tc") continue;
      const text = Array.from(tc.getElementsByTagNameNS("*", "p"))
        .map((p) => paragraphText(p as Element).trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/** One section document → markdown blocks, in document order. */
function sectionToMarkdown(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("HWPX 본문 XML을 해석할 수 없습니다 (invalid section XML).");
  }
  const blocks: string[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.localName;
      if (tag === "p") {
        const text = paragraphText(child).trim();
        if (text) blocks.push(text);
        // Tables nested in this paragraph's runs follow its text.
        for (const tbl of Array.from(child.getElementsByTagNameNS("*", "tbl"))) {
          if ((tbl.parentElement?.closest("tbl") ?? null) === null) {
            const md = tableToMarkdown(tbl as Element);
            if (md) blocks.push(md);
          }
        }
      } else if (tag !== "tbl") {
        walk(child);
      }
    }
  };
  walk(doc.documentElement);
  return blocks;
}

/** Convert a `.hwpx` buffer to markdown (paragraphs + tables, all sections). */
export async function hwpxToMarkdown(buffer: ArrayBuffer): Promise<string> {
  const entries = await readZip(buffer);

  // Body parts: Contents/section0.xml, section1.xml, … in numeric order.
  const sections = [...entries.keys()]
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
  if (!sections.length) {
    throw new Error("HWPX 문서가 아닙니다 — 본문(section XML)이 없습니다 (no Contents/section*.xml).");
  }

  const decoder = new TextDecoder();
  const blocks: string[] = [];
  for (const name of sections) {
    blocks.push(...sectionToMarkdown(decoder.decode(entries.get(name)!)));
  }
  return blocks.join("\n\n").trim();
}
