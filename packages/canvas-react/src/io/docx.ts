/**
 * `.docx` (OOXML WordprocessingML) → markdown import, dependency-free.
 *
 * A DOCX file is a ZIP of XML parts: the document body lives in
 * `word/document.xml` as WordprocessingML — `<w:p>` paragraphs of `<w:r>` runs
 * whose `<w:t>` nodes carry the text, with `<w:tbl>` tables as siblings of
 * paragraphs in the body.
 *
 * The container goes through the shared zero-dependency ZIP reader from the
 * HWPX importer, and the XML through `DOMParser`. Namespace prefixes are
 * matched by `localName`, so files that bind `w:` differently still parse.
 * Scope (v1): paragraphs, headings, bullet lists, tables, and bold/italic runs;
 * headers/footers, footnotes, images, and field codes are ignored.
 */

import { readZip } from "./hwpx";

// --- WordprocessingML helpers ---------------------------------------------------

/** First direct child with the given localName, whatever its prefix. */
function childOf(el: Element, name: string): Element | null {
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return null;
}

/** Attribute value by localName (`w:val`, `xml:space`, … regardless of prefix). */
function attrOf(el: Element, name: string): string | null {
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}

/** A toggle property (`w:b`, `w:i`) is ON when the element is present, unless
 *  its `w:val` explicitly switches it off. */
function toggleOn(rPr: Element | null, name: string): boolean {
  const prop = rPr && childOf(rPr, name);
  if (!prop) return false;
  const val = attrOf(prop, "val");
  return val !== "0" && val !== "false" && val !== "none";
}

/** Heading level from `w:pPr > w:pStyle`, or 0 for body text. Word writes style
 *  ids like "Heading1"; localized docs (e.g. Korean "제목 1") keep the same
 *  latin ids, and some tools emit "heading 1" — so match case-insensitively
 *  with an optional space. */
function headingLevel(pPr: Element | null): number {
  const style = pPr && childOf(pPr, "pStyle");
  const id = style && attrOf(style, "val");
  const m = id && /^heading ?([1-6])$/i.exec(id);
  return m ? Number(m[1]) : 0;
}

/** Bullet nesting level when the paragraph is a list item (`w:numPr` present),
 *  or null for a plain paragraph. Ordered vs unordered isn't distinguished in
 *  v1 — resolving that needs word/numbering.xml. */
function listLevel(pPr: Element | null): number | null {
  const numPr = pPr && childOf(pPr, "numPr");
  if (!numPr) return null;
  const ilvl = childOf(numPr, "ilvl");
  return Number(ilvl && attrOf(ilvl, "val")) || 0;
}

// --- runs → inline markdown -----------------------------------------------------

type Segment = { text: string; bold: boolean; italic: boolean };

/** Text of one run: `w:t` (kept verbatim under xml:space="preserve", trimmed
 *  otherwise per XML whitespace rules), `w:br` → newline, `w:tab` → tab.
 *  Anything else in the run (field codes, drawings) is ignored. */
function runText(run: Element): string {
  let out = "";
  for (const c of Array.from(run.children)) {
    if (c.localName === "t") {
      const raw = c.textContent ?? "";
      out += attrOf(c, "space") === "preserve" ? raw : raw.trim();
    } else if (c.localName === "br") out += "\n";
    else if (c.localName === "tab") out += "\t";
  }
  return out;
}

/** Collect a paragraph's runs (descending into hyperlinks, field results, and
 *  the like) with their bold/italic state. */
function paragraphSegments(p: Element): Segment[] {
  const segs: Segment[] = [];
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (c.localName === "pPr") continue; // properties, not content
      if (c.localName === "r") {
        const rPr = childOf(c, "rPr");
        const text = runText(c);
        if (text) segs.push({ text, bold: toggleOn(rPr, "b"), italic: toggleOn(rPr, "i") });
      } else walk(c);
    }
  };
  walk(p);
  return segs;
}

/** Render segments as inline markdown. Adjacent same-format runs are merged
 *  first — Word splits words across runs freely, and `**bol**` + `**d**` would
 *  otherwise break mid-token. Emphasis markers hug the text: surrounding
 *  whitespace stays outside the wrap so the markdown stays valid. */
function renderSegments(segs: Segment[]): string {
  const merged: Segment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged
    .map(({ text, bold, italic }) => {
      if (!bold && !italic) return text;
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
      if (!core) return text;
      const mark = bold && italic ? "***" : bold ? "**" : "*";
      return `${lead}${mark}${core}${mark}${trail}`;
    })
    .join("");
}

// --- blocks → markdown ----------------------------------------------------------

type Block = { kind: "list" | "other"; text: string };

/** One paragraph → a markdown block: heading, list item, or plain text. */
function paragraphToBlock(p: Element): Block | null {
  const text = renderSegments(paragraphSegments(p)).trim();
  if (!text) return null;
  const pPr = childOf(p, "pPr");
  const heading = headingLevel(pPr);
  if (heading) return { kind: "other", text: `${"#".repeat(heading)} ${text}` };
  const level = listLevel(pPr);
  if (level !== null) return { kind: "list", text: `${"  ".repeat(level)}- ${text}` };
  return { kind: "other", text };
}

/** Render a `<w:tbl>` as a GFM table (first row as header). Cell text joins the
 *  cell's own paragraphs — nested tables are out of scope for v1 — and pipes
 *  are escaped so they can't break the row. */
function tableToMarkdown(tbl: Element): string {
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.children)) {
    if (tr.localName !== "tr") continue;
    const cells: string[] = [];
    for (const tc of Array.from(tr.children)) {
      if (tc.localName !== "tc") continue;
      const text = Array.from(tc.getElementsByTagNameNS("*", "p"))
        .filter((p) => (p as Element).closest("tbl") === tbl)
        .map((p) => renderSegments(paragraphSegments(p as Element)).trim())
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

/** Body → markdown blocks in document order; consecutive list items collapse
 *  into a single block so they form one markdown list. */
function documentToMarkdown(doc: Document): string {
  const blocks: Block[] = [];
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (c.localName === "p") {
        const block = paragraphToBlock(c);
        if (block) blocks.push(block);
      } else if (c.localName === "tbl") {
        const md = tableToMarkdown(c);
        if (md) blocks.push({ kind: "other", text: md });
      } else {
        walk(c); // w:body, sdt wrappers, …
      }
    }
  };
  walk(doc.documentElement);

  const out: string[] = [];
  let prevKind: Block["kind"] | null = null;
  for (const { kind, text } of blocks) {
    if (kind === "list" && prevKind === "list") out[out.length - 1] += `\n${text}`;
    else out.push(text);
    prevKind = kind;
  }
  return out.join("\n\n").trim();
}

/** Convert a `.docx` buffer to markdown (paragraphs, headings, lists, tables, bold/italic). */
export async function docxToMarkdown(buffer: ArrayBuffer): Promise<string> {
  const entries = await readZip(buffer);
  const body = entries.get("word/document.xml");
  if (!body) {
    throw new Error("DOCX 문서가 아닙니다 — 본문(word/document.xml)이 없습니다 (Not a DOCX document — missing word/document.xml).");
  }
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(body), "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("DOCX 본문 XML을 해석할 수 없습니다 (invalid document XML).");
  }
  return documentToMarkdown(doc);
}
