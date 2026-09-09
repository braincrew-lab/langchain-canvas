// @vitest-environment node
/**
 * Print-sheet geometry gate (Chromium) — gate (b) of
 * `.omb/plans/2026-09-09-office-render-parity.md`, §공유 픽스처 / §U1 test 4.
 *
 * The repository's own `slidesToPrintHtml` output for the shared parity deck
 * is loaded in headless Chromium at the deck's 96 dpi page (960 x 540), the
 * render image's font is injected and preflighted, and every `.el` box is
 * measured. A screenshot lands in the evidence directory for human review.
 *
 * `CANVAS_BROWSER_GATE=1` is the call switch (CI collects every
 * `src/**\/*.test.ts` with a bare `vitest run`, so `playwright` is imported
 * dynamically inside the suite). With the switch on, a missing Chromium or a
 * font Chromium refuses is a FAIL — never a skip, never a softened assertion.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SlidesData } from "../protocol/artifacts";
import deckFixture from "./__fixtures__/parity-deck.slides.json";
import {
  ensureBrowsersPath,
  evidenceDir,
  fontPreflight,
  serveFont,
  type FontPreflight,
  type ServedFont,
} from "./__gate__/fontServer";
import { bulletAlignment, renderedText, type BulletAlignment } from "./__gate__/textMetrics";
import { boxHeightPct, BULLET_PREFIX, wrappedLines } from "../client/slideText";
import { slidesToPrintHtml } from "./exporters";

const deck = deckFixture as { title: string; data: SlidesData };
const elements = deck.data.slides[0].elements ?? [];
const ids = elements.map((el) => el.id);
/** The 96 dpi page the estimator converges on (U1): 10 x 5.625 in x 96. */
const METRIC_PAGE_W_PX = 960;
const METRIC_PAGE_H_PX = 540;
/** The fixture elements whose box grows with its text (U1-4). */
const GROWN_IDS = ["grow", "korean_body"];
/** Screenshot rows below a box that the visibility proof looks at. */
const VISIBILITY_MARGIN_PX = 12;

/** Chromium's line count for a measured box next to the estimator's count at
 *  the size the box is actually drawn at (autofit `text` shrinks the type). */
function lineCounts(box: PrintBox) {
  const el = elements.find((e) => e.id === box.id);
  const text = el?.type === "text" ? (el.text ?? "") : "";
  const boxW = el ? (el.w / 100) * METRIC_PAGE_W_PX : 0;
  return {
    id: box.id,
    measuredLines: box.drawnLines,
    drawnLines: box.drawnLines,
    estimatedLines: el ? wrappedLines(text, box.fontSizePx, boxW) : null,
    scrollHeight: box.scrollHeight,
    lineHeightPx: box.lineHeightPx,
    fontSizePx: box.fontSizePx,
  };
}

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface PrintBox {
  id: string;
  text: string;
  scrollHeight: number;
  clientHeight: number;
  lineHeight: string;
  lineHeightPx: number;
  fontSizePx: number;
  borderRadius: string;
  textIndent: string;
  fontFamily: string;
  /** Distinct line tops of the box's TEXT-NODE client rects (Range) — the lines
   *  Chromium actually drew, independent of how tall the box is. A grown box
   *  holds its text in a child block (U1 ink guard); the child's own rect is
   *  not a line, so only text nodes are ranged. Recorded. */
  drawnLines: number;
  /** Height of the first text client rect: the face's content area at this
   *  size (ascent + descent), which is what overhangs a shorter line box. */
  textRectHeightPx: number | null;
  /** The box's border box on the page (960 x 540). */
  rect: Rect;
  /** The last drawn line's glyph-ink bottom relative to the box bottom: the
   *  text rect top of that line + the face's ascent + the ink descent of the
   *  characters on it (Canvas `actualBoundingBoxDescent` at the drawn size).
   *  Negative = the ink ends inside the box. */
  lastInkBottomMinusBoxBottomPx: number | null;
  /** Bottom of the printed page minus the box bottom (≥ 0 = inside the page). */
  pageBottomSlackPx: number;
}

