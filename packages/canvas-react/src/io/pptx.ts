/**
 * `.pptx` (OOXML PresentationML) → native `slides` import, dependency-free.
 *
 * A PPTX file is a ZIP of XML parts: `ppt/presentation.xml` declares the slide
 * size (`p:sldSz`, in EMU — 914400 per inch) and the slide order
 * (`p:sldIdLst`, resolved to parts through the package rels), and each
 * `ppt/slides/slideN.xml` holds a shape tree (`p:spTree`) of text boxes,
 * pictures, and preset-geometry shapes. Everything maps onto the editor's own
 * model: percent-of-slide geometry on a "blank" layout, with pictures inlined
 * as data URLs and speaker notes pulled from the slide's notes part. Elements
 * are emitted in spTree document order (first = back), which is exactly the
 * renderer's array paint order — groups recurse in place and tables emit
 * their cells at the frame's position in the walk, so z-order survives.
 *
 * Fidelity beyond the shape tree itself comes from the deck's support parts,
 * resolved once per slide and consulted everywhere:
 *
 * - **Theme colors** — `ppt/theme/themeN.xml`'s `a:clrScheme` plus the
 *   master's `p:clrMap` resolve `a:schemeClr`/`a:sysClr` wherever a color is
 *   read (runs, fills, outlines, backgrounds). See {@link ColorScheme} for the
 *   transform approximations.
 * - **Placeholder inheritance** — a placeholder without its own transform
 *   takes the matching placeholder's xfrm from the slide's layout, then the
 *   layout's master (matched by `p:ph` type, else idx); runs without
 *   size/color walk the same chain's `lstStyle`s and finally the master's
 *   `p:txStyles`. The hardcoded title/body boxes remain the last fallback.
 * - **Backgrounds** — the slide's `p:bg`, else the layout's, else the
 *   master's; gradients and `a:bgRef` theme fills flatten to a single color.
 *
 * A text box whose paragraphs disagree on resolved size (or mix bullets with
 * plain lines) is split into stacked per-paragraph elements — the model holds
 * one style per element — with heights allocated by estimated line counts.
 * Tables (`a:tbl` in a `p:graphicFrame`) become a best-effort per-cell grid.
 *
 * The container goes through the shared zero-dependency ZIP reader from the
 * HWPX importer, and the XML through `DOMParser`. Namespace prefixes are
 * matched by `localName`, so files that bind `p:`/`a:` differently still
 * parse. Still out of scope (skipped silently): charts, SmartArt, picture
 * fills, gradient rendering beyond the flattened color, and non-rectangular
 * geometry — `a:custGeom` freeforms and exotic presets have no model
 * equivalent, and a lost ribbon decoration reads far better than a giant
 * solid rectangle over the content. Group shapes are recursed into, children
 * remapped through the group's chOff/chExt transform.
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

/** OOXML boolean attribute ("1"/"true"). */
const isOn = (value: string | null) => value === "1" || value === "true";

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

