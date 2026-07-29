/**
 * Markdown document → `.hwpx` (Hancom HWPX / OWPML) export, dependency-free.
 *
 * The inverse of `hwpx.ts`: where that file reads `Contents/section*.xml` out of
 * the ZIP container, this one assembles a complete minimal OWPML package —
 * `mimetype`, `version.xml`, `META-INF/*`, `Contents/content.hpf`,
 * `Contents/header.xml`, `Contents/section0.xml`, `settings.xml` — and zips it
 * by hand with stored (uncompressed) entries, so the export costs zero bundle
 * bytes.
 *
 * The package mirrors the blank document the reference OWPML implementation
 * (hwpxlib's blank-file maker, whose output 한글 opens) emits: same part names
 * and order, the full 2011 HWPML namespace set on every content root, booleans
 * as `1`/`0`, and — deliberately — the format's baked-in misspellings
 * (`tagetApplication`, `hh:trackchageConfig`). Structural markup is kept on one
 * line, as 한글 writes it, so no stray whitespace can leak into text runs.
 * Every `IDRef` in the body resolves against `header.xml` — in particular
 * borderFills 1 and 2, which charPr/paraPr/secPr all depend on; dangling
 * references are the usual reason a hand-built HWPX fails to open.
 */

import type { DocumentData } from "../protocol/artifacts";

// --- CRC-32 ---------------------------------------------------------------------

/** Standard CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) — ZIP's checksum. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte array. Exposed for tests (CRC32("123456789") = 0xCBF43926). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- minimal ZIP writer ---------------------------------------------------------

/**
 * Assemble a ZIP from named parts, all stored (method 0) — XML this small gains
 * nothing from deflate, and stored entries keep the writer trivial and the
 * `mimetype` part readable by magic-number sniffers. Entry order is preserved,
 * which is how `mimetype` ends up first (the OCF-container convention).
 */
function storeZip(parts: Array<[name: string, content: Uint8Array]>): Uint8Array<ArrayBuffer> {
  // Fixed DOS timestamp (2026-01-01 00:00) keeps the output byte-deterministic.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, data] of parts) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed to extract
    lv.setUint16(8, 0, true); // method 0 = stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size (= raw, stored)
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cdir = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdir.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(10, 0, true); // method
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // local header offset
    cdir.set(nameBytes, 46);
    central.push(cdir);

    offset += local.length + data.length;
  }

  const cdirSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end-of-central-directory signature
  ev.setUint16(8, parts.length, true); // entries on this disk
  ev.setUint16(10, parts.length, true); // entries total
  ev.setUint32(12, cdirSize, true);
  ev.setUint32(16, offset, true); // central directory offset

  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of all) { out.set(c, pos); pos += c.length; }
  return out;
}

// --- OWPML package parts --------------------------------------------------------

// The space before `?>` matches the reference writer byte-for-byte.
const XML_DECL = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>`;

/** The full 2011 HWPML namespace set — every content root (content.hpf,
 *  header.xml, section0.xml) re-declares all of it, since each ZIP part is
 *  parsed standalone. The `hp`/`hs` URIs are the same ones `hwpx.ts` reads. */
const HWPML_NS = [
  `xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"`,
  `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`,
  `xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph"`,
  `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"`,
  `xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"`,
  `xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"`,
  `xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history"`,
  `xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page"`,
  `xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"`,
  `xmlns:dc="http://purl.org/dc/elements/1.1/"`,
  `xmlns:opf="http://www.idpf.org/2007/opf/"`,
  `xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart"`,
  `xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"`,
  `xmlns:epub="http://www.idpf.org/2007/ops"`,
  `xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"`,
].join(" ");

// `tagetApplication` (sic) is the format's own misspelling — do not "fix" it.
const VERSION_XML =
  XML_DECL +
  `<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="0" micro="5" buildNumber="0" xmlVersion="1.4" application="langchain-canvas" appVersion="1.0"/>`;

const CONTAINER_XML =
  XML_DECL +
  `<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf">` +
  `<ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles>` +
  `</ocf:container>`;

// Empty on purpose: the manifest only carries entries for encrypted parts.
const MANIFEST_XML = XML_DECL + `<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`;

