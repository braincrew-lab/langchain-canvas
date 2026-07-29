/**
 * `.hwpx` (Hancom HWPX / OWPML) → markdown / HTML import, dependency-free.
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

  /** Data URL for a binary item id, or null when unresolvable / over budget —
   *  the shared resolution both the markdown and HTML emitters build on. */
  dataUrl(refId: string): string | null {
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
    return `data:${MIME_BY_EXT[ext] ?? "image/png"};base64,${bytesToBase64(bytes)}`;
  }

  /** Markdown image block for a binary item id, or null when unresolvable /
   *  over budget. */
  markdown(refId: string): string | null {
    const url = this.dataUrl(refId);
    return url ? `![](${url})` : null;
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

/** The parsed parts every converter starts from: ZIP entries, decoded section
 *  XML sources in numeric order, and the heading/image lookups. */
interface HwpxDocument {
  entries: Map<string, Uint8Array>;
  sections: string[];
  headings: HeadingIndex;
  images: ImageResolver;
}

/** Open a `.hwpx` buffer: read the ZIP, locate `Contents/section*.xml` in
 *  numeric order, and build the shared heading/image lookups. */
async function openHwpx(buffer: ArrayBuffer): Promise<HwpxDocument> {
  const entries = await readZip(buffer);

  // Body parts: Contents/section0.xml, section1.xml, … in numeric order.
  const names = [...entries.keys()]
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
  if (!names.length) {
    throw new Error("HWPX 문서가 아닙니다 — 본문(section XML)이 없습니다 (no Contents/section*.xml).");
  }

  const decoder = new TextDecoder();
  return {
    entries,
    sections: names.map((n) => decoder.decode(entries.get(n)!)),
    headings: buildHeadingIndex(entries),
    images: new ImageResolver(entries),
  };
}

/** Heading level of a paragraph per the heading index: the `styleIDRef` wins,
 *  then the style's `paraPrIDRef`; 0 means plain paragraph. */
function headingLevelOf(p: Element, headings: HeadingIndex): number {
  const styleId = p.getAttribute("styleIDRef");
  if (styleId !== null && headings.byStyle.has(styleId)) return headings.byStyle.get(styleId)!;
  const paraPrId = p.getAttribute("paraPrIDRef");
  return (paraPrId !== null && headings.byParaPr.get(paraPrId)) || 0;
}

/** Convert a `.hwpx` buffer to markdown (headings, paragraphs, tables, and
 *  embedded images as data URLs — all sections, in document order). */
export async function hwpxToMarkdown(buffer: ArrayBuffer): Promise<string> {
  const { sections, headings, images } = await openHwpx(buffer);
  const ctx: SectionContext = {
    headingLevel: (p) => headingLevelOf(p, headings),
    imageBlock: (pic) => {
      const ref = binaryItemRef(pic);
      return ref ? images.markdown(ref) : null;
    },
  };

  const blocks: string[] = [];
  for (const xml of sections) {
    blocks.push(...sectionToMarkdown(xml, ctx));
  }
  if (images.omitted > 0) {
    blocks.push(`> (이미지 ${images.omitted}장 생략 / ${images.omitted} images omitted)`);
  }
  return blocks.join("\n\n").trim();
}

// --- HTML output ----------------------------------------------------------------

/** Escape text for HTML element content and (double-quoted) attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Default 한글 font stack — single-quoted so it survives inside a
 *  double-quoted `style="…"` attribute without escaping. */
const KOREAN_FONT_STACK = "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo',AppleGothic,sans-serif";

/**
 * Wrap converted body HTML in a complete standalone page styled like a 한글
 * sheet: a white A4-proportioned page centered on a neutral background, with
 * the table/paragraph base rules both importers rely on. Shared by the HWPX
 * and binary-HWP HTML paths; zero external assets.
 */
export function koreanDocHtml(bodyHtml: string, title = "문서"): string {
  return (
    `<!DOCTYPE html>\n<html lang="ko">\n<head>\n` +
    `<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n<style>\n` +
    `body{margin:0;padding:32px 16px;background:#eceff1;color:#191919;font-family:${KOREAN_FONT_STACK};line-height:1.6;}\n` +
    `.page{max-width:794px;margin:0 auto;background:#fff;padding:96px 72px;box-shadow:0 2px 12px rgba(0,0,0,.12);}\n` +
    `.page p{margin:0 0 10px;}\n` +
    `.page h1,.page h2,.page h3,.page h4,.page h5,.page h6{margin:18px 0 12px;line-height:1.35;}\n` +
    `.page table{border-collapse:collapse;margin:0 0 10px;}\n` +
    `.page td,.page th{border:1px solid #666;padding:6px 8px;vertical-align:top;}\n` +
    `.page td p:last-child{margin-bottom:0;}\n` +
    `.page img{max-width:100%;}\n` +
    `</style>\n</head>\n<body>\n<div class="page">\n${bodyHtml}\n</div>\n</body>\n</html>`
  );
}

// --- run/paragraph styles (header.xml) ------------------------------------------

/** Per-document style lookups resolved from `Contents/header.xml`. */
interface StyleIndex {
  /** charPr id → inline CSS for a run ("" = nothing worth emitting). */
  charCss: Map<string, string>;
  /** paraPr id → CSS `text-align` value. */
  paraAlign: Map<string, string>;
  /** borderFill id → fill color (table cell backgrounds). */
  fillColor: Map<string, string>;
}

/** OWPML `<hh:align horizontal="…">` values → CSS `text-align`. */
const ALIGN_CSS: Record<string, string> = {
  LEFT: "left",
  CENTER: "center",
  RIGHT: "right",
  JUSTIFY: "justify",
  BOTH: "justify",
  DISTRIBUTE: "justify",
  DISTRIBUTE_SPACE: "justify",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** OWPML stores char height in 1/100 pt; CSS px ≈ pt × 4⁄3, kept to 2 decimals. */
const heightToPx = (height: number): number => Math.round((height / 100) * (4 / 3) * 100) / 100;

/** Inline CSS for one `<hh:charPr>`: font face (via the fontfaces table),
 *  size, color, and the bold/italic/underline flags. */
function charPrCss(charPr: Element, faceByLangId: Map<string, string>): string {
  let bold = false;
  let italic = false;
  let underline = false;
  let face: string | undefined;
  for (const child of Array.from(charPr.children)) {
    const tag = child.localName;
    if (tag === "bold") bold = true;
    else if (tag === "italic") italic = true;
    else if (tag === "underline") {
      // The reference writer always emits the element; type="NONE" means off.
      underline = (child.getAttribute("type") ?? "SOLID").toUpperCase() !== "NONE";
    } else if (tag === "fontRef") {
      // Per-language font ids; the HANGUL slot decides for Korean documents.
      const ref = child.getAttribute("hangul") ?? child.getAttribute("latin");
      if (ref !== null) face = faceByLangId.get(`HANGUL:${ref}`) ?? faceByLangId.get(`LATIN:${ref}`);
    }
  }

  const rules: string[] = [];
  if (face) rules.push(`font-family:'${face.replace(/'/g, "")}',${KOREAN_FONT_STACK}`);
  const height = Number(charPr.getAttribute("height"));
  if (Number.isFinite(height) && height > 0) rules.push(`font-size:${heightToPx(height)}px`);
  const color = charPr.getAttribute("textColor");
  // Default black is the page's own color — emitting it would only defeat span merging.
  if (color && HEX_COLOR.test(color) && color.toLowerCase() !== "#000000") rules.push(`color:${color}`);
  if (bold) rules.push("font-weight:bold");
  if (italic) rules.push("font-style:italic");
  if (underline) rules.push("text-decoration:underline");
  return rules.join(";");
}

/** Build the style lookups from `Contents/header.xml`. A missing or invalid
 *  part leaves every map empty — runs then render with the default stack. */
function buildStyleIndex(entries: Map<string, Uint8Array>): StyleIndex {
  const index: StyleIndex = { charCss: new Map(), paraAlign: new Map(), fillColor: new Map() };
  const name = [...entries.keys()].find((n) => /^Contents\/header\.xml$/i.test(n));
  const doc = name ? parseXml(new TextDecoder().decode(entries.get(name)!)) : null;
  if (!doc) return index;

  // Fontfaces: (lang, font id) → face name, for charPr `<hh:fontRef>` lookups.
  const faceByLangId = new Map<string, string>();
  for (const fontface of Array.from(doc.getElementsByTagNameNS("*", "fontface"))) {
    const lang = fontface.getAttribute("lang") ?? "";
    for (const font of Array.from(fontface.getElementsByTagNameNS("*", "font"))) {
      const id = font.getAttribute("id");
      const face = font.getAttribute("face");
      if (id !== null && face) faceByLangId.set(`${lang}:${id}`, face);
    }
  }

  for (const charPr of Array.from(doc.getElementsByTagNameNS("*", "charPr"))) {
    const id = charPr.getAttribute("id");
    if (id !== null) index.charCss.set(id, charPrCss(charPr, faceByLangId));
  }

  for (const paraPr of Array.from(doc.getElementsByTagNameNS("*", "paraPr"))) {
    const id = paraPr.getAttribute("id");
    if (id === null) continue;
    // Alignment nests as `<hh:align horizontal="…"/>`; some producers put an
    // `align` attribute on the paraPr itself — accept both spellings.
    let raw = paraPr.getAttribute("align") ?? paraPr.getAttribute("alignment");
    for (const child of Array.from(paraPr.children)) {
      if (child.localName === "align") raw = child.getAttribute("horizontal") ?? child.getAttribute("align") ?? raw;
    }
    const css = raw ? ALIGN_CSS[raw.toUpperCase()] : undefined;
    if (css) index.paraAlign.set(id, css);
  }

  for (const borderFill of Array.from(doc.getElementsByTagNameNS("*", "borderFill"))) {
    const id = borderFill.getAttribute("id");
    const color = borderFill.getElementsByTagNameNS("*", "winBrush")[0]?.getAttribute("faceColor");
    if (id !== null && color && HEX_COLOR.test(color)) index.fillColor.set(id, color);
  }
  return index;
}

// --- OWPML → HTML ---------------------------------------------------------------

/** Per-document context the HTML section walker consults. */
interface HtmlSectionContext {
  /** Heading level of a paragraph (0 = plain paragraph). */
  headingLevel(p: Element): number;
  /** Inline CSS for a run's `charPrIDRef` ("" = unstyled). */
  charCss(id: string | null): string;
  /** CSS `text-align` for a paragraph's `paraPrIDRef`, or null. */
  paraAlign(id: string | null): string | null;
  /** Fill color for a cell's `borderFillIDRef`, or null. */
  cellBackground(id: string | null): string | null;
  /** `<img>` tag for a `<hp:pic>`, or null to skip it. */
  imageTag(pic: Element): string | null;
}

/** Inline HTML of a paragraph: text runs as styled spans (adjacent runs with
 *  identical styles merge into one), skipping nested tables/pictures — those
 *  are emitted as blocks by the caller. */
function paragraphInlineHtml(p: Element, ctx: HtmlSectionContext): string {
  const segments: { css: string; html: string }[] = [];
  const walk = (el: Element, css: string) => {
    for (const child of Array.from(el.children)) {
      const tag = child.localName;
      if (tag === "tbl" || tag === "pic") continue; // block content — rendered by the caller
      if (tag === "t") {
        const text = child.textContent ?? "";
        if (text) segments.push({ css, html: escapeHtml(text) });
      } else if (tag === "lineBreak") {
        segments.push({ css, html: "<br>" });
      } else if (tag === "run") {
        walk(child, ctx.charCss(child.getAttribute("charPrIDRef")));
      } else {
        walk(child, css);
      }
    }
  };
  walk(p, "");

  let out = "";
  for (let i = 0; i < segments.length; ) {
    const css = segments[i].css;
    let html = "";
    for (; i < segments.length && segments[i].css === css; i++) html += segments[i].html;
    out += css ? `<span style="${escapeHtml(css)}">${html}</span>` : html;
  }
  return out;
}

/** Emit one paragraph as an HTML block (heading or `<p>`, aligned per its
 *  paraPr), then its embedded tables/pictures — mirroring the markdown walk. */
function paragraphToHtmlBlocks(p: Element, blocks: string[], ctx: HtmlSectionContext): void {
  // Same emptiness rule as the markdown path: text decides, styling doesn't.
  if (paragraphText(p).trim()) {
    const level = ctx.headingLevel(p);
    const align = ctx.paraAlign(p.getAttribute("paraPrIDRef"));
    const style = align ? ` style="text-align:${align}"` : "";
    const inline = paragraphInlineHtml(p, ctx);
    blocks.push(level ? `<h${level}${style}>${inline}</h${level}>` : `<p${style}>${inline}</p>`);
  }
  collectEmbeddedHtml(p, blocks, ctx);
}

/** Emit a paragraph's embedded tables and pictures as blocks, in document
 *  order — the HTML twin of `collectEmbedded`. */
function collectEmbeddedHtml(el: Element, blocks: string[], ctx: HtmlSectionContext): void {
  for (const child of Array.from(el.children)) {
    if (child.localName === "tbl") {
      const html = tableToHtml(child, ctx);
      if (html) blocks.push(html);
    } else if (child.localName === "pic") {
      const img = ctx.imageTag(child);
      if (img) blocks.push(img);
    } else {
      collectEmbeddedHtml(child, blocks, ctx);
    }
  }
}

/** Render an OWPML `<hp:tbl>` as a real `<table>`: colspan/rowspan from the
 *  cell's `<hp:cellSpan>` (or attributes on `<hp:tc>` itself), background from
 *  its borderFill, cells holding their formatted paragraphs (and nested
 *  tables, rendered recursively rather than flattened). */
function tableToHtml(tbl: Element, ctx: HtmlSectionContext): string {
  let rowsHtml = "";
  for (const tr of Array.from(tbl.getElementsByTagNameNS("*", "tr"))) {
    if (tr.closest("tbl") !== tbl) continue; // belongs to a nested table
    let cells = "";
    for (const tc of Array.from(tr.children)) {
      if (tc.localName !== "tc") continue;

      // Spans live on a `<hp:cellSpan colSpan rowSpan>` child in OWPML, but
      // some producers put the attributes on the cell — accept both, any casing.
      let colSpan = 1;
      let rowSpan = 1;
      const readSpan = (el: Element) => {
        for (const attr of Array.from(el.attributes)) {
          if (/^colspan$/i.test(attr.localName)) colSpan = Math.max(1, Number(attr.value) || 1);
          else if (/^rowspan$/i.test(attr.localName)) rowSpan = Math.max(1, Number(attr.value) || 1);
        }
      };
      readSpan(tc);
      for (const child of Array.from(tc.children)) {
        if (child.localName === "cellSpan") readSpan(child);
      }

      const inner: string[] = [];
      const walkCell = (el: Element) => {
        for (const child of Array.from(el.children)) {
          if (child.localName === "p") paragraphToHtmlBlocks(child, inner, ctx);
          else if (child.localName === "tbl") inner.push(tableToHtml(child, ctx));
          else walkCell(child);
        }
      };
      walkCell(tc);

      const bg = ctx.cellBackground(tc.getAttribute("borderFillIDRef"));
      const attrs =
        (colSpan > 1 ? ` colspan="${colSpan}"` : "") +
        (rowSpan > 1 ? ` rowspan="${rowSpan}"` : "") +
        (bg ? ` style="background:${bg}"` : "");
      cells += `<td${attrs}>${inner.join("")}</td>`;
    }
    if (cells) rowsHtml += `<tr>${cells}</tr>`;
  }
  return rowsHtml ? `<table>${rowsHtml}</table>` : "";
}

/** One section document → HTML blocks, in document order. */
function sectionToHtml(xml: string, ctx: HtmlSectionContext): string[] {
  const doc = parseXml(xml);
  if (!doc) {
    throw new Error("HWPX 본문 XML을 해석할 수 없습니다 (invalid section XML).");
  }
  const blocks: string[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.localName === "p") paragraphToHtmlBlocks(child, blocks, ctx);
      else if (child.localName !== "tbl") walk(child);
    }
  };
  walk(doc.documentElement);
  return blocks;
}

