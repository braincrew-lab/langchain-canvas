/**
 * `.pptx` (OOXML PresentationML) → native `slides` import, dependency-free.
 *
 * A PPTX file is a ZIP of XML parts: `ppt/presentation.xml` declares the slide
 * size (`p:sldSz`, in EMU — 914400 per inch) and the slide order
 * (`p:sldIdLst`, resolved to parts through the package rels), and each
 * `ppt/slides/slideN.xml` holds a shape tree (`p:spTree`) of text boxes,
 * pictures, and preset-geometry shapes. Everything maps onto the editor's own
 * model: percent-of-slide geometry on a "blank" layout, with pictures inlined
 * as data URLs and speaker notes pulled from the slide's notes part.
 *
 * The container goes through the shared zero-dependency ZIP reader from the
 * HWPX importer, and the XML through `DOMParser`. Namespace prefixes are
 * matched by `localName`, so files that bind `p:`/`a:` differently still
 * parse. Out of scope (skipped silently): tables, charts, SmartArt
 * (`p:graphicFrame`), theme-indexed colors (`a:schemeClr` — color stays
 * unset), and master/layout inheritance — placeholders without an explicit
 * transform get sensible title/body default boxes instead. Group shapes are
 * recursed into, children remapped through the group's chOff/chExt transform.
 */

import type { Slide, SlideElement, SlidesData } from "../protocol/artifacts";
import { readZip } from "./hwpx";

// --- shared XML helpers ----------------------------------------------------------

/** Parse an XML part, returning null (instead of throwing) when it's invalid —
 *  auxiliary parts like rels degrade gracefully to "no data". */
function parseXml(xml: string): Document | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return doc.querySelector("parsererror") ? null : doc;
}

/** First direct child with the given localName, whatever its prefix. */
function childOf(el: Element, name: string): Element | null {
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return null;
}

/** Attribute value by localName (`prst`, `r:embed`, … regardless of prefix). */
function attrOf(el: Element, name: string): string | null {
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}

/** The `r:id` of a `p:sldId`. It carries TWO attributes with localName "id" —
 *  its own numeric id and the relationship reference — so the relationships
 *  namespace (or an explicit prefix) has to disambiguate. */
function relIdOf(el: Element): string | null {
  for (const a of Array.from(el.attributes)) {
    if (a.localName === "id" && /relationships/i.test(a.namespaceURI ?? "")) return a.value;
  }
  for (const a of Array.from(el.attributes)) {
    if (/:id$/i.test(a.name)) return a.value;
  }
  return null;
}

// --- package relationships -------------------------------------------------------

interface Rel {
  type: string;
  /** Target resolved to a full ZIP entry name (`../media/x.png` → `ppt/media/x.png`). */
  target: string;
}

/** Resolve a rels `Target` against the owning part's directory. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir ? baseDir.split("/") : [];
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** A part's relationships (`dir/_rels/name.rels`) as an Id → Rel map. Missing
 *  or invalid rels yield an empty map — lookups then just miss. */