// OPF-style package listing. `settings` is manifest-only — the spine names just
// the parts in reading order (header, then the section).
const CONTENT_HPF =
  XML_DECL +
  `<opf:package ${HWPML_NS} version="" unique-identifier="" id="">` +
  `<opf:metadata><opf:title/><opf:language>ko</opf:language></opf:metadata>` +
  `<opf:manifest>` +
  `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>` +
  `<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>` +
  `<opf:item id="settings" href="settings.xml" media-type="application/xml"/>` +
  `</opf:manifest>` +
  `<opf:spine><opf:itemref idref="header"/><opf:itemref idref="section0"/></opf:spine>` +
  `</opf:package>`;

const SETTINGS_XML =
  XML_DECL +
  `<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">` +
  `<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/>` +
  `</ha:HWPApplicationSetting>`;

/** One fontface per language slot — the format expects all seven, and
 *  `itemCnt` on the wrapper is fixed at 7 accordingly. */
function fontfaces(): string {
  const langs = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
  const face = (lang: string) =>
    `<hh:fontface lang="${lang}" fontCnt="1">` +
    `<hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">` +
    `<hh:typeInfo familyType="FCAT_GOTHIC" weight="8" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>` +
    `</hh:font>` +
    `</hh:fontface>`;
  return `<hh:fontfaces itemCnt="7">${langs.map(face).join("")}</hh:fontfaces>`;
}

/** Two border fills, as a blank 한글 document defines them: id 1 (page border)
 *  and id 2 (the fill every charPr/paraPr references). Both must exist. */
function borderFills(): string {
  const fill = (id: number) =>
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    `<hh:slash type="NONE" Crooked="0" isCounter="0"/>` +
    `<hh:backSlash type="NONE" Crooked="0" isCounter="0"/>` +
    `<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/>` +
    `<hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>` +
    `<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/>` +
    `<hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>` +
    `<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>` +
    `</hh:borderFill>`;
  return `<hh:borderFills itemCnt="2">${fill(1)}${fill(2)}</hh:borderFills>`;
}

/** Character shapes: body text plus heading sizes and inline emphasis variants.
 *  `height` is in 1/100 pt, so 1000 = 10 pt. */
const CHAR_PR = [
  { id: 0, height: 1000, bold: false, italic: false }, // body
  { id: 1, height: 1800, bold: true, italic: false }, // heading 1
  { id: 2, height: 1500, bold: true, italic: false }, // heading 2
  { id: 3, height: 1200, bold: true, italic: false }, // heading 3
  { id: 4, height: 1000, bold: true, italic: false }, // inline bold
  { id: 5, height: 1000, bold: false, italic: true }, // inline italic
] as const;

function charProperties(): string {
  // Child order matters: font metrics, then the bold/italic flags, then the
  // decoration elements — the order the reference writer emits.
  const one = (c: (typeof CHAR_PR)[number]) =>
    `<hh:charPr id="${c.id}" height="${c.height}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">` +
    `<hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>` +
    `<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>` +
    `<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>` +
    `<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>` +
    `<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>` +
    (c.bold ? `<hh:bold/>` : "") +
    (c.italic ? `<hh:italic/>` : "") +
    `<hh:underline type="NONE" shape="SOLID" color="#000000"/>` +
    `<hh:strikeout shape="NONE" color="#000000"/>` +
    `<hh:outline type="NONE"/>` +
    `<hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/>` +
    `</hh:charPr>`;
  return `<hh:charProperties itemCnt="${CHAR_PR.length}">${CHAR_PR.map(one).join("")}</hh:charProperties>`;
}

/** The stock outline numbering a blank document carries. Nothing here refers to
 *  it (list items are plain text in v1), but it keeps the header shaped like the
 *  reference. `charPrIDRef="4294967295"` is the "inherit" sentinel, not a bug. */
function numberings(): string {
  const heads = Array.from(
    { length: 7 },
    (_, i) =>
      `<hh:paraHead start="1" level="${i + 1}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="1">^${i + 1}.</hh:paraHead>`,
  ).join("");
  return `<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">${heads}</hh:numbering></hh:numberings>`;
}