/**
 * Convert a `.hwpx` buffer to a complete standalone HTML page that mirrors the
 * original 한글 layout: per-run character formatting (font/size/color/
 * bold/italic/underline via header.xml charProperties), paragraph alignment,
 * heading blocks, bordered tables with spans and cell fills, and embedded
 * images as data URLs — all sections, in document order.
 */
export async function hwpxToHtml(buffer: ArrayBuffer): Promise<string> {
  const { entries, sections, headings, images } = await openHwpx(buffer);
  const styles = buildStyleIndex(entries);
  const ctx: HtmlSectionContext = {
    headingLevel: (p) => headingLevelOf(p, headings),
    charCss: (id) => (id !== null ? styles.charCss.get(id) ?? "" : ""),
    paraAlign: (id) => (id !== null ? styles.paraAlign.get(id) ?? null : null),
    cellBackground: (id) => (id !== null ? styles.fillColor.get(id) ?? null : null),
    imageTag: (pic) => {
      const ref = binaryItemRef(pic);
      const url = ref ? images.dataUrl(ref) : null;
      return url ? `<img src="${url}" style="max-width:100%">` : null;
    },
  };

  const blocks: string[] = [];
  for (const xml of sections) {
    blocks.push(...sectionToHtml(xml, ctx));
  }
  if (images.omitted > 0) {
    blocks.push(`<p>(이미지 ${images.omitted}장 생략 / ${images.omitted} images omitted)</p>`);
  }
  return koreanDocHtml(blocks.join("\n"));
}