/** The ink guard's containment proofs for one grown box (U1-4b). */
interface GuardProof {
  id: string;
  rect: Rect;
  /** Where the box would end without the guard: top + estimator height. */
  unguardedBottomPx: number;
  lastInkBottomMinusBoxBottomPx: number | null;
  pageBottomSlackPx: number;
  /** Top of the nearest element that overlaps horizontally and starts below
   *  the un-guarded bottom, minus the guarded bottom; null when none. */
  nearestBelowGapPx: number | null;
  /** Pixels that differ between the box drawn clipped (`overflow: hidden`) and
   *  unclipped (`overflow: visible`), over the box plus a margin below. */
  differingPixels: number;
}

describe.skipIf(process.env.CANVAS_BROWSER_GATE !== "1")("print sheet geometry in Chromium", () => {
  let browser: import("playwright").Browser | undefined;
  let font: ServedFont | undefined;
  let preflight: FontPreflight;
  let negative: { height: number; lines: number; legacyHeightEstimate: number }[] = [];
  let boxes: PrintBox[] = [];
  let guards: GuardProof[] = [];
  /** The `grow` box's bullet block, measured where Chromium drew it (U3-4); null when the sheet has none. */
  let bullet: (BulletAlignment & { textIndent: string }) | null = null;

  beforeAll(async () => {
    ensureBrowsersPath();
    const { chromium } = await import("playwright");
    font = await serveFont();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: METRIC_PAGE_W_PX, height: METRIC_PAGE_H_PX } });
    await page.setContent(slidesToPrintHtml(deck.data, "parity"));
    await page.addStyleTag({ content: font.css });
    preflight = await fontPreflight(page);
    const read = (nodes: Element[]) =>
      nodes.map((node) => {
        const el = node as HTMLElement;
        // A grown box carries its leading on a text child (U1 ink guard); every
        // other box carries it itself.
        const text = (el.querySelector(":scope > .el__text") as HTMLElement | null) ?? el;
        const style = getComputedStyle(text);
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const rects: DOMRect[] = [];
        let lastTextNode: Text | null = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) rects.push(r);
          lastTextNode = n as Text;
        }
        const tops: number[] = [];
        for (const r of rects) if (!tops.some((t) => Math.abs(t - r.top) <= 0.5)) tops.push(r.top);
        const box = el.getBoundingClientRect();
        const slide = (el.closest(".slide") as HTMLElement).getBoundingClientRect();
        const last = rects[rects.length - 1];
        let lastInkBottomMinusBoxBottomPx: number | null = null;
        if (last && lastTextNode) {
          // The characters drawn on the last line, measured as ink in the same face.
          const range = document.createRange();
          let lastLine = "";
          for (let i = 0; i < lastTextNode.data.length; i += 1) {
            range.setStart(lastTextNode, i);
            range.setEnd(lastTextNode, i + 1);
            const r = range.getClientRects()[0];
            if (r && Math.abs(r.top - last.top) <= 0.5) lastLine += lastTextNode.data[i];
          }
          const context = document.createElement("canvas").getContext("2d");
          if (context && lastLine) {
            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const metrics = context.measureText(lastLine);
            lastInkBottomMinusBoxBottomPx = last.top + metrics.fontBoundingBoxAscent + metrics.actualBoundingBoxDescent - box.bottom;
          }
        }
        return {
          drawnLines: tops.length,
          textRectHeightPx: rects[0]?.height ?? null,
          text: el.textContent ?? "",
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          lineHeight: style.lineHeight,
          lineHeightPx: parseFloat(style.lineHeight),
          fontSizePx: parseFloat(style.fontSize),
          borderRadius: style.borderRadius,
          textIndent: style.textIndent,
          fontFamily: style.fontFamily,
          rect: { top: box.top - slide.top, bottom: box.bottom - slide.top, left: box.left - slide.left, right: box.right - slide.left },
          lastInkBottomMinusBoxBottomPx,
          pageBottomSlackPx: slide.bottom - box.bottom,
        };
      });
    const measured = await page.$$eval(".slide:first-of-type .el", read);
    // Real DOM negative control: identical tall boxes, deliberately different
    // widths. The same measurement function used by the positive gate must
    // reject their divergent wrapping despite identical allocated heights.
    await page.$eval(".slide:first-of-type .el", (source) => {
      for (const scale of [1, 0.5]) {
        const clone = source.cloneNode(true) as HTMLElement;
        clone.classList.add("line-count-control");
        clone.style.width = `${source.getBoundingClientRect().width * scale}px`;
        clone.style.height = "1000px";
        const text = clone.querySelector<HTMLElement>(".cv-free__text, .el__text");
        if (text) text.style.height = "1000px";
        source.parentElement!.appendChild(clone);
      }
    });
    const controlBoxes = await page.$$eval(".line-count-control", read);
    const heights = await page.$$eval(".line-count-control", (nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    negative = controlBoxes.map((box, i) => ({ height: heights[i], lines: box.drawnLines, legacyHeightEstimate: Math.round(box.scrollHeight / box.lineHeightPx) }));
    await page.$$eval(".line-count-control", (nodes) => nodes.forEach((node) => node.remove()));

    boxes = measured.map((box, index) => ({ id: ids[index] ?? `#${index}`, ...box }));
    const dir = evidenceDir();
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, "print-korean-body.png"), fullPage: true });

    // U1-4b: the visibility proof — the same box clipped and unclipped must
    // paint the same pixels over the box and a margin below it.
    guards = [];
    for (const id of GROWN_IDS) {
      const index = ids.indexOf(id);
      const box = boxes[index];
      const el = elements[index];
      const shot = async (overflow: string) => {
        const clip = await page.evaluate(
          ({ index, overflow, margin }) => {
            const node = document.querySelectorAll<HTMLElement>(".slide:first-of-type .el")[index];
            node.style.overflow = overflow;
            const r = node.getBoundingClientRect();
            return { x: Math.floor(r.left) - 2, y: Math.floor(r.top) - 2, width: Math.ceil(r.width) + 4, height: Math.ceil(r.height) + 2 + margin };
          },
          { index, overflow, margin: VISIBILITY_MARGIN_PX },
        );
        const png = await page.screenshot({ clip });
        await page.evaluate((index) => {
          document.querySelectorAll<HTMLElement>(".slide:first-of-type .el")[index].style.overflow = "hidden";
        }, index);
        return png;
      };
      const hidden = await shot("hidden");
      const visible = await shot("visible");
      writeFileSync(path.join(dir, `print-${id}-overflow-visible.png`), visible);
      const differingPixels = await page.evaluate(
        async ([a, b]) => {
          const load = (src: string) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = () => reject(new Error("screenshot did not decode"));
              img.src = `data:image/png;base64,${src}`;
            });
          const [ia, ib] = await Promise.all([load(a), load(b)]);
          if (ia.width !== ib.width || ia.height !== ib.height) return Number.POSITIVE_INFINITY;
          const canvas = document.createElement("canvas");
          canvas.width = ia.width;
          canvas.height = ia.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(ia, 0, 0);
          const da = context.getImageData(0, 0, ia.width, ia.height).data;
          context.clearRect(0, 0, ia.width, ia.height);
          context.drawImage(ib, 0, 0);
          const db = context.getImageData(0, 0, ia.width, ia.height).data;
          let differing = 0;
          for (let i = 0; i < da.length; i += 4) if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) differing += 1;
          return differing;
        },
        [hidden.toString("base64"), visible.toString("base64")],
      );
      const unguardedBottomPx = box.rect.top + (boxHeightPct(el, deck.data.page) / 100) * METRIC_PAGE_H_PX;
      const below = boxes
        .filter((other) => other.id !== id && other.rect.left < box.rect.right && other.rect.right > box.rect.left && other.rect.top >= unguardedBottomPx - 0.5)
        .map((other) => other.rect.top - box.rect.bottom);
      guards.push({
        id,
        rect: box.rect,
        unguardedBottomPx,
        lastInkBottomMinusBoxBottomPx: box.lastInkBottomMinusBoxBottomPx,
        pageBottomSlackPx: box.pageBottomSlackPx,
        nearestBelowGapPx: below.length ? Math.min(...below) : null,
        differingPixels,
      });
    }

    // U3-4: the first bullet block in the sheet is `grow`'s (the fixture's only
    // bulleted element, first in order). Absent → recorded as null, asserted below.
    const bulletBlock = await page.$(".slide:first-of-type .el .p-bullet");
    bullet = bulletBlock
      ? {
          ...(await bulletBlock.evaluate(bulletAlignment)),
          textIndent: await bulletBlock.evaluate((block) => getComputedStyle(block).textIndent),
        }
      : null;

    writeFileSync(
      path.join(dir, "print-geometry.measurements.json"),
      JSON.stringify(
        {
          engine: `Chromium ${browser.version()} (playwright headless)`,
          page: { widthPx: METRIC_PAGE_W_PX, heightPx: METRIC_PAGE_H_PX },
          font: { url: font.url, sha256: font.sha256, bytes: font.bytes },
          preflight,
          negative,
          boxes,
          lineCounts: boxes.filter((b) => elements.find((e) => e.id === b.id)?.type === "text").map(lineCounts),
          guards,
          bullet,
        },
        null,
        1,
      ),
    );
    await page.close();
    // Hook timeout raised with a reason: launching Chromium and loading the
    // 19 MB font collection take longer than the 10 s hook default on a cold run.
  }, 60_000);

  it("detects divergent wrapping with identical box heights (negative control)", () => {
    expect(negative).toHaveLength(2);
    expect(negative[0].height).toBe(negative[1].height);
    // Falsify the old height-based gate: it reports equality for this mismatch.
    expect(negative[0].legacyHeightEstimate).toBe(negative[1].legacyHeightEstimate);
    expect(negative[0].lines).toBeGreaterThan(0);
    expect(negative[1].lines).toBeGreaterThan(negative[0].lines);
  });

  afterAll(async () => {
    await browser?.close();
    await font?.close();
  });

  it("the render image's font loads in Chromium (preflight)", () => {
    expect(preflight.error).toBeNull();
    expect(preflight.loaded).toHaveLength(1);
    expect(preflight.loaded[0].status).toBe("loaded");
    expect(preflight.check).toBe(true);
  });

  it("the print sheet carries one box per fixture element, in fixture order", () => {
    expect(boxes.map((b) => b.id)).toEqual(ids);
    for (const box of boxes) {
      const el = elements.find((e) => e.id === box.id);
      // A bullet paragraph renders as marker + body (U3); everything else as-is.
      if (el?.type === "text") expect(box.text).toBe(renderedText(el.text ?? ""));
    }
  });

  it("a bullet paragraph hangs its body under the first body character", () => {
    // U3 test 4: `grow` starts with the bullet prefix, so the sheet draws one
    // visible marker and a 1.2 em hanging indent (the file's marL / indent),
    // and the wrapped body lines start where the first body character does.
    const grow = boxes.find((b) => b.id === "grow");
    const el = elements.find((e) => e.id === "grow");
    expect(grow).toBeDefined();
    expect(el?.type).toBe("text");
    expect(bullet, "the print sheet has no .p-bullet block for grow").not.toBeNull();
    expect(parseFloat(bullet!.textIndent)).toBeCloseTo(-1.2 * grow!.fontSizePx, 2); // -28.8px at 24px
    expect(grow!.text.startsWith("•")).toBe(true);
    expect(grow!.text.split("•").length - 1).toBe(1);
    expect(grow!.text.slice(1)).toBe((el!.type === "text" ? (el!.text ?? "") : "").slice(BULLET_PREFIX.length));
    expect(bullet!.markerCount).toBe(1);
    expect(bullet!.continuationLeft, JSON.stringify(bullet)).not.toBeNull();
    expect(Math.abs(bullet!.firstBodyLeft - (bullet!.continuationLeft ?? NaN)), JSON.stringify(bullet)).toBeLessThanOrEqual(1);
    expect(Math.abs((bullet!.firstBodyLeft - bullet!.blockLeft) / bullet!.fontSizePx - 1.2), JSON.stringify(bullet)).toBeLessThanOrEqual(0.05);
  });

  it("an autofit shape box is drawn tall enough for its text", () => {
    // U1 test 4: the grown box holds every line — `korean_body` (the golden
    // "korean body in a placeholder box") and `grow` (40 Hangul + bullet).
    const grown = boxes.filter((b) => GROWN_IDS.includes(b.id));
    expect(grown.map((b) => b.id).sort()).toEqual([...GROWN_IDS].sort());
    const clipped = grown
      .filter((b) => !(b.scrollHeight <= b.clientHeight + 1))
      .map((b) => ({ id: b.id, scrollHeight: b.scrollHeight, clientHeight: b.clientHeight, lineHeightPx: b.lineHeightPx }));
    expect(clipped).toEqual([]);
  });

  it("the ink guard keeps the last line's ink and pixels inside the box, and the box inside the page and clear of its neighbours", () => {
    // U1-4b (plan R3 addendum): the guard is proven, not assumed — the last
    // drawn line's glyph ink ends inside the box, clipping the box changes no
    // pixel, the guarded box ends inside the page, and the guard opens no new
    // overlap with an element that starts below the un-guarded bottom.
    expect(guards.map((g) => g.id).sort()).toEqual([...GROWN_IDS].sort());
    const off = guards.filter(
      (g) =>
        !(g.lastInkBottomMinusBoxBottomPx !== null && g.lastInkBottomMinusBoxBottomPx <= 0) ||
        g.differingPixels !== 0 ||
        !(g.pageBottomSlackPx >= 0) ||
        !(g.nearestBelowGapPx === null || g.nearestBelowGapPx >= 0),
    );
    expect(off).toEqual([]);
  });

  it("the estimator's line count matches Chromium for full-width text", () => {
    // U1 test 5: `grow` (40 Hangul + bullet, full-width) wraps to EXACTLY the
    // estimator's count — an assertion about the design constant WIDE_GLYPH,
    // not a claim about the face's advance (governing decision 9). A mismatch
    // is reported through the advance evidence protocol, never absorbed here.
    const grow = boxes.find((b) => b.id === "grow");
    expect(grow).toBeDefined();
    const growCounts = lineCounts(grow!);
    expect(growCounts.measuredLines, JSON.stringify(growCounts)).toBe(growCounts.estimatedLines);
    // Latin averages a 0.55 em class by design, so `fit_latin` is held to a
    // fixed +-1 line design tolerance from the start (not a conditional one).
    const latin = boxes.find((b) => b.id === "fit_latin");
    expect(latin).toBeDefined();
    const latinCounts = lineCounts(latin!);
    expect(Math.abs(latinCounts.measuredLines - (latinCounts.estimatedLines ?? NaN)), JSON.stringify(latinCounts)).toBeLessThanOrEqual(1);
  });

  it("a rectangle has no corner radius", () => {
    // U4 test 6: the file's `prst="rect"` is square; the sheet draws it square
    // (the baseline recorded 8px on `rect` and 2px on `line`).
    const rect = boxes.find((b) => b.id === "rect");
    const line = boxes.find((b) => b.id === "line");
    expect(rect?.borderRadius).toBe("0px");
    expect(line?.borderRadius).toBe("0px");
  });

  it("a default-leading box measures 1.2 lines", () => {
    // U2 test 4: `plain` names no lineHeight, so the sheet's `.el` default —
    // the estimator's DEFAULT_LINE_HEIGHT (1.2) — is what Chromium computes
    // at the element's 24px: 28.8px, not the print-only 1.25 (30px).
    const plain = boxes.find((b) => b.id === "plain");
    expect(plain).toBeDefined();
    expect(plain!.fontSizePx).toBe(24);
    expect(plain!.lineHeightPx).toBeCloseTo(24 * 1.2, 3);
  });
});
