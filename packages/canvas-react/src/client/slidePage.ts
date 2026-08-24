/**
 * Deck page geometry for the slide editor. The deck's `data.page` (inches)
 * defines the coordinate space the percent geometry and font sizes refer to;
 * these helpers turn it into the editor's aspect ratio and font scale so the
 * on-screen slide matches the exported file.
 */

import type { SlidePage, SlidesData } from "../protocol/artifacts";

/** The classic canvas when a deck carries no `page` — 16:9, 10 x 5.625 in.
 *  Mirrors the exporters' DEFAULT_SLIDE_PAGE_IN so screen and file agree. */
export const DEFAULT_SLIDE_PAGE_IN: SlidePage = { widthIn: 10, heightIn: 5.625 };

/** Pixels per inch of the deck coordinate space. `fontSize` is stored as an
 *  absolute px value at this density (the exporters emit pt = px * 0.75). */
export const PAGE_DPI = 96;

/** The deck's page, falling back to the classic canvas when `page` is absent
 *  or carries a non-positive dimension (a malformed deck must not divide by
 *  zero or flip the box). */
export function deckPage(data: Pick<SlidesData, "page">): SlidePage {
  const page = data.page;
  if (!page) return DEFAULT_SLIDE_PAGE_IN;
  const { widthIn, heightIn } = page;
  if (!Number.isFinite(widthIn) || !Number.isFinite(heightIn) || widthIn <= 0 || heightIn <= 0) {
    return DEFAULT_SLIDE_PAGE_IN;
  }
  return { widthIn, heightIn };
}

/** CSS `aspect-ratio` value for the slide box. */
export function pageAspect(page: SlidePage): string {
  return `${page.widthIn} / ${page.heightIn}`;
}

/** How much to scale stored font px for a slide box rendered `boxWidthPx`
 *  wide. 1 means the box is exactly the page at 96dpi; a narrower box shows
 *  proportionally smaller text — the same rule the pptx export applies. */
export function fontScaleFor(boxWidthPx: number, page: SlidePage): number {
  if (!Number.isFinite(boxWidthPx) || boxWidthPx <= 0) return 1;
  return boxWidthPx / (page.widthIn * PAGE_DPI);
}
