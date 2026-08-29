/**
 * Where a structured slide's text goes.
 *
 * A slide is either free-form — an explicit `elements` array someone dragged
 * into place — or structured: a `title`, some `bullets`, a `layout` name.
 * Structured slides are laid out here (with *deterministic* ids, so React keys
 * stay stable across renders), and `resolveElements` prefers the explicit
 * array once the user has edited. The renderer, the presenter, and every
 * exporter go through `resolveElements`, so there is one source of truth for
 * what is on a slide — and a deck written without a single coordinate still
 * arrives composed.
 *
 * This is the twin of `derive_elements` in
 * `canvas-py/src/langchain_canvas/slide_layout.py`. Both sides reproduce
 * `derivedLayout.golden.json`, and both test suites hold their side to it, so
 * the two cannot drift apart unnoticed.
 *
 * Type scale — one ~1.25 geometric run, so a deck never carries a size picked
 * at random:
 *
 * | display | 48 | the cover line, and a section break |
 * | title   | 38 | a slide heading |
 * | body    | 30 / 24 / 19 | the ramp a body block falls down |
 *
 * The body block: bullets are not stamped at a fixed pitch. Each is measured —
 * how many lines it wraps to at the size being tried — the largest body step
 * whose block fits the content band wins, and the room left over becomes the
 * space between them. Three short lines breathe, ten stay on the page, and
 * neither needs the agent to have thought about it.
 */

import type { Slide, SlideElement, SlidePage } from "../protocol/artifacts";
import { DEFAULT_SLIDE_PAGE_IN, PAGE_DPI } from "./slidePage";

export const FONT_DISPLAY = 48;
export const FONT_TITLE = 38;
/** Largest first — the layout takes the first step whose block fits. */
export const BODY_RAMP = [30, 24, 19];
/** A heading shrinks before it eats the slide it is heading. */
export const TITLE_RAMP = [FONT_TITLE, 30, 24];
/** A cover line shrinks the same way. */
export const DISPLAY_RAMP = [FONT_DISPLAY, FONT_TITLE, 30];

/** Line box over font size. The renderer, the print sheet, and PowerPoint all
 *  sit near this, so a box this tall holds its text at every destination. */
const LINE_HEIGHT = 1.35;
/** Space between bullets, as a multiple of the line box. The floor is what
 *  makes a body step count as comfortable; the ceiling stops a two-bullet
 *  slide from reading as two unrelated slides. */
const GAP_MIN = 0.35;
const GAP_MAX = 3.0;

/** The content band, in percent of the page: below the heading, above a bottom
 *  margin a little deeper than the top one. */
const BODY_TOP = 28;
const BODY_BOTTOM = 88;
const BODY_LEFT = 8;
const BODY_WIDTH = 84;

const TITLE_TOP = 7;
const TITLE_LEFT = 6;
const TITLE_WIDTH = 88;
/** How far down the page a heading may reach. Past this the body band would
 *  collapse, and a collapsed band is how a slide starts placing its bullets
 *  below the page — or, with a negative band, in reverse order. */
const TITLE_BOTTOM = 46;
/** A subtitle on a content slide gets a couple of lines, no more. */
const SUBTITLE_BUDGET = 12;
/** The cover's safe area, and how the two lines share it. */
const COVER_TOP = 6;
const COVER_BOTTOM = 94;
const COVER_TITLE_SHARE = 0.66;
const COVER_SUBTITLE_SHARE = 0.22;
const COLUMN_WIDTH = 42;
const COLUMN_RIGHT_LEFT = 52;

const BULLET = "• ";
/** Above this code point a glyph is about an em wide (Hangul, CJK, kana,
 *  fullwidth forms, emoji); below it, about half. Crude next to a real font
 *  metric, but it only has to decide *how many lines*, and both twins have to
 *  agree on the answer. */
const WIDE_CHAR_FLOOR = 0x2e7f;

function pagePx(page?: SlidePage): [number, number] {
  const fallback: [number, number] = [DEFAULT_SLIDE_PAGE_IN.widthIn * PAGE_DPI, DEFAULT_SLIDE_PAGE_IN.heightIn * PAGE_DPI];
  if (!page) return fallback;
  const { widthIn, heightIn } = page;
  if (!(widthIn > 0 && heightIn > 0)) return fallback;
  return [widthIn * PAGE_DPI, heightIn * PAGE_DPI];
}

/** Text width in half-em units. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) > WIDE_CHAR_FLOOR ? 2 : 1;
  return width;
}

/** One line box as a percent of the page height. */
export function linePercent(fontPx: number, pageHeightPx: number): number {
  return ((fontPx * LINE_HEIGHT) / pageHeightPx) * 100;
}

