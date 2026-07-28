/**
 * `.hwpx` (Hancom HWPX / OWPML) → markdown import, dependency-free.
 *
 * An HWPX file is a ZIP of XML parts (the OOXML model): the document body lives
 * in `Contents/section*.xml` as OWPML — `<hp:p>` paragraphs of `<hp:run>`s whose
 * `<hp:t>` nodes carry the text, with `<hp:tbl>` tables and `<hp:pic>` pictures
 * nested inside runs. Pictures reference `BinData/*` ZIP entries (via the
 * `Contents/content.hpf` manifest) and are inlined as data-URL images; heading
 * paragraphs are recognized by their style name in `Contents/header.xml`.
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

// --- shared XML helper ---------------------------------------------------------

/** Parse an XML part, returning null (instead of throwing) when it's invalid —
 *  auxiliary parts like the manifest degrade gracefully to "no data". */
function parseXml(xml: string): Document | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return doc.querySelector("parsererror") ? null : doc;
}

// --- binary items (embedded images) --------------------------------------------

/** Cap on the total base64 characters emitted for images — scanned originals
 *  can be tens of MB and would balloon the markdown; images past the budget
 *  are skipped and counted so the document can note the omission. */
const IMAGE_BASE64_BUDGET = 8 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
};

/** Uint8Array → base64, chunked so String.fromCharCode never hits the platform
 *  argument-count limit on large images. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

/**
 * Resolves picture `binaryItemIDRef`s to markdown image blocks, spending a
 * shared base64 budget across the whole document. Unresolvable references
 * yield null (skipped silently); budget-skipped images are counted in
 * `omitted` so the caller can append a note.
 */
class ImageResolver {
  omitted = 0;
  private used = 0;
  private readonly index = new Map<string, string>(); // ref id → ZIP entry name

  constructor(private readonly entries: Map<string, Uint8Array>) {
    // Direct BinData entries first: both "image1.png" and "image1" address
    // them, so manifest-less references still resolve.
    for (const name of entries.keys()) {
      const m = /^(?:Contents\/)?BinData\/([^/]+)$/i.exec(name);
      if (!m) continue;
      this.index.set(m[1], name);
      this.index.set(m[1].replace(/\.[^.]+$/, ""), name);
    }
    // The content.hpf manifest maps item ids to hrefs — it wins over guesses.
    const hpfName = [...entries.keys()].find((n) => /(^|\/)content\.hpf$/i.test(n));
    const doc = hpfName ? parseXml(new TextDecoder().decode(entries.get(hpfName)!)) : null;
    if (!doc) return;
    for (const item of Array.from(doc.getElementsByTagNameNS("*", "item"))) {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      if (!id || !href) continue;
      // hrefs are ZIP paths, usually rooted ("BinData/x.png") but occasionally
      // relative to Contents/ — try both spellings.
      const target = this.entries.has(href) ? href : this.entries.has(`Contents/${href}`) ? `Contents/${href}` : null;
      if (target) this.index.set(id, target);
    }
  }

  /** Markdown image block for a binary item id, or null when unresolvable /
   *  over budget. */
  markdown(refId: string): string | null {
    const name = this.index.get(refId);
    const bytes = name ? this.entries.get(name) : undefined;
    if (!name || !bytes) return null;
    // Pre-check with the exact base64 length (4 chars per 3 bytes, padded) so
    // an over-budget image is never even encoded.
    const base64Length = Math.ceil(bytes.length / 3) * 4;
    if (this.used + base64Length > IMAGE_BASE64_BUDGET) {
      this.omitted++;
      return null;
    }
    this.used += base64Length;
    const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
    return `![](data:${MIME_BY_EXT[ext] ?? "image/png"};base64,${bytesToBase64(bytes)})`;
  }
}

/** The binary item a `<hp:pic>` references: the `binaryItemIDRef` of its
 *  `<hc:img>` (checked first), or of any descendant — producers vary in where
 *  and how (casing, hyphenation) they spell the attribute. */
function binaryItemRef(pic: Element): string | null {
  const refOf = (el: Element): string | null => {
    for (const attr of Array.from(el.attributes)) {
      if (/^(binaryitemidref|bin-item-id|binitemidref)$/i.test(attr.localName)) return attr.value || null;
    }
    return null;
  };
  const descendants = [pic, ...Array.from(pic.getElementsByTagNameNS("*", "*"))];
  for (const el of descendants) {
    if (el.localName === "img") {
      const ref = refOf(el);
      if (ref) return ref;
    }
  }
  for (const el of descendants) {
    const ref = refOf(el);
    if (ref) return ref;
  }
  return null;
}

// --- heading styles (header.xml) -----------------------------------------------

/** Style names that mark outline/heading paragraphs, capturing the level. */
const HEADING_STYLE_NAME = /^(개요|Outline|Heading|제목)\s*([1-6])/i;