/** First relationship whose Type ends with the given suffix (`/slideLayout`). */
function relOfType(rels: Map<string, Rel>, suffix: string): Rel | undefined {
  for (const rel of rels.values()) if (rel.type.endsWith(suffix)) return rel;
  return undefined;
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

/** The `a:xfrm` of an `spPr`/`grpSpPr`/`graphicFrame`, or null when
 *  offset/extent is missing. */
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

/** Two decimals — plenty for slide geometry. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Percent of a span, kept to 2 decimals. */
const pct = (value: number, total: number) => round2((value / total) * 100);

// --- theme colors ----------------------------------------------------------------

/** Spec-default placeholder→scheme indirection; a master's `p:clrMap`
 *  overrides (and adds the accent/hlink identities). */
const DEFAULT_CLR_MAP: ReadonlyArray<readonly [string, string]> = [
  ["bg1", "lt1"],
  ["tx1", "dk1"],
  ["bg2", "lt2"],
  ["tx2", "dk2"],
];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const byteHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** #-less RRGGBB → [r, g, b]. */
function rgbOf(hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** sRGB (0–255) → HSL (0–1). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6
    : max === g ? ((b - r) / d + 2) / 6
    : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

/** HSL (0–1) → sRGB (0–255). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

/**
 * Theme color resolution: the theme's `a:clrScheme` (dk1…folHlink → RRGGBB)
 * plus the master's `p:clrMap` (bg1/tx1/bg2/tx2 indirection). `resolve` takes
 * one color element (`a:srgbClr`, `a:sysClr` via its `lastClr`, or
 * `a:schemeClr` through the map and scheme) and returns `#RRGGBB`, honoring
 * the child transforms PowerPoint's theme variants use — approximately:
 *
 * - `lumMod`/`lumOff` scale/offset HSL lightness. The spec works in
 *   linear-gamma luminance; the sRGB-space stand-in is indistinguishable at
 *   UI-color distances.
 * - `tint`/`shade` blend each channel linearly toward white/black.
 *
 * `alpha` and the remaining transforms are ignored (the model has no opacity).
 */
class ColorScheme {
  constructor(
    private readonly scheme: ReadonlyMap<string, string>,
    private readonly clrMap: ReadonlyMap<string, string>,
  ) {}

  resolve(clr: Element): string | undefined {
    let hex: string | null = null;
    if (clr.localName === "srgbClr") hex = attrOf(clr, "val");
    else if (clr.localName === "sysClr") hex = attrOf(clr, "lastClr");
    else if (clr.localName === "schemeClr") {
      const name = attrOf(clr, "val") ?? "";
      hex = this.scheme.get(this.clrMap.get(name) ?? name) ?? null;
    }
    if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;

    let [r, g, b] = rgbOf(hex);
    for (const t of Array.from(clr.children)) {
      const raw = Number(attrOf(t, "val"));
      if (!Number.isFinite(raw)) continue;
      const f = raw / 100000;
      if (t.localName === "lumMod" || t.localName === "lumOff") {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, s, clamp01(t.localName === "lumMod" ? l * f : l + f));
      } else if (t.localName === "tint") {
        r = r * f + 255 * (1 - f);
        g = g * f + 255 * (1 - f);
        b = b * f + 255 * (1 - f);
      } else if (t.localName === "shade") {
        r *= f;
        g *= f;
        b *= f;
      }
    }
    return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`.toUpperCase();
  }
}

/** `#RRGGBB` of a direct `a:solidFill`'s color child, resolved through the
 *  deck's theme (srgbClr, sysClr and schemeClr all supported). */
function solidFillColor(el: Element | null, colors: ColorScheme): string | undefined {
  const fill = el && childOf(el, "solidFill");
  if (!fill) return undefined;
  for (const c of Array.from(fill.children)) {
    const hex = colors.resolve(c);
    if (hex) return hex;
  }
  return undefined;
}

/** An `a:gradFill` flattened to its FIRST stop's color — the model has no
 *  gradients, so a plausible flat stand-in beats losing the fill entirely. */
function gradientFirstStop(el: Element | null, colors: ColorScheme): string | undefined {
  const grad = el && childOf(el, "gradFill");
  const lst = grad && childOf(grad, "gsLst");
  const gs = lst && childOf(lst, "gs");
  if (!gs) return undefined;
  for (const c of Array.from(gs.children)) {
    const hex = colors.resolve(c);
    if (hex) return hex;
  }
  return undefined;
}

/** Color of a `p:style` reference (`a:fillRef`/`a:lnRef`/`a:fontRef`). The
 *  theme format the reference points at is approximated by its `phClr`
 *  argument — which IS the reference's color child. `idx="0"` means "no
 *  format", so it yields nothing. */
function styleRefColor(sp: Element, ref: string, colors: ColorScheme): string | undefined {
  const style = childOf(sp, "style");
  const refEl = style && childOf(style, ref);
  if (!refEl || attrOf(refEl, "idx") === "0") return undefined;
  for (const c of Array.from(refEl.children)) {
    const hex = colors.resolve(c);
    if (hex) return hex;
  }
  return undefined;
}

// --- layout / master / theme chain -----------------------------------------------

/** The support parts one slide inherits from: slide → layout (slide rels) →
 *  master (layout rels) → theme (master rels), each optional so a bare deck
 *  still imports. */
interface SlideChain {
  colors: ColorScheme;
  layoutTree: Element | null;
  masterTree: Element | null;
  layoutDoc: Document | null;
  masterDoc: Document | null;
  /** The master's `p:txStyles` (titleStyle/bodyStyle/otherStyle) — the last
   *  stop for placeholder run properties. */
  txStyles: Element | null;
}

/** Resolve a slide's layout/master/theme chain, parsing each support part at
 *  most once per deck (`cache` is shared across slides). */
function chainFor(
  entries: Map<string, Uint8Array>,
  slideRels: Map<string, Rel>,
  cache: Map<string, Document | null>,
): SlideChain {
  const load = (name: string | undefined): Document | null => {
    if (!name) return null;
    let doc = cache.get(name);
    if (doc === undefined) {
      const part = entries.get(name);
      doc = part ? parseXml(new TextDecoder().decode(part)) : null;
      cache.set(name, doc);
    }
    return doc;
  };
  const layoutName = relOfType(slideRels, "/slideLayout")?.target;
  const layoutDoc = load(layoutName);
  const masterName = layoutName ? relOfType(relsOf(entries, layoutName), "/slideMaster")?.target : undefined;
  const masterDoc = load(masterName);
  const themeDoc = masterName ? load(relOfType(relsOf(entries, masterName), "/theme")?.target) : null;

  const scheme = new Map<string, string>();
  const clrScheme = themeDoc?.getElementsByTagNameNS("*", "clrScheme")[0];
  for (const slot of Array.from(clrScheme?.children ?? [])) {
    const clr = slot.firstElementChild;
    const hex = clr?.localName === "sysClr" ? attrOf(clr, "lastClr") : clr && attrOf(clr, "val");
    if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) scheme.set(slot.localName, hex);
  }
  const clrMap = new Map(DEFAULT_CLR_MAP);
  const clrMapEl = masterDoc?.getElementsByTagNameNS("*", "clrMap")[0];
  for (const a of Array.from(clrMapEl?.attributes ?? [])) clrMap.set(a.localName, a.value);

  const treeOf = (doc: Document | null) => doc?.getElementsByTagNameNS("*", "spTree")[0] ?? null;
  return {
    colors: new ColorScheme(scheme, clrMap),
    layoutTree: treeOf(layoutDoc),
    masterTree: treeOf(masterDoc),
    layoutDoc,
    masterDoc,
    txStyles: masterDoc?.getElementsByTagNameNS("*", "txStyles")[0] ?? null,
  };
}

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
  chain: SlideChain;
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

// --- placeholders & style inheritance --------------------------------------------

/** A shape's `p:ph` type/idx, or null when it's not a placeholder. A `p:ph`
 *  without a type is a body placeholder per the spec. */
function placeholderOf(sp: Element): { type: string; idx: string | null } | null {
  for (const nv of Array.from(sp.children)) {
    if (!/^nv(Sp|Pic|GrpSp|Cxn|GraphicFrame)Pr$/.test(nv.localName ?? "")) continue;
    const nvPr = childOf(nv, "nvPr");
    const ph = nvPr && childOf(nvPr, "ph");
    if (ph) return { type: attrOf(ph, "type") ?? "body", idx: attrOf(ph, "idx") };
  }
  return null;
}

/** The `p:ph type` of a shape's non-visual props, or null. */
function placeholderType(sp: Element): string | null {
  return placeholderOf(sp)?.type ?? null;
}

/** The layout/master shape a slide placeholder inherits from: same `type`
 *  first, else same `idx` (layouts routinely reindex, so type wins). */
function findPlaceholder(tree: Element | null, want: { type: string; idx: string | null }): Element | null {
  if (!tree) return null;
  const shapes = Array.from(tree.getElementsByTagNameNS("*", "sp"));
  for (const sp of shapes) if (placeholderOf(sp)?.type === want.type) return sp;
  if (want.idx !== null) {
    for (const sp of shapes) if (placeholderOf(sp)?.idx === want.idx) return sp;
  }
  return null;
}

/** A placeholder's transform from its layout, then master, counterpart. */
function inheritedXfrm(sp: Element, ctx: SlideContext): Xfrm | null {
  const ph = placeholderOf(sp);
  if (!ph) return null;
  for (const tree of [ctx.chain.layoutTree, ctx.chain.masterTree]) {
    const match = findPlaceholder(tree, ph);
    const spPr = match && childOf(match, "spPr");
    const xfrm = spPr && xfrmOf(spPr);
    if (xfrm) return xfrm;
  }
  return null;
}

/** `lstStyle`-shaped sources for a shape's paragraph styles, nearest first:
 *  the shape's own `txBody > a:lstStyle`, the layout placeholder's, the
 *  master placeholder's, and finally the master `p:txStyles` bucket for the
 *  placeholder kind. Non-placeholder shapes only see their own lstStyle. */
function styleSources(sp: Element, txBody: Element, ctx: SlideContext): Element[] {
  const out: Element[] = [];
  const own = childOf(txBody, "lstStyle");
  if (own) out.push(own);
  const ph = placeholderOf(sp);
  if (!ph) return out;
  for (const tree of [ctx.chain.layoutTree, ctx.chain.masterTree]) {
    const match = findPlaceholder(tree, ph);
    const body = match && childOf(match, "txBody");
    const lstStyle = body && childOf(body, "lstStyle");
    if (lstStyle) out.push(lstStyle);
  }
  if (ctx.chain.txStyles) {
    const bucket =
      /^(title|ctrTitle)$/.test(ph.type) ? "titleStyle"
      : /^(body|subTitle|obj)$/.test(ph.type) ? "bodyStyle"
      : "otherStyle";
    const styles = childOf(ctx.chain.txStyles, bucket);
    if (styles) out.push(styles);
  }
  return out;
}

/** The `lvlNpPr` for a paragraph's level in one source, falling back to lvl1. */
function lvlPrOf(source: Element, lvl: number): Element | null {
  return childOf(source, `lvl${lvl + 1}pPr`) ?? childOf(source, "lvl1pPr");
}

/** Whether a paragraph renders a bullet: its own pPr first, then the
 *  inherited lvl styles — `buNone` stops the walk, `buChar`/`buAutoNum` win. */
function bulletOf(pPr: Element | null, sources: Element[], lvl: number): boolean {
  for (const el of [pPr, ...sources.map((s) => lvlPrOf(s, lvl))]) {
    if (!el) continue;
    if (childOf(el, "buNone")) return false;
    if (childOf(el, "buChar") || childOf(el, "buAutoNum")) return true;
  }
  return false;
}

/** One paragraph with its fully-resolved (run → defRPr → inherited) style. */
interface Paragraph {
  text: string;
  bullet: boolean;
  szCenti?: number;
  bold?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
}

/** Every `a:p` of a txBody with per-paragraph resolved style. Each property
 *  walks nearest-wins: the FIRST run's rPr, the paragraph's `pPr > defRPr`,
 *  then each inherited lstStyle's lvl `defRPr`; text color additionally falls
 *  back to the shape's theme `fontRef` (white-on-accent shape text). */
function paragraphsOf(txBody: Element, sp: Element, ctx: SlideContext): Paragraph[] {
  const colors = ctx.chain.colors;
  const sources = styleSources(sp, txBody, ctx);
  const shapeTextColor = styleRefColor(sp, "fontRef", colors);

  const out: Paragraph[] = [];
  for (const p of Array.from(txBody.children)) {
    if (p.localName !== "p") continue;
    let text = "";
    for (const c of Array.from(p.children)) {
      if (c.localName === "r") text += childOf(c, "t")?.textContent ?? "";
      else if (c.localName === "br") text += "\n";
    }
    const pPr = childOf(p, "pPr");
    const lvl = Math.max(0, Number(pPr && attrOf(pPr, "lvl")) || 0);
    const firstRun = childOf(p, "r");
    const rPr = firstRun && childOf(firstRun, "rPr");

    const props: Element[] = [];
    if (rPr) props.push(rPr);
    const pDef = pPr && childOf(pPr, "defRPr");
    if (pDef) props.push(pDef);
    for (const src of sources) {
      const lvlPr = lvlPrOf(src, lvl);
      const def = lvlPr && childOf(lvlPr, "defRPr");
      if (def) props.push(def);
    }

    const para: Paragraph = { text, bullet: bulletOf(pPr, sources, lvl) };
    for (const pr of props) {
      if (para.szCenti === undefined) {
        const sz = Number(attrOf(pr, "sz"));
        if (Number.isFinite(sz) && sz > 0) para.szCenti = sz;
      }
      if (para.bold === undefined && attrOf(pr, "b") !== null) para.bold = isOn(attrOf(pr, "b"));
      if (para.color === undefined) {
        const color = solidFillColor(pr, colors);
        if (color) para.color = color;
      }
    }
    if (para.color === undefined && shapeTextColor) para.color = shapeTextColor;

    for (const el of [pPr, ...sources.map((s) => lvlPrOf(s, lvl))]) {
      const algn = el && attrOf(el, "algn");
      if (!algn) continue;
      const align = algn === "l" ? "left" : algn === "ctr" ? "center" : algn === "r" ? "right" : undefined;
      if (align) para.align = align;
      break; // nearest algn decides, mapped or not
    }
    out.push(para);
  }
  return out;
}

// --- text ------------------------------------------------------------------------

/** Default boxes for placeholders whose transform resolves nowhere in the
 *  layout/master chain: a conventional title band and body area, in percent. */
const TITLE_BOX = { x: 8, y: 10, w: 84, h: 18 };
const BODY_BOX = { x: 8, y: 32, w: 84, h: 55 };

/** Paragraph-count guard: past this many paragraphs a split would explode the
 *  element budget, so the box stays a single element. */
const MAX_SPLIT_PARAGRAPHS = 8;

/** Line-count estimation: the renderer's 16:9 design canvas, and an average
 *  glyph advance of 0.6 em — a compromise between Latin (~0.5 em) and CJK
 *  (1 em) that only has to rank/bound paragraphs, not typeset them. */
const DESIGN_WIDTH_PX = 1280;
const DESIGN_HEIGHT_PX = 720;
const AVG_CHAR_EM = 0.6;

/** Design-px stand-in for paragraphs whose size never resolves (≈ the
 *  renderer's 18 pt default). */
const DEFAULT_PARA_PX = 24;

/** Overflow guard: our text wraps wider than PowerPoint's (especially Korean),
 *  so text authored to exactly fit clips at the box bottom. When a box has no
 *  explicit autofit and the estimated wrapped height (estimated lines × size
 *  × 1.3 line-height) exceeds the box by >15%, the emitted size shrinks to
 *  fit — floored at 60% of the original. */
const LINE_HEIGHT = 1.3;
const OVERFLOW_TOLERANCE = 1.15;
const OVERFLOW_MIN_SCALE = 0.6;

/** Estimated rendered line count of one text block in a box `boxWPct` wide. */
function estimatedLines(text: string, sizePx: number, boxWPct: number): number {
  const widthPx = Math.max(1, (boxWPct / 100) * DESIGN_WIDTH_PX);
  const perLine = Math.max(1, Math.floor(widthPx / (sizePx * AVG_CHAR_EM)));
  let lines = 0;
  for (const seg of text.split("\n")) lines += Math.max(1, Math.ceil(seg.length / perLine));
  return lines;
}

/** Shrink a font size so the estimated wrapped height fits the box (see the
 *  overflow-guard constants). */
function fitFontPx(sizePx: number, text: string, boxWPct: number, boxHPct: number): number {
  const estimated = estimatedLines(text, sizePx, boxWPct) * sizePx * LINE_HEIGHT;
  const boxPx = (boxHPct / 100) * DESIGN_HEIGHT_PX;
  if (boxPx <= 0 || estimated <= boxPx * OVERFLOW_TOLERANCE) return sizePx;
  const scale = Math.max(OVERFLOW_MIN_SCALE, boxPx / estimated);
  return Math.max(6, Math.round(sizePx * scale));
}

/** Centipoints → design px: pt → px (×4/3 at 96 dpi) at the renderer's
 *  1280-wide design on a 13.33-inch / 12192000-EMU slide; other slide widths
 *  are normalized so text keeps its proportion of the slide. */
function fontPx(szCenti: number, fontScale: number, ctx: SlideContext): number {
  return Math.max(6, Math.round((szCenti / 100) * fontScale * (4 / 3) * (12192000 / ctx.slideCx)));
}

/** A `p:sp` whose txBody has text → text element(s). Style resolves per
 *  paragraph through the placeholder chain; a box whose paragraphs disagree
 *  on resolved size (or mix bullets with plain lines) splits into stacked
 *  elements, each given a height slice proportional to its estimated line
 *  count × size. Rotated boxes never split (per-element rotation about each
 *  slice's own center would tear the box apart). */
function textElements(sp: Element, txBody: Element, map: GroupMap, ctx: SlideContext): SlideElement[] {
  const spPr = childOf(sp, "spPr");
  const xfrm = (spPr && xfrmOf(spPr)) ?? inheritedXfrm(sp, ctx);
  const box = xfrm
    ? toPercentBox(xfrm, map, ctx)
    : /^(title|ctrTitle)$/.test(placeholderType(sp) ?? "") ? { ...TITLE_BOX } : { ...BODY_BOX };
  const rotate = xfrm ? rotationOf(xfrm) : undefined;

  // PowerPoint's shrink-on-overflow autofit scales rendered text down —
  // ignoring it is how imported decks overflowed their boxes.
  const bodyPr = childOf(txBody, "bodyPr");
  const autofit = bodyPr ? childOf(bodyPr, "normAutofit") ?? childOf(bodyPr, "spAutoFit") : null;
  const rawScale = autofit ? Number(attrOf(autofit, "fontScale")) : NaN;
  const fontScale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale / 100000 : 1;
  // Only un-autofitted boxes get the wrap-overflow guard; autofitted ones
  // already carry PowerPoint's own shrink factor.
  const guard = (sizePx: number, text: string, hPct: number) =>
    autofit ? sizePx : fitFontPx(sizePx, text, box.w, hPct);

  const paras = paragraphsOf(txBody, sp, ctx).map((p) => ({
    ...p,
    px: p.szCenti !== undefined ? fontPx(p.szCenti, fontScale, ctx) : undefined,
  }));
  const filled = paras.filter((p) => p.text.trim());

  const apply = (el: SlideElement, p: (typeof paras)[number]) => {
    if (p.px !== undefined) el.fontSize = p.px;
    if (p.bold) el.bold = true;
    if (p.color) el.color = p.color;
    if (p.align) el.align = p.align;
  };

  const distinctSizes = new Set(filled.map((p) => p.px ?? DEFAULT_PARA_PX));
  const mixedBullets = new Set(filled.map((p) => p.bullet)).size > 1;
  const split =
    filled.length >= 2 &&
    paras.length <= MAX_SPLIT_PARAGRAPHS &&
    rotate === undefined &&
    (distinctSizes.size > 1 || mixedBullets);

  if (!split) {
    const el: SlideElement = {
      id: ctx.nextId(),
      type: "text",
      ...box,
      text: paras.map((p) => (p.bullet && p.text.trim() ? `• ${p.text}` : p.text)).join("\n"),
    };
    const lead = filled[0] ?? paras[0];
    if (lead) apply(el, lead);
    if (el.fontSize !== undefined && el.text) el.fontSize = guard(el.fontSize, el.text, box.h);
    if (rotate !== undefined) el.rotate = rotate;
    return [el];
  }

  // Height slices ∝ estimated lines × size; empty paragraphs keep their slice
  // as spacing but emit no element.
  const weights = paras.map((p) => estimatedLines(p.text, p.px ?? DEFAULT_PARA_PX, box.w) * (p.px ?? DEFAULT_PARA_PX));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: SlideElement[] = [];
  let used = 0;
  paras.forEach((p, i) => {
    const y = box.y + (box.h * used) / total;
    used += weights[i];
    if (!p.text.trim()) return;
    const el: SlideElement = {
      id: ctx.nextId(),
      type: "text",
      x: box.x,
      y: round2(y),
      w: box.w,
      h: round2((box.h * weights[i]) / total),
      text: p.bullet ? `• ${p.text}` : p.text,
    };
    apply(el, p);
    if (el.fontSize !== undefined) el.fontSize = guard(el.fontSize, el.text ?? "", el.h);
    out.push(el);
  });
  return out;
}

// --- shapes & pictures -----------------------------------------------------------

/** The preset-geometry family the model can actually draw. Everything else —
 *  `a:custGeom` freeforms and exotic presets (blockArc, pie, chevron, wave,
 *  ribbons, …) — is skipped entirely: flattening a decorative freeform into a
 *  filled rectangle used to bury half the slide under a solid slab. */
function mappableShapeOf(prst: string | null, isConnector: boolean): SlideElement["shape"] | null {
  if (isConnector) return "line";
  if (!prst) return null;
  if (prst === "line" || /^straightConnector\d*$/.test(prst)) return "line";
  if (prst === "ellipse" || prst === "oval") return "ellipse";
  if (prst === "rect" || prst === "roundRect") return "rect";
  return null;
}

/** A text-less `p:sp` with a mappable preset geometry (or a `p:cxnSp`
 *  connector) → a shape element. Fill order: own solid fill, flattened
 *  gradient, then the shape's theme `fillRef`; a line's color is its outline
 *  (`a:ln`) fill, then `lnRef`. Placeholders may inherit their transform from
 *  the layout/master; other transform-less shapes are skipped. */
function shapeElement(sp: Element, map: GroupMap, ctx: SlideContext, isConnector: boolean): SlideElement | null {
  const colors = ctx.chain.colors;
  const spPr = childOf(sp, "spPr");
  const xfrm = spPr && (xfrmOf(spPr) ?? inheritedXfrm(sp, ctx));
  if (!spPr || !xfrm) return null;
  const prst = attrOf(childOf(spPr, "prstGeom") ?? spPr, "prst");
  const shape = mappableShapeOf(prst, isConnector);
  if (!shape) return null;

  const el: SlideElement = { id: ctx.nextId(), type: "shape", shape, ...toPercentBox(xfrm, map, ctx) };

  const ln = childOf(spPr, "ln");
  const areaFill = childOf(spPr, "noFill")
    ? undefined
    : solidFillColor(spPr, colors) ?? gradientFirstStop(spPr, colors) ?? styleRefColor(sp, "fillRef", colors);
  const lineFill =
    (ln && !childOf(ln, "noFill") ? solidFillColor(ln, colors) : undefined) ?? styleRefColor(sp, "lnRef", colors);
  const fill = shape === "line" ? lineFill ?? areaFill : areaFill;
  if (fill) el.fill = fill;
  if (prst === "roundRect") el.radius = 8;
  el.rotate = rotationOf(xfrm);
  return el;
}

/** A `p:pic` → an image element: `a:blip r:embed` through the slide's rels to
 *  a media entry, inlined as a data URL. Unresolvable, over-budget, or
 *  transform-less (even after placeholder inheritance) pictures are skipped. */
function pictureElement(pic: Element, map: GroupMap, ctx: SlideContext): SlideElement | null {
  const spPr = childOf(pic, "spPr");
  const xfrm = (spPr && xfrmOf(spPr)) ?? inheritedXfrm(pic, ctx);
  if (!xfrm) return null;
  const blip = childOf(pic, "blipFill") && childOf(childOf(pic, "blipFill")!, "blip");
  const embed = blip && attrOf(blip, "embed");
  const rel = embed ? ctx.rels.get(embed) : undefined;
  const src = rel ? ctx.media.dataUrl(rel.target) : null;
  if (!src) return null;
  const el: SlideElement = { id: ctx.nextId(), type: "image", ...toPercentBox(xfrm, map, ctx), src };
  el.rotate = rotationOf(xfrm);
  return el;
}

// --- tables ----------------------------------------------------------------------

/** Past this many cells a per-cell grid would blow the element budget, so the
 *  table collapses to one tab/newline text block. */
const MAX_TABLE_CELL_ELEMENTS = 60;

/** Table text stays small: resolved sizes are capped here, unsized cells get
 *  the default. */
const TABLE_FONT_PX_CAP = 14;
const TABLE_FONT_PX_DEFAULT = 12;

/** Plain text of one table cell (paragraphs joined). */
function cellText(tc: Element): string {
  const txBody = childOf(tc, "txBody");
  return txBody ? txBodyText(txBody).trim() : "";
}

/** A `p:graphicFrame`'s `a:tbl` → a best-effort grid of per-cell text
 *  elements: geometry from `a:gridCol` widths × `a:tr` heights inside the
 *  frame's box, merged-away cells (`hMerge`/`vMerge`) skipped, `gridSpan`
 *  widening its cell. Cells are emitted row-major, which is their document
 *  order. Charts and SmartArt (other `p:graphicFrame` payloads) are still
 *  skipped, and a malformed table degrades to nothing rather than sinking
 *  the whole deck. */
function tableElements(frame: Element, map: GroupMap, ctx: SlideContext): SlideElement[] {
  try {
    return tableGrid(frame, map, ctx);
  } catch {
    return [];
  }
}

function tableGrid(frame: Element, map: GroupMap, ctx: SlideContext): SlideElement[] {
  const graphic = childOf(frame, "graphic");
  const data = graphic && childOf(graphic, "graphicData");
  const tbl = data && childOf(data, "tbl");
  const xfrm = xfrmOf(frame);
  if (!tbl || !xfrm) return [];
  const box = toPercentBox(xfrm, map, ctx);

  const rows = Array.from(tbl.children).filter((c) => c.localName === "tr");
  const cellsOf = (tr: Element) => Array.from(tr.children).filter((c) => c.localName === "tc");
  if (!rows.length) return [];

  const grid = childOf(tbl, "tblGrid");
  const colWidths = Array.from(grid?.children ?? [])
    .filter((c) => c.localName === "gridCol")
    .map((c) => Math.max(0, Number(attrOf(c, "w")) || 0));
  const colCount = colWidths.length || Math.max(...rows.map((r) => cellsOf(r).length));
  if (!colCount || !Number.isFinite(colCount)) return [];

  if (rows.length * colCount > MAX_TABLE_CELL_ELEMENTS) {
    const text = rows.map((r) => cellsOf(r).map(cellText).join("\t")).join("\n").trim();
    if (!text) return [];
    return [{ id: ctx.nextId(), type: "text", ...box, text, fontSize: TABLE_FONT_PX_DEFAULT }];
  }

  const colSum = colWidths.reduce((a, b) => a + b, 0);
  const colFrac: number[] = colSum > 0 ? colWidths.map((w) => w / colSum) : Array(colCount).fill(1 / colCount);
  const rowHeights = rows.map((r) => Math.max(0, Number(attrOf(r, "h")) || 0));
  const rowSum = rowHeights.reduce((a, b) => a + b, 0);
  const rowFrac = rowSum > 0 ? rowHeights.map((h) => h / rowSum) : rows.map(() => 1 / rows.length);

  const out: SlideElement[] = [];
  let yFrac = 0;
  rows.forEach((tr, ri) => {
    let col = 0;
    for (const tc of cellsOf(tr)) {
      const span = Math.max(1, Number(attrOf(tc, "gridSpan")) || 1);
      const from = col;
      col += span;
      if (isOn(attrOf(tc, "hMerge")) || isOn(attrOf(tc, "vMerge")) || from >= colCount) continue;
      const text = cellText(tc);
      if (!text) continue;
      const xFrac = colFrac.slice(0, from).reduce((a, b) => a + b, 0);
      const wFrac = colFrac.slice(from, Math.min(from + span, colCount)).reduce((a, b) => a + b, 0);
      const el: SlideElement = {
        id: ctx.nextId(),
        type: "text",
        x: round2(box.x + box.w * xFrac),
        y: round2(box.y + box.h * yFrac),
        w: round2(box.w * wFrac),
        h: round2(box.h * rowFrac[ri]),
        text,
      };
      // Cell style from the first non-empty paragraph, via the same
      // theme-aware chain (an `a:tc` is no placeholder, so only run/defRPr
      // and the cell's own lstStyle apply).
      const txBody = childOf(tc, "txBody");
      const para = txBody ? paragraphsOf(txBody, tc, ctx).find((p) => p.text.trim()) : undefined;
      const sizePx = para?.szCenti !== undefined ? fontPx(para.szCenti, 1, ctx) : TABLE_FONT_PX_DEFAULT;
      el.fontSize = Math.min(sizePx, TABLE_FONT_PX_CAP);
      if (para?.bold) el.bold = true;
      if (para?.color) el.color = para.color;
      if (para?.align) el.align = para.align;
      out.push(el);
    }
    yFrac += rowFrac[ri];
  });
  return out;
}

// --- shape-tree walk -------------------------------------------------------------

/** Walk a shape tree in document order — the emitted array IS the paint order
 *  (first element = back), matching the renderer — recursing into groups with
 *  their composed transform. Tables become per-cell grids; charts/SmartArt
 *  (other `p:graphicFrame` payloads) are skipped silently. */
function collectElements(tree: Element, map: GroupMap, ctx: SlideContext, out: SlideElement[]): void {
  for (const child of Array.from(tree.children)) {
    if (child.localName === "sp") {
      const txBody = childOf(child, "txBody");
      if (txBody && txBodyText(txBody).trim()) {
        out.push(...textElements(child, txBody, map, ctx));
      } else {
        const el = shapeElement(child, map, ctx, false);
        if (el) out.push(el);
      }
    } else if (child.localName === "cxnSp") {
      const el = shapeElement(child, map, ctx, true);
      if (el) out.push(el);
    } else if (child.localName === "pic") {
      const el = pictureElement(child, map, ctx);
      if (el) out.push(el);
    } else if (child.localName === "graphicFrame") {
      out.push(...tableElements(child, map, ctx));
    } else if (child.localName === "grpSp") {
      collectElements(child, groupChildMap(child, map), ctx, out);
    }
  }
}

// --- background ------------------------------------------------------------------

/** Background color of one part's `p:bg`: `bgPr` solid fill, a gradient's
 *  first stop, or a `bgRef`'s theme color — the latter two flattened to one
 *  color (the model holds a single hex). */
function backgroundOf(doc: Document | null, colors: ColorScheme): string | undefined {
  const cSld = doc?.getElementsByTagNameNS("*", "cSld")[0];
  const bg = cSld ? childOf(cSld, "bg") : null;
  if (!bg) return undefined;
  const bgPr = childOf(bg, "bgPr");
  if (bgPr) return solidFillColor(bgPr, colors) ?? gradientFirstStop(bgPr, colors);
  const bgRef = childOf(bg, "bgRef");
  if (!bgRef || attrOf(bgRef, "idx") === "0") return undefined;
  for (const c of Array.from(bgRef.children)) {
    const hex = colors.resolve(c);
    if (hex) return hex;
  }
  return undefined;
}

// --- notes -----------------------------------------------------------------------

/** Placeholder types on a notes slide that aren't the speaker's text. */
const NOTES_CHROME = /^(sldNum|sldImg|hdr|ftr|dt)$/;

/** Speaker notes for a slide: its notesSlide rel (or the numeric twin under
 *  `ppt/notesSlides/`) → the text of every non-chrome shape. */
function notesFor(entries: Map<string, Uint8Array>, slideName: string, rels: Map<string, Rel>): string | undefined {
  let notesName = relOfType(rels, "/notesSlide")?.target;
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
  const partCache = new Map<string, Document | null>();
  const decoder = new TextDecoder();
  let seq = 0;

  const slides: Slide[] = [];
  for (const name of names) {
    const doc = parseXml(decoder.decode(entries.get(name)!));
    if (!doc) continue; // one corrupt slide shouldn't sink the deck
    const rels = relsOf(entries, name);
    const chain = chainFor(entries, rels, partCache);
    const ctx: SlideContext = { slideCx: cx, slideCy: cy, rels, media, chain, nextId: () => `el_${++seq}` };

    const elements: SlideElement[] = [];
    const spTree = doc.getElementsByTagNameNS("*", "spTree")[0];
    if (spTree) collectElements(spTree, IDENTITY_MAP, ctx, elements);

    const slide: Slide = { layout: "blank", elements };
    const background =
      backgroundOf(doc, chain.colors) ??
      backgroundOf(chain.layoutDoc, chain.colors) ??
      backgroundOf(chain.masterDoc, chain.colors);
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