/** Paragraph shape: one justified body layout shared by every paragraph. */
function paraProperties(): string {
  return (
    `<hh:paraProperties itemCnt="1">` +
    `<hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">` +
    `<hh:align horizontal="JUSTIFY" vertical="BASELINE"/>` +
    `<hh:heading type="NONE" idRef="0" level="0"/>` +
    `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
    `<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>` +
    `<hh:margin>` +
    `<hc:intent value="0" unit="HWPUNIT"/>` +
    `<hc:left value="0" unit="HWPUNIT"/>` +
    `<hc:right value="0" unit="HWPUNIT"/>` +
    `<hc:prev value="0" unit="HWPUNIT"/>` +
    `<hc:next value="0" unit="HWPUNIT"/>` +
    `</hh:margin>` +
    `<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>` +
    `<hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>` +
    `</hh:paraPr>` +
    `</hh:paraProperties>`
  );
}

/** Style table: body (바탕글/Normal, id 0) plus the three outline levels the
 *  heading mapper targets — named like 한글's own built-ins. */
const STYLES = [
  { id: 0, name: "바탕글", engName: "Normal", charPr: 0, next: 0 },
  { id: 1, name: "개요 1", engName: "Outline 1", charPr: 1, next: 1 },
  { id: 2, name: "개요 2", engName: "Outline 2", charPr: 2, next: 2 },
  { id: 3, name: "개요 3", engName: "Outline 3", charPr: 3, next: 3 },
] as const;

function styles(): string {
  const one = (s: (typeof STYLES)[number]) =>
    `<hh:style id="${s.id}" type="PARA" name="${s.name}" engName="${s.engName}" paraPrIDRef="0" charPrIDRef="${s.charPr}" nextStyleIDRef="${s.next}" langID="1042" lockForm="0"/>`;
  return `<hh:styles itemCnt="${STYLES.length}">${STYLES.map(one).join("")}</hh:styles>`;
}

function headerXml(): string {
  // refList child order is fixed: fontfaces → borderFills → charProperties →
  // tabProperties → numberings → paraProperties → styles.
  return (
    XML_DECL +
    `<hh:head ${HWPML_NS} version="1.4" secCnt="1">` +
    `<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>` +
    `<hh:refList>` +
    fontfaces() +
    borderFills() +
    charProperties() +
    `<hh:tabProperties itemCnt="2"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/><hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/></hh:tabProperties>` +
    numberings() +
    paraProperties() +
    styles() +
    `</hh:refList>` +
    `<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>` +
    `<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>` +
    // `trackchageConfig` (sic) — another misspelling the format itself carries.
    `<hh:trackchageConfig flags="56"/>` +
    `</hh:head>`
  );
}

/** Page setup (A4 portrait, standard margins, single column) that rides in the
 *  first paragraph's first run — 한글 reads the section geometry from here. */
const SEC_PR =
  `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0">` +
  `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>` +
  `<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
  `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
  `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>` +
  `<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY">` +
  `<hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/>` +
  `</hp:pagePr>` +
  `<hp:footNotePr>` +
  `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>` +
  `<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>` +
  `<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/>` +
  `<hp:numbering type="CONTINUOUS" newNum="1"/>` +
  `<hp:placement place="EACH_COLUMN" beneathText="0"/>` +
  `</hp:footNotePr>` +
  `<hp:endNotePr>` +
  `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>` +
  `<hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/>` +
  `<hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/>` +
  `<hp:numbering type="CONTINUOUS" newNum="1"/>` +
  `<hp:placement place="END_OF_DOCUMENT" beneathText="0"/>` +
  `</hp:endNotePr>` +
  `<hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>` +
  `<hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>` +
  `<hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>` +
  `</hp:secPr>` +
  `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>`;

// --- markdown → OWPML body ------------------------------------------------------

/** A run of body text with the charPr it renders in. */
interface Run {
  text: string;
  charPr: number;
}

/** A block-level unit: one output `hp:p`. */
interface Block {
  runs: Run[];
  /** Style id: 0 body, 1–3 the outline (heading) styles. */
  style: number;
}

function escapeXml(value: string): string {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Split a line into runs on `**bold**` / `*italic*` spans; inline code just
 * sheds its backticks. Anything fancier (nested emphasis, links) passes through
 * as literal text — dropped formatting beats malformed markup.
 */
function inlineRuns(text: string, baseCharPr: number): Run[] {
  const runs: Run[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) runs.push({ text: text.slice(last, m.index), charPr: baseCharPr });
    const token = m[0];
    if (token.startsWith("**")) runs.push({ text: token.slice(2, -2), charPr: 4 });
    else if (token.startsWith("*")) runs.push({ text: token.slice(1, -1), charPr: 5 });
    else runs.push({ text: token.slice(1, -1), charPr: baseCharPr });
    last = m.index! + token.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), charPr: baseCharPr });
  return runs.length ? runs : [{ text: "", charPr: baseCharPr }];
}