interface HeadingIndex {
  /** style id → heading level (1–6). */
  byStyle: Map<string, number>;
  /** paraPr id → heading level, for paragraphs that omit `styleIDRef`. */
  byParaPr: Map<string, number>;
}

/** Build the heading index from `Contents/header.xml` style names. When the
 *  part is missing or unparseable the maps stay empty and every paragraph
 *  falls back to plain text — level is never guessed from formatting. */
function buildHeadingIndex(entries: Map<string, Uint8Array>): HeadingIndex {
  const byStyle = new Map<string, number>();
  const byParaPr = new Map<string, number>();
  const name = [...entries.keys()].find((n) => /^Contents\/header\.xml$/i.test(n));
  const doc = name ? parseXml(new TextDecoder().decode(entries.get(name)!)) : null;
  if (doc) {
    for (const style of Array.from(doc.getElementsByTagNameNS("*", "style"))) {
      const match = HEADING_STYLE_NAME.exec(style.getAttribute("name") ?? "");
      if (!match) continue;
      const level = Number(match[2]);
      const id = style.getAttribute("id");
      if (id !== null) byStyle.set(id, level);
      const paraPr = style.getAttribute("paraPrIDRef");
      if (paraPr !== null) byParaPr.set(paraPr, level);
    }
  }
  return { byStyle, byParaPr };
}

// --- OWPML → markdown ----------------------------------------------------------

/** Per-document context the section walker consults for style/binary lookups. */
interface SectionContext {
  /** Heading level of a paragraph (0 = plain paragraph). */
  headingLevel(p: Element): number;
  /** Markdown image block for a `<hp:pic>`, or null to skip it. */
  imageBlock(pic: Element): string | null;
}

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

/** Emit a paragraph's embedded tables and pictures as blocks, in document
 *  order. Recursion stops at `tbl` (its cells flatten to text in the GFM
 *  table), so nested tables and cell pictures never surface twice. */
function collectEmbedded(el: Element, blocks: string[], ctx: SectionContext): void {
  for (const child of Array.from(el.children)) {
    if (child.localName === "tbl") {
      const md = tableToMarkdown(child);
      if (md) blocks.push(md);
    } else if (child.localName === "pic") {
      const md = ctx.imageBlock(child);
      if (md) blocks.push(md);
    } else {
      collectEmbedded(child, blocks, ctx);
    }
  }
}

/** One section document → markdown blocks, in document order. */
function sectionToMarkdown(xml: string, ctx: SectionContext): string[] {
  const doc = parseXml(xml);
  if (!doc) {
    throw new Error("HWPX 본문 XML을 해석할 수 없습니다 (invalid section XML).");
  }
  const blocks: string[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.localName;
      if (tag === "p") {
        const text = paragraphText(child).trim();
        if (text) {
          const level = ctx.headingLevel(child);
          blocks.push(level ? `${"#".repeat(level)} ${text.replace(/\n/g, " ")}` : text);
        }
        // Tables and pictures nested in this paragraph's runs follow its text.
        collectEmbedded(child, blocks, ctx);
      } else if (tag !== "tbl") {
        walk(child);
      }
    }
  };
  walk(doc.documentElement);
  return blocks;
}

/** Convert a `.hwpx` buffer to markdown (headings, paragraphs, tables, and
 *  embedded images as data URLs — all sections, in document order). */
export async function hwpxToMarkdown(buffer: ArrayBuffer): Promise<string> {
  const entries = await readZip(buffer);

  // Body parts: Contents/section0.xml, section1.xml, … in numeric order.
  const sections = [...entries.keys()]
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
  if (!sections.length) {
    throw new Error("HWPX 문서가 아닙니다 — 본문(section XML)이 없습니다 (no Contents/section*.xml).");
  }

  const headings = buildHeadingIndex(entries);
  const images = new ImageResolver(entries);
  const ctx: SectionContext = {
    headingLevel: (p) => {
      const styleId = p.getAttribute("styleIDRef");
      if (styleId !== null && headings.byStyle.has(styleId)) return headings.byStyle.get(styleId)!;
      const paraPrId = p.getAttribute("paraPrIDRef");
      return (paraPrId !== null && headings.byParaPr.get(paraPrId)) || 0;
    },
    imageBlock: (pic) => {
      const ref = binaryItemRef(pic);
      return ref ? images.markdown(ref) : null;
    },
  };

  const decoder = new TextDecoder();
  const blocks: string[] = [];
  for (const name of sections) {
    blocks.push(...sectionToMarkdown(decoder.decode(entries.get(name)!), ctx));
  }
  if (images.omitted > 0) {
    blocks.push(`> (이미지 ${images.omitted}장 생략 / ${images.omitted} images omitted)`);
  }
  return blocks.join("\n\n").trim();
}