/** How many lines `text` takes in a box that wide, at that size. */
export function lineCount(text: string, widthPercent: number, fontPx: number, pageWidthPx: number): number {
  if (!text) return 1;
  const perLine = ((widthPercent / 100) * pageWidthPx) / (fontPx / 2);
  if (perLine < 1) return 1; // a box too narrow for one glyph; one line, and let it clip
  return Math.max(1, Math.ceil(displayWidth(text) / perLine));
}

/** The largest body step whose block fits the band, and its line counts. */
function fit(texts: string[], width: number, band: number, [pageW, pageH]: [number, number]): [number, number[]] {
  let size = BODY_RAMP[BODY_RAMP.length - 1];
  let counts: number[] = [];
  for (const candidate of BODY_RAMP) {
    size = candidate;
    counts = texts.map((t) => lineCount(t, width, candidate, pageW));
    const line = linePercent(candidate, pageH);
    const ink = counts.reduce((a, b) => a + b, 0) * line;
    const floorGap = GAP_MIN * line * Math.max(0, texts.length - 1);
    if (ink + floorGap <= band) return [candidate, counts];
  }
  return [size, counts];
}

/**
 * [font size, height] for one headline, inside a vertical budget.
 *
 * Steps down the ramp until the wrapped text fits the budget, and clamps the
 * box if even the smallest step does not. The clamp is what keeps a runaway
 * title from pushing the body band to zero — or below zero, where the bullets
 * came out reversed and off the page.
 */
function headline(
  text: string, width: number, budget: number, [pageW, pageH]: [number, number], ramp: number[],
): [number, number] {
  let size = ramp[ramp.length - 1];
  let height = 0;
  for (const candidate of ramp) {
    size = candidate;
    height = lineCount(text, width, candidate, pageW) * linePercent(candidate, pageH);
    if (height <= budget) return [candidate, height];
  }
  return [size, Math.min(height, budget)];
}

interface Box { x: number; y: number; w: number; h: number; fontSize: number }

/**
 * A box per line of text, laid into the band. The room left over is shared out
 * between the bullets up to a ceiling; past that the block is centred, so a
 * slide of two points sits on the band's middle instead of hanging from its top.
 */
function place(
  counts: number[], size: number,
  o: { top: number; bottom: number; left: number; width: number; pageHeightPx: number },
): Box[] {
  const n = counts.length;
  if (n === 0) return [];
  const band = o.bottom - o.top;
  const line = linePercent(size, o.pageHeightPx);
  const ink = counts.reduce((a, b) => a + b, 0) * line;

  if (ink > band) {
    // Too full for the smallest step. Tile the band evenly: the text may
    // crowd, but every bullet keeps a box on the page — the fixed pitch this
    // replaced simply walked off the bottom and took the last bullets with it.
    const pitch = band / n;
    return counts.map((_, i) => ({ x: o.left, y: o.top + i * pitch, w: o.width, h: pitch, fontSize: size }));
  }

  // Never let the floor push the block past the band — a tight slide closes
  // up rather than walking off the page.
  const gap = n > 1 ? Math.min(Math.max((band - ink) / (n - 1), 0), GAP_MAX * line) : 0;
  const boxes: Box[] = [];
  let y = o.top + Math.max(band - (ink + gap * (n - 1)), 0) / 2;
  for (const count of counts) {
    const h = count * line;
    boxes.push({ x: o.left, y, w: o.width, h, fontSize: size });
    y += h + gap;
  }
  return boxes;
}

/** Lay bulleted lines into a band. */
function bullets(
  texts: string[],
  o: { top: number; bottom: number; left: number; width: number; pagePx: [number, number]; size?: number },
): Box[] {
  if (!texts.length) return [];
  const lines = texts.map((t) => BULLET + t);
  const [size, counts] = o.size === undefined
    ? fit(lines, o.width, o.bottom - o.top, o.pagePx)
    : [o.size, lines.map((t) => lineCount(t, o.width, o.size as number, o.pagePx[0]))];
  return place(counts, size, { top: o.top, bottom: o.bottom, left: o.left, width: o.width, pageHeightPx: o.pagePx[1] });
}