/** GFM table separator row: `| --- | :--: |`. */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

/** Split a `| a | b |` row into trimmed cells, honoring escaped pipes. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Line-oriented markdown → blocks. Headings 1–3 map to the outline styles;
 * list items keep their marker as literal text ("• " / "1. ") — real OWPML
 * numbering is out of scope for v1. Table rows collapse to "cell | cell"
 * paragraphs: plain but guaranteed openable.
 */
function markdownToBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      // Heading text renders in the style's charPr — inline markers are shed.
      const text = heading[2].replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
      blocks.push({ runs: [{ text, charPr: heading[1].length }], style: heading[1].length });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({ runs: [{ text: "• ", charPr: 0 }, ...inlineRuns(bullet[1], 0)], style: 0 });
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push({ runs: [{ text: `${numbered[1]}. `, charPr: 0 }, ...inlineRuns(numbered[2], 0)], style: 0 });
      continue;
    }

    if (line.trim().startsWith("|")) {
      if (isTableSeparator(line)) continue; // drop the `| --- |` ruler row
      blocks.push({ runs: [{ text: tableCells(line).join(" | "), charPr: 0 }], style: 0 });
      continue;
    }

    blocks.push({ runs: inlineRuns(line, 0), style: 0 });
  }
  // 한글 wants at least one paragraph per section.
  return blocks.length ? blocks : [{ runs: [{ text: "", charPr: 0 }], style: 0 }];
}

/** Serialize one paragraph, markup kept tight (no whitespace-only text nodes).
 *  The section's first run carries the page setup, as 한글 itself writes it. */
function paragraphXml(block: Block, index: number): string {
  const runs = block.runs
    .map(
      (r, i) =>
        `<hp:run charPrIDRef="${r.charPr}">${index === 0 && i === 0 ? SEC_PR : ""}<hp:t>${escapeXml(r.text)}</hp:t></hp:run>`,
    )
    .join("");
  // The lineseg is 한글's cached line layout; a nominal one is enough — the
  // application re-lays out on open.
  return (
    `<hp:p id="${index}" paraPrIDRef="0" styleIDRef="${block.style}" pageBreak="0" columnBreak="0" merged="0">` +
    runs +
    `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>` +
    `</hp:p>`
  );
}

function sectionXml(blocks: Block[]): string {
  return XML_DECL + `<hs:sec ${HWPML_NS}>` + blocks.map(paragraphXml).join("") + `</hs:sec>`;
}

// --- entry point ----------------------------------------------------------------

/** Markdown document → `.hwpx` bytes (OWPML in a ZIP). */
export async function documentToHwpx(data: DocumentData): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const blocks = markdownToBlocks(data.content ?? "");
  const parts: Array<[string, Uint8Array]> = [
    // `mimetype` must be the container's first entry, stored.
    ["mimetype", enc.encode("application/hwp+zip")],
    ["version.xml", enc.encode(VERSION_XML)],
    ["META-INF/manifest.xml", enc.encode(MANIFEST_XML)],
    ["META-INF/container.xml", enc.encode(CONTAINER_XML)],
    ["Contents/content.hpf", enc.encode(CONTENT_HPF)],
    ["Contents/header.xml", enc.encode(headerXml())],
    ["Contents/section0.xml", enc.encode(sectionXml(blocks))],
    ["settings.xml", enc.encode(SETTINGS_XML)],
  ];
  return storeZip(parts);
}
