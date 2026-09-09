/**
 * The text estimate, held to the golden cases the Python twin
 * (`canvas-py/src/langchain_canvas/slide_text.py`) computes. Change the
 * estimate on one side only and one of the two suites fails.
 */

import { describe, expect, it } from "vitest";

import type { SlideElement } from "../protocol/artifacts";
import golden from "./slideText.golden.json";
import { DEFAULT_SLIDE_PAGE_IN, PAGE_DPI } from "./slidePage";
import {
  boxHeightPct,
  BULLET_HANG_EM,
  BULLET_PREFIX,
  bulletParagraphs,
  DEFAULT_LINE_HEIGHT,
  fitScale,
  grownHeightPct,
  inkGuardCss,
  METRIC_DPI,
  metricsPagePx,
  MIN_FIT_SCALE,
  PAGE_H_PX,
  PAGE_W_PX,
  snugLineWidth,
  textFitScale,
  wrappedLines,
} from "./slideText";

type Golden = { name: string; text: string; size: number; w: number; h: number; lineHeight?: number; lines: number; grownHeightPct: number; fitScale: number };

describe("slideText", () => {
  it("matches the golden cases the Python twin wrote", () => {
    expect(golden.length).toBeGreaterThanOrEqual(5);
    for (const c of golden as Golden[]) {
      expect(wrappedLines(c.text, c.size, (c.w / 100) * PAGE_W_PX), c.name).toBe(c.lines);
      expect(grownHeightPct(c.text, c.size, c.w, c.h, c.lineHeight), c.name).toBe(c.grownHeightPct);
      expect(fitScale(c.text, c.size, c.w, c.h, c.lineHeight), c.name).toBe(c.fitScale);
    }
  });

  it("measures type on the 96 dpi page fontSize is stored at", () => {
    // U1: one density for the estimator and the page (`slidePage.ts`), so a
    // portrait page measures on a 7.5 x 10 in canvas at that same density —
    // the twin of test_slide_text.py's portrait case.
    expect(METRIC_DPI).toBe(PAGE_DPI);
    expect([PAGE_W_PX, PAGE_H_PX]).toEqual([DEFAULT_SLIDE_PAGE_IN.widthIn * PAGE_DPI, DEFAULT_SLIDE_PAGE_IN.heightIn * PAGE_DPI]);
    expect(metricsPagePx({ widthIn: 7.5, heightIn: 10 })).toEqual([7.5 * PAGE_DPI, 10 * PAGE_DPI]);
  });

  it("draws a growing box at the height its text needs, and a fixed one as stored", () => {
    const long = "가나다라마바사아자차카타파하 ".repeat(8);
    const grows: SlideElement = { id: "a", type: "text", x: 5, y: 10, w: 40, h: 5, fontSize: 24, text: long, autofit: "shape" };
    const fixed: SlideElement = { ...grows, id: "b", autofit: undefined };
    expect(boxHeightPct(grows)).toBeGreaterThan(20);
    expect(boxHeightPct(fixed)).toBe(5);
    // U1 (plan R3 addendum): on the 96 dpi page one 24 px line at the 1.2
    // leading is 28.8 px, taller than this 5 % box (27 px), so even a two-letter
    // text grows the box to 28.8 / 540 = 5.333 %. The input box stays 5 %.
    expect(boxHeightPct({ ...grows, text: "hi" })).toBe(5.333);
  });

  it("a growing box tall enough for its one line keeps its stored height", () => {
    // The no-growth regression: a 10 % box (54 px) holds one 28.8 px line, so a
    // box that grows with its text does not move when its text already fits.
    const roomy: SlideElement = { id: "a", type: "text", x: 5, y: 10, w: 40, h: 10, fontSize: 24, text: "hi", autofit: "shape" };
    expect(boxHeightPct(roomy)).toBe(10);
    expect(boxHeightPct({ ...roomy, text: "" })).toBe(10);
  });

  it("splits bullet paragraphs the way the pptx writer does (U3)", () => {
    // The writer strips the prefix exactly once and draws one list bullet with
    // a 1.2 em hanging indent (exporters.py); the browser surfaces and the
    // estimator follow the same rule so a wrapped bullet lands under its body.
    expect(BULLET_PREFIX).toBe("• ");
    expect(BULLET_HANG_EM).toBe(1.2);
    expect(bulletParagraphs("• a\nplain\n• b")).toEqual([
      { text: "a", bullet: true },
      { text: "plain", bullet: false },
      { text: "b", bullet: true },
    ]);
    expect(bulletParagraphs("• ")).toEqual([{ text: "", bullet: true }]);
    expect(bulletParagraphs("•  a")).toEqual([{ text: " a", bullet: true }]);
    expect(bulletParagraphs("• • a")).toEqual([{ text: "• a", bullet: true }]);
    expect(bulletParagraphs("• a\n\nb")).toEqual([
      { text: "a", bullet: true },
      { text: "", bullet: false },
      { text: "b", bullet: false },
    ]);
    expect(bulletParagraphs("plain")).toBeNull();
  });

  it("names the browser ink guard from the face's own metrics, at the element's leading", () => {
    // U1-4 (plan R3 addendum): a grown box is drawn `lines x leading x size`
    // tall, but the face's content area (ascent + descent, `1lh` under
    // `line-height: normal`) can be taller than the leading's line box; the
    // last line's bottom half of that overhang is what Chromium counts as
    // overflow. The guard is that half, never below zero — a CSS length the
    // browser resolves from the face, not a constant.
    expect(inkGuardCss()).toBe(`max(0px, (1lh - ${DEFAULT_LINE_HEIGHT}em) / 2)`);
    expect(inkGuardCss(1.5)).toBe("max(0px, (1lh - 1.5em) / 2)");
    expect(inkGuardCss(0)).toBe(inkGuardCss());
  });

  it("shrinks type only when told to, and never below a quarter", () => {
    const long = "가나다라마바사아자차카타파하 ".repeat(40);
    const shrinks: SlideElement = { id: "a", type: "text", x: 5, y: 10, w: 20, h: 4, fontSize: 40, text: long, autofit: "text" };
    expect(textFitScale(shrinks)).toBe(MIN_FIT_SCALE);
    expect(textFitScale({ ...shrinks, autofit: "shape" })).toBe(1);
    expect(textFitScale({ ...shrinks, autofit: undefined })).toBe(1);
  });
});

