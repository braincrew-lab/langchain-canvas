/**
 * Test-only DOM measurement for the browser gates
 * (`.omb/plans/2026-09-09-office-render-parity.md` §U3, task 1b).
 *
 * `bulletAlignment` is handed to Playwright's `page.$eval` / `$$eval`, which
 * serialises the function and runs it INSIDE the page. It must therefore be
 * self-contained: no imports, no closure over module scope, only DOM APIs.
 *
 * Assertion shape the U3-4 / M6 tests apply to the result (plan §U3):
 *   markerCount === 1
 *   |firstBodyLeft - continuationLeft| <= 1            (px)
 *   |(firstBodyLeft - blockLeft) / fontSizePx - 1.2| <= 0.05   (em)
 */

import { bulletParagraphs } from "../../client/slideText";

/** The `textContent` a surface renders for an element's text once bullet
 *  paragraphs are blocks (U3): the marker glyph followed by the body for a
 *  bullet paragraph, a non-breaking space for an empty plain paragraph, the
 *  blocks joined with no separator. Text with no bullet paragraph renders
 *  as-is. Node-side helper for the gates' text assertions. */
export function renderedText(text: string): string {
  const paragraphs = bulletParagraphs(text);
  if (!paragraphs) return text;
  return paragraphs.map((p) => (p.bullet ? `•${p.text}` : p.text || " ")).join("");
}

export interface BulletAlignment {
  /** Number of text nodes inside the block whose text is the bullet marker. */
  markerCount: number;
  /** `block.getBoundingClientRect().left`. */
  blockLeft: number;
  /** Left edge of the first body character (the text node after the marker). */
  firstBodyLeft: number;
  /** Left edge of the first body character on the second line; `null` when the body never wraps. */
  continuationLeft: number | null;
  /** Computed `font-size` of the block, so offsets can be read in em (thumbnails are scaled). */
  fontSizePx: number;
}

/**
 * Where a bullet paragraph's body starts on its first and second line.
 *
 * The first body text node is the first text node following the marker's
 * text node in document order. Its characters are measured one at a time
 * with a `Range`: the first visible character's rect is `firstBody`; the
 * first character whose rect sits below it (`top > firstBody.top + 0.5`) is
 * `continuation`. Whitespace characters are skipped (a line-end space has no
 * stable rect).
 */
export function bulletAlignment(block: Element): BulletAlignment {
  const MARKER = "•";
  const doc = block.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error("bulletAlignment: the block is not attached to a window");
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text);
  const markers = textNodes.filter((node) => node.data.trim() === MARKER);
  const marker = markers[0];
  if (!marker) throw new Error("bulletAlignment: the block has no bullet marker text node");
  const body = textNodes.find(
    (node) => node !== marker && (marker.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  if (!body) throw new Error("bulletAlignment: no body text node follows the marker");
  const range = doc.createRange();
  let firstBody: DOMRect | null = null;
  let continuation: DOMRect | null = null;
  for (let index = 0; index < body.data.length; index += 1) {
    if (/\s/.test(body.data[index])) continue;
    range.setStart(body, index);
    range.setEnd(body, index + 1);
    const rect = range.getClientRects()[0];
    if (!rect) continue;
    if (!firstBody) {
      firstBody = rect;
      continue;
    }
    if (rect.top > firstBody.top + 0.5) {
      continuation = rect;
      break;
    }
  }
  if (!firstBody) throw new Error("bulletAlignment: the body text node has no visible character");
  return {
    markerCount: markers.length,
    blockLeft: block.getBoundingClientRect().left,
    firstBodyLeft: firstBody.left,
    continuationLeft: continuation ? continuation.left : null,
    fontSizePx: parseFloat(view.getComputedStyle(block).fontSize),
  };
}

export interface SnugContainment {
  /** `textContent` of the clipping box. */
  text: string;
  fontSizePx: number;
  whiteSpace: string;
  fontFamily: string;
  scrollWidth: number;
  clientWidth: number;
  boxLeft: number;
  boxRight: number;
  /** The last visible (non-space) character in the box, its rect's right edge, and its left edge. */
  lastChar: string;
  lastCharLeft: number | null;
  lastCharRight: number | null;
  /** The last character's INK extent in the page's own face at its drawn size:
   *  its rect left plus Canvas `actualBoundingBoxRight` (right) and minus
   *  `actualBoundingBoxLeft` (left) — what is actually painted, inside the
   *  advance box by the glyph's side bearings. `null` when the document has no 2D canvas. */
  lastCharInkLeft: number | null;
  lastCharInkRight: number | null;
  firstCharLeft: number | null;
  /** Distinct line tops of the visible characters — the lines actually drawn. */
  drawnLines: number;
}

/**
 * Whether a one-line text is drawn inside its clipping box, character by
 * character. Handed to Playwright's `evaluate` and run INSIDE the page —
 * self-contained like `bulletAlignment`. `target` is the box whose
 * `overflow: hidden` clips the text (`.el` on the print sheet,
 * `.cv-free__text` on the mounted surfaces).
 */
export function snugContainment(target: Element): SnugContainment {
  const el = target as HTMLElement;
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error("snugContainment: the box is not attached to a window");
  const style = view.getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let first: DOMRect | null = null;
  let last: DOMRect | null = null;
  let lastChar = "";
  let lastParent: Element | null = null;
  const tops: number[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    for (let index = 0; index < text.data.length; index += 1) {
      if (/\s/.test(text.data[index])) continue;
      const range = doc.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width <= 0) continue;
      if (!first) first = rect;
      last = rect;
      lastChar = text.data[index];
      lastParent = text.parentElement;
      if (!tops.some((top) => Math.abs(top - rect.top) <= 0.5)) tops.push(rect.top);
    }
  }
  // Ink of the last character, measured by THIS document's canvas in the face
  // and size its parent element draws it with.
  let lastCharInkLeft: number | null = null;
  let lastCharInkRight: number | null = null;
  const context = doc.createElement("canvas").getContext("2d");
  if (context && last && lastParent) {
    const drawn = view.getComputedStyle(lastParent);
    context.font = `${drawn.fontWeight} ${drawn.fontSize} ${drawn.fontFamily}`;
    const metrics = context.measureText(lastChar);
    lastCharInkLeft = last.left - metrics.actualBoundingBoxLeft;
    lastCharInkRight = last.left + metrics.actualBoundingBoxRight;
  }
  return {
    text: el.textContent ?? "",
    fontSizePx: parseFloat(style.fontSize),
    whiteSpace: style.whiteSpace,
    fontFamily: style.fontFamily,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    boxLeft: box.left,
    boxRight: box.right,
    lastChar,
    lastCharLeft: last ? last.left : null,
    lastCharRight: last ? last.right : null,
    lastCharInkLeft,
    lastCharInkRight,
    firstCharLeft: first ? first.left : null,
    drawnLines: tops.length,
  };
}
