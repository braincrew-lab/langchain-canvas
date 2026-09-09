/**
 * Text metrics shared by the editor, the thumbnails, the present view and
 * the print export — the twin of `canvas-py/src/langchain_canvas/slide_text.py`,
 * held to the same golden cases (`slideText.golden.json`). One estimate on
 * both sides means the frame the editor draws, the finding the deck check
 * names and the box the exporter writes agree without measuring pixels.
 */

import type { SlideElement, SlidePage } from "../protocol/artifacts";
import { DEFAULT_SLIDE_PAGE_IN, PAGE_DPI } from "./slidePage";

/** Px per inch the deck model measures type on — 96 dpi, the density
 *  `fontSize` is stored at (`slidePage.ts`), so a w% x h% box is measured on
 *  the same page the editor draws and the exporters write. A taller or
 *  narrower page measures on a proportionally taller or narrower canvas, so
 *  autofit follows the page shape instead of a fixed 16:9. */
export const METRIC_DPI = PAGE_DPI;

/** The px canvas for the classic 16:9 page (10 x 5.625 in) — the default when
 *  a caller passes no page: 960 x 540. */
export const PAGE_W_PX = DEFAULT_SLIDE_PAGE_IN.widthIn * METRIC_DPI;
export const PAGE_H_PX = DEFAULT_SLIDE_PAGE_IN.heightIn * METRIC_DPI;

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

/** What a bulleted paragraph starts with — the prefix the derived layout
 *  writes and the pptx writer (`exporters.py`) strips exactly once to draw a
 *  real list bullet. */
export const BULLET_PREFIX = "• ";
/** The hanging indent of a bulleted paragraph in em of its own type size —
 *  the twin of `exporters.py::_BULLET_HANG` (the file's `marL` / `indent`). */
export const BULLET_HANG_EM = 1.2;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function glyphWidth(ch: string): number {
  if (/\s/.test(ch)) return SPACE_GLYPH;
  return (ch.codePointAt(0) ?? 0) > 0x2e7f ? WIDE_GLYPH : NARROW_GLYPH;
}

export interface BulletParagraph {
  /** The body: the paragraph after one `BULLET_PREFIX` for a bullet, the paragraph as-is otherwise. */
  text: string;
  bullet: boolean;
}

/** The paragraphs of `text` with their bullet flag. A bullet paragraph's
 *  `text` is what follows the prefix, stripped exactly once (a further space,
 *  an empty body and a second "• " all stay); a plain paragraph is kept as-is,
 *  an empty one too. `null` when no paragraph is a bullet, so a caller keeps
 *  rendering plain text. The pptx writer's rule (`exporters.py`,
 *  `line.startswith(BULLET_PREFIX)`), so the browser draws the list the file has. */
export function bulletParagraphs(text: string): BulletParagraph[] | null {
  const paragraphs = text
    .split("\n")
    .map((p) => (p.startsWith(BULLET_PREFIX) ? { text: p.slice(BULLET_PREFIX.length), bullet: true } : { text: p, bullet: false }));
  return paragraphs.some((p) => p.bullet) ? paragraphs : null;
}

/** The width a snug one-liner is drawn at, in px — what the snug one-line
 *  fit (`useSnugFit` on every browser surface, `fitSnugLines` on the print
 *  sheet) compares to its box. A bullet paragraph is drawn as one fixed
 *  marker `BULLET_HANG_EM` wide plus its body, so that is what is measured:
 *  the "• " prefix's own glyphs are narrower than the marker in every Latin
 *  and KR face (0.564 em in Noto Sans CJK KR), and a fit computed from them
 *  left the drawn line wider than the box and clipped its last glyph. Plain
 *  text is measured as-is. `measure` is the caller's Canvas 2D `measureText`
 *  width in the element's face at `fontPx`, the DRAWN size (a thumbnail's is
 *  scaled), so the marker scales with the type. Browser-only, like
 *  `inkGuardCss`: the file has no snug fit, so the Python twin has none. */
export function snugLineWidth(paragraph: BulletParagraph, fontPx: number, measure: (text: string) => number): number {
  if (!paragraph.bullet) return measure(paragraph.text);
  return BULLET_HANG_EM * fontPx + measure(paragraph.text);
}

/** How many lines `text` takes at `size` px in a box `boxW` px wide. A bullet
 *  paragraph's body wraps in the hanging column — the box less the marker's
 *  `BULLET_HANG_EM` (never narrower than one glyph), as every surface draws it. */
export function wrappedLines(text: string, size: number, boxW: number): number {
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    const bullet = paragraph.startsWith(BULLET_PREFIX);
    const body = bullet ? paragraph.slice(BULLET_PREFIX.length) : paragraph;
    const column = bullet ? Math.max(size, boxW - BULLET_HANG_EM * size) : boxW;
    let width = 0;
    for (const ch of body) width += glyphWidth(ch);
    width *= size;
    lines += body ? Math.max(1, Math.ceil(width / column)) : 1;
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

/** The CSS length a browser adds below a box that grows with its text — the
 *  ink guard. A line box is `leading x size` tall, but the face's content
 *  area (ascent + descent — what `1lh` resolves to under `line-height:
 *  normal`) can be taller; the browser centres the two on every line, so the
 *  last line's bottom half of the difference hangs below the box and counts
 *  as overflow although no ink is there (Noto Sans CJK KR at 24 px: a 35 px
 *  content area on a 28.8 px line box, 3.1 px). The guard is that half, never
 *  below zero, resolved by the browser from the face itself: it is applied to
 *  a `line-height: normal` box whose text child keeps the leading. Browser-only
 *  by design — the file keeps the estimator's height (LibreOffice lays its
 *  lines out from the face's own metrics and contains the text there), so the
 *  Python twin writes no guard. */
export function inkGuardCss(lineHeight?: number): string {
  const leading = lineHeight && lineHeight > 0 ? lineHeight : DEFAULT_LINE_HEIGHT;
  return `max(0px, (1lh - ${leading}em) / 2)`;
}