describe("the snug one-line width (U3 snug fit)", () => {
  // A snug one-liner is measured the way it is drawn. A bullet paragraph is
  // one fixed BULLET_HANG_EM marker plus its body in the element's face —
  // never the "• " prefix's own glyph advances, which are narrower in every
  // Latin and KR face (0.564 em in Noto Sans CJK KR) than the 1.2 em marker
  // `FittedText` and the print sheet draw, so a fit computed from them left
  // the drawn line wider than the box and clipped its last glyph. Plain text
  // is measured as-is. Browser-only, like `inkGuardCss`: the file has no
  // snug fit, so the Python twin has no counterpart.
  const advance = (text: string) => Array.from(text).length * 10;

  it("measures a bullet paragraph as the fixed marker plus its body", () => {
    expect(snugLineWidth({ text: "가나다라마", bullet: true }, 24, advance)).toBeCloseTo(BULLET_HANG_EM * 24 + 50, 6);
    expect(snugLineWidth(bulletParagraphs("• 가나다라마")![0], 24, advance)).toBeCloseTo(28.8 + 50, 6);
  });

  it("measures plain text as-is, unchanged", () => {
    expect(snugLineWidth({ text: "가나다라마", bullet: false }, 24, advance)).toBe(50);
    expect(snugLineWidth({ text: "• 가나다라마", bullet: false }, 24, advance)).toBe(70);
  });

  it("scales the marker with the drawn size (a thumbnail), not the stored one", () => {
    expect(snugLineWidth({ text: "a", bullet: true }, 6, advance)).toBeCloseTo(7.2 + 10, 6);
  });
});