/** The elements a structured slide turns into. */
export function toElements(s: Slide, page?: SlidePage): SlideElement[] {
  const px = pagePx(page);
  const [pageW, pageH] = px;
  const layout = s.layout ?? "content";
  const els: SlideElement[] = [];
  const push = (id: string, e: Omit<SlideElement, "id" | "color"> & { color?: string }) =>
    els.push({ color: s.textColor, ...e, id });

  if (layout === "title" || layout === "section") {
    // A cover and a section break are the same gesture: one line, centred, at
    // the display size — with the pair sitting on the page's middle.
    const budget = COVER_BOTTOM - COVER_TOP;
    const [titleSize, titleH] = s.title
      ? headline(s.title, TITLE_WIDTH, budget * COVER_TITLE_SHARE, px, DISPLAY_RAMP)
      : [FONT_DISPLAY, 0];
    const [subSize, subH] = s.subtitle
      ? headline(s.subtitle, TITLE_WIDTH, budget * COVER_SUBTITLE_SHARE, px, BODY_RAMP)
      : [BODY_RAMP[0], 0];
    const spacer = titleH && subH ? linePercent(subSize, pageH) : 0;
    // The shares leave the block inside the safe area, so the centred pair
    // cannot reach either edge however long the text runs.
    let y = Math.max(COVER_TOP, (100 - (titleH + spacer + subH)) / 2);
    if (s.title) {
      push("title", { type: "text", x: TITLE_LEFT, y, w: TITLE_WIDTH, h: titleH, text: s.title, fontSize: titleSize, bold: true, align: "center" });
      y += titleH + spacer;
    }
    if (s.subtitle) {
      push("subtitle", { type: "text", x: TITLE_LEFT, y, w: TITLE_WIDTH, h: subH, text: s.subtitle, fontSize: subSize, align: "center" });
    }
    return els;
  }

  let bodyTop = BODY_TOP;
  if (s.title) {
    const [size, h] = headline(s.title, TITLE_WIDTH, TITLE_BOTTOM - TITLE_TOP, px, TITLE_RAMP);
    push("title", { type: "text", x: TITLE_LEFT, y: TITLE_TOP, w: TITLE_WIDTH, h, text: s.title, fontSize: size, bold: true });
    bodyTop = Math.max(bodyTop, TITLE_TOP + h + linePercent(size, pageH) * 0.9);
  }

  if (layout === "image") {
    if (s.image) els.push({ id: "img", type: "image", x: 14, y: bodyTop, w: 72, h: Math.max(BODY_BOTTOM - bodyTop, 0), src: s.image });
    return els;
  }

  if (s.subtitle) {
    // A subtitle on a content slide used to vanish — the layout drew the title
    // and the bullets and nothing else. It sits under the heading.
    const [size, h] = headline(s.subtitle, TITLE_WIDTH, SUBTITLE_BUDGET, px, BODY_RAMP);
    push("subtitle", { type: "text", x: TITLE_LEFT, y: bodyTop, w: TITLE_WIDTH, h, text: s.subtitle, fontSize: size });
    bodyTop = bodyTop + h + linePercent(size, pageH) * 0.9;
  }

  if (layout === "two-column") {
    // One size for both columns, so the two halves read as one slide.
    const band = BODY_BOTTOM - bodyTop;
    const left = s.bullets ?? [];
    const right = s.bullets2 ?? [];
    const size = Math.min(
      fit(left.map((t) => BULLET + t), COLUMN_WIDTH, band, px)[0],
      fit(right.map((t) => BULLET + t), COLUMN_WIDTH, band, px)[0],
    );
    for (const [prefix, texts, x] of [["bul", left, BODY_LEFT - 2], ["bul2", right, COLUMN_RIGHT_LEFT]] as const) {
      bullets(texts, { top: bodyTop, bottom: BODY_BOTTOM, left: x, width: COLUMN_WIDTH, pagePx: px, size }).forEach((b, i) =>
        push(`${prefix}_${i}`, { type: "text", x: b.x, y: b.y, w: b.w, h: b.h, text: BULLET + texts[i], fontSize: b.fontSize }),
      );
    }
    return els;
  }

  const texts = s.bullets ?? [];
  bullets(texts, { top: bodyTop, bottom: BODY_BOTTOM, left: BODY_LEFT, width: BODY_WIDTH, pagePx: px }).forEach((b, i) =>
    push(`bul_${i}`, { type: "text", x: b.x, y: b.y, w: b.w, h: b.h, text: BULLET + texts[i], fontSize: b.fontSize }),
  );
  return els;
}

/** The elements actually on a slide: explicit edits win; otherwise derive. */
export const resolveElements = (s: Slide, page?: SlidePage): SlideElement[] =>
  s.elements?.length ? s.elements : toElements(s, page);


/**
 * The text colour a slide falls back to when neither the element nor the
 * slide names one: dark on a light background, light on a dark one.
 *
 * Without this the fallback was the editor's own `color`, which follows the
 * app theme — light text in a dark app — and a white slide's unnamed text
 * (table cells, WordArt) vanished. Only a solid `#rgb`/`#rrggbb` background
 * is judged; gradients and images default to dark text, the print default.
 */
export function defaultTextColor(background: string | undefined | null): string {
  const hex = typeof background === "string" ? /^#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(background.trim()) : null;
  if (!hex) return "#1f2328";
  let value = hex[1];
  if (value.length === 3) value = value.split("").map((c) => c + c).join("");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? "#1f2328" : "#f8f8f8";
}
