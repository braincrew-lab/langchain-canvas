/**
 * Text metrics shared by the editor, the thumbnails, the present view and
 * the print export — the twin of `canvas-py/src/langchain_canvas/slide_text.py`,
 * held to the same golden cases (`slideText.golden.json`). One estimate on
 * both sides means the frame the editor draws, the finding the deck check
 * names and the box the exporter writes agree without measuring pixels.
 */

import type { SlideElement, SlidePage } from "../protocol/artifacts";

/** Px per inch the deck model measures type on — 1280px across a 10in page.
 *  Type sizes are px at this density; a taller or narrower page measures on a
 *  proportionally taller or narrower canvas, so autofit follows the page shape
 *  instead of a fixed 16:9. */
export const METRIC_DPI = 128;

/** The px canvas for the classic 16:9 page (10 x 5.625 in) — the default when
 *  a caller passes no page, kept so every existing measurement is unchanged. */
export const PAGE_W_PX = 1280;
export const PAGE_H_PX = 720;

/** The px canvas `page` measures type on. Defaults to the classic 16:9 canvas
 *  when the page is absent or malformed, so a page-less deck measures exactly
 *  as it did before this was page-aware. */
export function metricsPagePx(page?: SlidePage): [number, number] {
  if (!page || !(page.widthIn > 0) || !(page.heightIn > 0)) return [PAGE_W_PX, PAGE_H_PX];
  return [page.widthIn * METRIC_DPI, page.heightIn * METRIC_DPI];
}
const WIDE_GLYPH = 1.0; // CJK, full-width
const NARROW_GLYPH = 0.55; // Latin, digits, punctuation
const SPACE_GLYPH = 0.3;
export const DEFAULT_LINE_HEIGHT = 1.2;
/** PowerPoint stops shrinking at a quarter of the set size; so does this. */
export const MIN_FIT_SCALE = 0.25;
export const DEFAULT_FONT_PX = 24;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function glyphWidth(ch: string): number {
  if (/\s/.test(ch)) return SPACE_GLYPH;
  return (ch.codePointAt(0) ?? 0) > 0x2e7f ? WIDE_GLYPH : NARROW_GLYPH;
}

/** How many lines `text` takes at `size` px in a box `boxW` px wide. */
export function wrappedLines(text: string, size: number, boxW: number): number {
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    let width = 0;
    for (const ch of paragraph) width += glyphWidth(ch);
    width *= size;
    lines += paragraph ? Math.max(1, Math.ceil(width / boxW)) : 1;
  }
  return lines;
}

/** The px height `text` needs at `size` px in a box `boxW` px wide. */
export function neededHeight(text: string, size: number, boxW: number, lineHeight?: number): number {
  const leading = lineHeight && lineHeight > 0 ? lineHeight : DEFAULT_LINE_HEIGHT;
  return wrappedLines(text, size, boxW) * size * leading;
}

/** The box height (percent of the page) once it has grown to hold `text`;
 *  never less than `h`. `page` shapes the px canvas so a portrait box grows
 *  by the right amount; absent, it is the classic 16:9 canvas. */
export function grownHeightPct(text: string, size: number, w: number, h: number, lineHeight?: number, page?: SlidePage): number {
  const [pageW, pageH] = metricsPagePx(page);
  const needed = neededHeight(text, size, (w / 100) * pageW, lineHeight);
  return Math.max(h, round3((needed / pageH) * 100));
}

/** How far the type shrinks so `text` stays inside a w% x h% box (1 = not at all). */
export function fitScale(text: string, size: number, w: number, h: number, lineHeight?: number, page?: SlidePage): number {
  const [pageW, pageH] = metricsPagePx(page);
  const needed = neededHeight(text, size, (w / 100) * pageW, lineHeight);
  const boxH = (h / 100) * pageH;
  if (needed <= 0 || boxH <= 0 || needed <= boxH) return 1;
  return Math.max(MIN_FIT_SCALE, round3(boxH / needed));
}

/** The height the element's box is drawn at: its own `h`, or the grown one
 *  when the box grows with its text. */
export function boxHeightPct(el: SlideElement, page?: SlidePage): number {
  if (el.type === "text" && el.autofit === "shape") {
    return grownHeightPct(el.text ?? "", el.fontSize ?? DEFAULT_FONT_PX, el.w, el.h, el.lineHeight, page);
  }
  return el.h;
}

/** The factor the element's type is drawn at: 1, or the shrink that keeps
 *  its text inside the box. */
export function textFitScale(el: SlideElement, page?: SlidePage): number {
  if (el.type === "text" && el.autofit === "text") {
    return fitScale(el.text ?? "", el.fontSize ?? DEFAULT_FONT_PX, el.w, el.h, el.lineHeight, page);
  }
  return 1;
}