function relsOf(entries: Map<string, Uint8Array>, partName: string): Map<string, Rel> {
  const rels = new Map<string, Rel>();
  const slash = partName.lastIndexOf("/");
  const dir = partName.slice(0, slash);
  const relsPart = entries.get(`${dir}/_rels/${partName.slice(slash + 1)}.rels`);
  const doc = relsPart ? parseXml(new TextDecoder().decode(relsPart)) : null;
  if (!doc) return rels;
  for (const rel of Array.from(doc.getElementsByTagNameNS("*", "Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) rels.set(id, { type: rel.getAttribute("Type") ?? "", target: resolveTarget(dir, target) });
  }
  return rels;
}

// --- geometry (EMU → percent) ----------------------------------------------------

/** PowerPoint's default 16:9 slide, used when `p:sldSz` is absent. */
const DEFAULT_SLIDE_CX = 12192000;
const DEFAULT_SLIDE_CY = 6858000;

/** An `a:xfrm`: offset/extent in EMU plus rotation in 60000ths of a degree. */
interface Xfrm {
  x: number;
  y: number;
  cx: number;
  cy: number;
  rot: number;
}

/** Numeric attribute of a direct child (`a:off x`, `a:ext cx`, …), or null. */
function emuOf(parent: Element, child: string, attr: string): number | null {
  const el = childOf(parent, child);
  const n = el ? Number(attrOf(el, attr)) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The `a:xfrm` of an `spPr`/`grpSpPr`, or null when offset/extent is missing. */
function xfrmOf(pr: Element): Xfrm | null {
  const xfrm = childOf(pr, "xfrm");
  if (!xfrm) return null;
  const x = emuOf(xfrm, "off", "x");
  const y = emuOf(xfrm, "off", "y");
  const cx = emuOf(xfrm, "ext", "cx");
  const cy = emuOf(xfrm, "ext", "cy");
  if (x === null || y === null || cx === null || cy === null) return null;
  return { x, y, cx, cy, rot: Number(attrOf(xfrm, "rot")) || 0 };
}

/** Maps raw child-space EMU into absolute slide EMU: `abs = t + (raw − ch) · s`.
 *  Identity at the top level; group shapes compose their chOff/chExt onto it. */
interface GroupMap {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  chx: number;
  chy: number;
}

const IDENTITY_MAP: GroupMap = { tx: 0, ty: 0, sx: 1, sy: 1, chx: 0, chy: 0 };

/** Compose a `p:grpSp`'s transform onto the incoming map, so its children's
 *  raw xfrms land in absolute slide EMU. A group without a complete transform
 *  (or with a degenerate child extent) flattens: children are treated as
 *  already-absolute, which keeps them visible even if misplaced. */
function groupChildMap(grp: Element, map: GroupMap): GroupMap {
  const pr = childOf(grp, "grpSpPr");
  const xfrm = pr && childOf(pr, "xfrm");
  if (!pr || !xfrm) return map;
  const off = xfrmOf(pr);
  const chx = emuOf(xfrm, "chOff", "x");
  const chy = emuOf(xfrm, "chOff", "y");
  const chCx = emuOf(xfrm, "chExt", "cx");
  const chCy = emuOf(xfrm, "chExt", "cy");
  if (!off || chx === null || chy === null || !chCx || !chCy || chCx < 0 || chCy < 0) return map;
  return {
    tx: map.tx + (off.x - map.chx) * map.sx,
    ty: map.ty + (off.y - map.chy) * map.sy,
    sx: map.sx * (off.cx / chCx),
    sy: map.sy * (off.cy / chCy),
    chx,
    chy,
  };
}

/** Percent of a span, kept to 2 decimals — plenty for slide geometry. */
const pct = (value: number, total: number) => Math.round((value / total) * 10000) / 100;

// --- embedded media --------------------------------------------------------------

/** Cap on the total base64 characters emitted for pictures — decks full of
 *  photos would otherwise balloon the artifact; media past the budget is
 *  skipped silently. */
const MEDIA_BASE64_BUDGET = 12 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
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

/** Resolves `ppt/media/*` entries to data URLs, spending a shared base64
 *  budget across the whole deck. Unresolvable or over-budget → null. */
class MediaResolver {
  private used = 0;

  constructor(private readonly entries: Map<string, Uint8Array>) {}

  dataUrl(entryName: string): string | null {
    const bytes = this.entries.get(entryName);
    if (!bytes) return null;
    // Pre-check with the exact base64 length (4 chars per 3 bytes, padded) so
    // an over-budget image is never even encoded.
    const base64Length = Math.ceil(bytes.length / 3) * 4;
    if (this.used + base64Length > MEDIA_BASE64_BUDGET) return null;
    this.used += base64Length;
    const ext = /\.([^.]+)$/.exec(entryName)?.[1]?.toLowerCase() ?? "";
    return `data:${MIME_BY_EXT[ext] ?? "image/png"};base64,${bytesToBase64(bytes)}`;
  }
}

// --- shape tree → elements -------------------------------------------------------

/** Per-slide context the shape-tree walker consults. */
interface SlideContext {
  slideCx: number;
  slideCy: number;
  rels: Map<string, Rel>;
  media: MediaResolver;
  nextId(): string;
}

/** Percent box (x/y/w/h) for an absolute-EMU rectangle. */
function toPercentBox(xfrm: Xfrm, map: GroupMap, ctx: SlideContext) {
  return {
    x: pct(map.tx + (xfrm.x - map.chx) * map.sx, ctx.slideCx),
    y: pct(map.ty + (xfrm.y - map.chy) * map.sy, ctx.slideCy),
    w: pct(xfrm.cx * map.sx, ctx.slideCx),
    h: pct(xfrm.cy * map.sy, ctx.slideCy),
  };
}

/** Rotation in degrees from an xfrm's 60000ths-of-a-degree `rot`, or undefined. */
function rotationOf(xfrm: Xfrm): number | undefined {
  if (!xfrm.rot) return undefined;
  const deg = Math.round((xfrm.rot / 60000) * 100) / 100;
  return deg || undefined;
}

/** `#RRGGBB` of a direct `a:solidFill > a:srgbClr`, or undefined. Theme-indexed
 *  colors (`a:schemeClr`) resolve through the theme part — out of scope, so
 *  they stay unset and the renderer's defaults apply. */
function solidFillColor(el: Element | null): string | undefined {
  const fill = el && childOf(el, "solidFill");
  const val = fill && attrOf(childOf(fill, "srgbClr") ?? fill, "val");
  return val && /^[0-9a-fA-F]{6}$/.test(val) ? `#${val.toUpperCase()}` : undefined;
}

/** Text of a `p:txBody`: paragraphs (`a:p`) joined with \n, runs' `a:t`
 *  concatenated, `a:br` as an in-paragraph newline. Fields and everything
 *  else are ignored. */
function txBodyText(txBody: Element): string {
  const paras: string[] = [];
  for (const p of Array.from(txBody.children)) {
    if (p.localName !== "p") continue;
    let line = "";
    for (const c of Array.from(p.children)) {
      if (c.localName === "r") line += childOf(c, "t")?.textContent ?? "";
      else if (c.localName === "br") line += "\n";
    }
    paras.push(line);
  }
  return paras.join("\n");
}

/** The `p:ph type` of a shape's non-visual props, or null when it's not a
 *  placeholder. A `p:ph` without a type is a body placeholder per the spec. */
function placeholderType(sp: Element): string | null {
  for (const nv of Array.from(sp.children)) {
    if (!/^nv(Sp|Pic|GrpSp|Cxn)Pr$/.test(nv.localName ?? "")) continue;
    const ph = childOf(nv, "nvPr") && childOf(childOf(nv, "nvPr")!, "ph");
    if (ph) return attrOf(ph, "type") ?? "body";
  }
  return null;
}

/** Default boxes for placeholders that inherit their transform from the
 *  layout/master (which we don't parse): a conventional title band and body
 *  area, in percent. */
const TITLE_BOX = { x: 8, y: 10, w: 84, h: 18 };
const BODY_BOX = { x: 8, y: 32, w: 84, h: 55 };

/** A `p:sp` whose txBody has text → a text element. Style comes from the
 *  FIRST run's `a:rPr` (size in centipoints, bold flag, explicit srgb color)
 *  and the first paragraph's `a:pPr algn`. */
function textElement(sp: Element, txBody: Element, map: GroupMap, ctx: SlideContext): SlideElement {
  const spPr = childOf(sp, "spPr");
  const xfrm = spPr && xfrmOf(spPr);
  const box = xfrm
    ? toPercentBox(xfrm, map, ctx)
    : /^(title|ctrTitle)$/.test(placeholderType(sp) ?? "") ? { ...TITLE_BOX } : { ...BODY_BOX };
  const el: SlideElement = { id: ctx.nextId(), type: "text", ...box, text: txBodyText(txBody) };

  const firstP = childOf(txBody, "p");
  const firstRun = firstP && childOf(firstP, "r");
  const rPr = firstRun && childOf(firstRun, "rPr");
  if (rPr) {
    const sz = Number(attrOf(rPr, "sz"));
    if (Number.isFinite(sz) && sz > 0) el.fontSize = sz / 100; // centipoints → pt
    const b = attrOf(rPr, "b");
    if (b === "1" || b === "true") el.bold = true;
    const color = solidFillColor(rPr);
    if (color) el.color = color;
  }
  const algn = firstP && childOf(firstP, "pPr") ? attrOf(childOf(firstP, "pPr")!, "algn") : null;
  const align = algn === "l" ? "left" : algn === "ctr" ? "center" : algn === "r" ? "right" : undefined;
  if (align) el.align = align;
  if (xfrm) el.rotate = rotationOf(xfrm);
  return el;
}

/** A text-less `p:sp` with a preset geometry (or a `p:cxnSp` connector) → a
 *  shape element. Fill is the spPr's own solid fill; a line's color is its
 *  outline (`a:ln`) fill. Shapes without an explicit transform are skipped. */
function shapeElement(sp: Element, map: GroupMap, ctx: SlideContext, isConnector: boolean): SlideElement | null {
  const spPr = childOf(sp, "spPr");
  const xfrm = spPr && xfrmOf(spPr);
  if (!spPr || !xfrm) return null;
  const prst = attrOf(childOf(spPr, "prstGeom") ?? spPr, "prst");
  if (!prst && !isConnector) return null;

  const shape: SlideElement["shape"] =
    isConnector || prst === "line" || prst === "straightConnector1" ? "line"
    : prst === "ellipse" ? "ellipse"
    : "rect";
  const el: SlideElement = { id: ctx.nextId(), type: "shape", shape, ...toPercentBox(xfrm, map, ctx) };

  const ln = childOf(spPr, "ln");
  const fill = shape === "line" ? solidFillColor(ln) ?? solidFillColor(spPr) : solidFillColor(spPr);
  if (fill) el.fill = fill;
  if (prst === "roundRect") el.radius = 8;
  el.rotate = rotationOf(xfrm);
  return el;
}

/** A `p:pic` → an image element: `a:blip r:embed` through the slide's rels to
 *  a media entry, inlined as a data URL. Unresolvable, over-budget, or
 *  transform-less pictures are skipped. */
function pictureElement(pic: Element, map: GroupMap, ctx: SlideContext): SlideElement | null {
  const spPr = childOf(pic, "spPr");
  const xfrm = spPr && xfrmOf(spPr);
  if (!spPr || !xfrm) return null;
  const blip = childOf(pic, "blipFill") && childOf(childOf(pic, "blipFill")!, "blip");
  const embed = blip && attrOf(blip, "embed");
  const rel = embed ? ctx.rels.get(embed) : undefined;
  const src = rel ? ctx.media.dataUrl(rel.target) : null;
  if (!src) return null;
  const el: SlideElement = { id: ctx.nextId(), type: "image", ...toPercentBox(xfrm, map, ctx), src };
  el.rotate = rotationOf(xfrm);
  return el;
}

/** Walk a shape tree in document order, recursing into groups with their
 *  composed transform. Tables/charts/SmartArt live in `p:graphicFrame` and are
 *  skipped silently. */
function collectElements(tree: Element, map: GroupMap, ctx: SlideContext, out: SlideElement[]): void {
  for (const child of Array.from(tree.children)) {
    if (child.localName === "sp") {
      const txBody = childOf(child, "txBody");
      const el = txBody && txBodyText(txBody).trim()
        ? textElement(child, txBody, map, ctx)
        : shapeElement(child, map, ctx, false);
      if (el) out.push(el);
    } else if (child.localName === "cxnSp") {
      const el = shapeElement(child, map, ctx, true);
      if (el) out.push(el);
    } else if (child.localName === "pic") {
      const el = pictureElement(child, map, ctx);
      if (el) out.push(el);
    } else if (child.localName === "grpSp") {
      collectElements(child, groupChildMap(child, map), ctx, out);
    }
  }
}

// --- notes -----------------------------------------------------------------------

/** Placeholder types on a notes slide that aren't the speaker's text. */
const NOTES_CHROME = /^(sldNum|sldImg|hdr|ftr|dt)$/;

/** Speaker notes for a slide: its notesSlide rel (or the numeric twin under
 *  `ppt/notesSlides/`) → the text of every non-chrome shape. */
function notesFor(entries: Map<string, Uint8Array>, slideName: string, rels: Map<string, Rel>): string | undefined {
  let notesName: string | undefined;
  for (const rel of rels.values()) {
    if (/\/notesSlide$/.test(rel.type)) { notesName = rel.target; break; }
  }
  if (!notesName) {
    const num = /(\d+)\.xml$/.exec(slideName)?.[1];
    if (num) notesName = `ppt/notesSlides/notesSlide${num}.xml`;
  }
  const part = notesName ? entries.get(notesName) : undefined;
  const doc = part ? parseXml(new TextDecoder().decode(part)) : null;
  if (!doc) return undefined;

  const texts: string[] = [];
  for (const sp of Array.from(doc.getElementsByTagNameNS("*", "sp"))) {
    if (NOTES_CHROME.test(placeholderType(sp) ?? "")) continue;
    const txBody = childOf(sp, "txBody");
    const text = txBody ? txBodyText(txBody).trim() : "";
    if (text) texts.push(text);
  }
  return texts.length ? texts.join("\n") : undefined;
}

// --- deck ------------------------------------------------------------------------

/** Slide part names in presentation order: `p:sldIdLst` r:ids resolved through
 *  the package rels, falling back to numeric-sorted `ppt/slides/slideN.xml`
 *  when the list or rels are missing/unreadable. */
function orderedSlideNames(entries: Map<string, Uint8Array>): string[] {
  const presPart = entries.get("ppt/presentation.xml");
  const doc = presPart ? parseXml(new TextDecoder().decode(presPart)) : null;
  if (doc) {
    const rels = relsOf(entries, "ppt/presentation.xml");
    const names: string[] = [];
    for (const sldId of Array.from(doc.getElementsByTagNameNS("*", "sldId"))) {
      const rel = relIdOf(sldId) ? rels.get(relIdOf(sldId)!) : undefined;
      if (rel && entries.has(rel.target)) names.push(rel.target);
    }
    if (names.length) return names;
  }
  return [...entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
}

/** Slide size in EMU from `p:sldSz`, defaulting to PowerPoint's 16:9. */
function slideSizeOf(entries: Map<string, Uint8Array>): { cx: number; cy: number } {
  const presPart = entries.get("ppt/presentation.xml");
  const doc = presPart ? parseXml(new TextDecoder().decode(presPart)) : null;
  const sldSz = doc && doc.getElementsByTagNameNS("*", "sldSz")[0];
  const cx = sldSz ? Number(attrOf(sldSz, "cx")) : NaN;
  const cy = sldSz ? Number(attrOf(sldSz, "cy")) : NaN;
  return { cx: cx > 0 ? cx : DEFAULT_SLIDE_CX, cy: cy > 0 ? cy : DEFAULT_SLIDE_CY };
}

/** Convert a `.pptx` buffer to the native slides model (percent geometry). */
export async function pptxToSlides(buffer: ArrayBuffer): Promise<SlidesData> {
  const entries = await readZip(buffer);
  const names = orderedSlideNames(entries);
  if (!names.length) {
    throw new Error("PPTX 문서가 아닙니다 — 슬라이드(ppt/slides)가 없습니다 (Not a PPTX document — no slides found).");
  }

  const { cx, cy } = slideSizeOf(entries);
  const media = new MediaResolver(entries);
  const decoder = new TextDecoder();
  let seq = 0;

  const slides: Slide[] = [];
  for (const name of names) {
    const doc = parseXml(decoder.decode(entries.get(name)!));
    if (!doc) continue; // one corrupt slide shouldn't sink the deck
    const rels = relsOf(entries, name);
    const ctx: SlideContext = { slideCx: cx, slideCy: cy, rels, media, nextId: () => `el_${++seq}` };

    const elements: SlideElement[] = [];
    const spTree = doc.getElementsByTagNameNS("*", "spTree")[0];
    if (spTree) collectElements(spTree, IDENTITY_MAP, ctx, elements);

    const slide: Slide = { layout: "blank", elements };
    const cSld = doc.getElementsByTagNameNS("*", "cSld")[0];
    const bgPr = cSld && childOf(cSld, "bg") && childOf(childOf(cSld, "bg")!, "bgPr");
    const background = bgPr ? solidFillColor(bgPr) : undefined;
    if (background) slide.background = background;
    const notes = notesFor(entries, name, rels);
    if (notes) slide.notes = notes;
    slides.push(slide);
  }

  if (!slides.length) {
    throw new Error("PPTX 슬라이드 XML을 해석할 수 없습니다 (Not a readable PPTX — every slide failed to parse).");
  }
  return { slides };
}
