/**
 * Text metrics shared by the editor, the thumbnails, the present view and
 * the print export — the twin of `canvas-py/src/langchain_canvas/slide_text.py`,
 * held to the same golden cases (`slideText.golden.json`). One estimate on
 * both sides means the frame the editor draws, the finding the deck check
 * names and the box the exporter writes agree without measuring pixels.
 */

import type { SlideElement } from "../protocol/artifacts";

/** The px canvas the deck model measures type on. */
export const PAGE_W_PX = 1280;
export const PAGE_H_PX = 720;
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
 *  never less than `h`. */
export function grownHeightPct(text: string, size: number, w: number, h: number, lineHeight?: number): number {
  const needed = neededHeight(text, size, (w / 100) * PAGE_W_PX, lineHeight);
  return Math.max(h, round3((needed / PAGE_H_PX) * 100));
}

/** How far the type shrinks so `text` stays inside a w% x h% box (1 = not at all). */
export function fitScale(text: string, size: number, w: number, h: number, lineHeight?: number): number {
  const needed = neededHeight(text, size, (w / 100) * PAGE_W_PX, lineHeight);
  const boxH = (h / 100) * PAGE_H_PX;
  if (needed <= 0 || boxH <= 0 || needed <= boxH) return 1;
  return Math.max(MIN_FIT_SCALE, round3(boxH / needed));
}

/** The height the element's box is drawn at: its own `h`, or the grown one
 *  when the box grows with its text. */
export function boxHeightPct(el: SlideElement): number {
  if (el.type === "text" && el.autofit === "shape") {
    return grownHeightPct(el.text ?? "", el.fontSize ?? DEFAULT_FONT_PX, el.w, el.h, el.lineHeight);
  }
  return el.h;
}

/** The factor the element's type is drawn at: 1, or the shrink that keeps
 *  its text inside the box. */
export function textFitScale(el: SlideElement): number {
  if (el.type === "text" && el.autofit === "text") {
    return fitScale(el.text ?? "", el.fontSize ?? DEFAULT_FONT_PX, el.w, el.h, el.lineHeight);
  }
  return 1;
}
