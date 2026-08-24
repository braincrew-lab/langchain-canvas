/** Deck page geometry — the editor box must mirror the exporters' contract. */

import { describe, expect, it } from "vitest";

import { DEFAULT_SLIDE_PAGE_IN, deckPage, fontScaleFor, pageAspect } from "./slidePage";

describe("deckPage", () => {
  it("falls back to the classic 16:9 canvas when page is absent", () => {
    expect(deckPage({})).toEqual(DEFAULT_SLIDE_PAGE_IN);
    expect(DEFAULT_SLIDE_PAGE_IN).toEqual({ widthIn: 10, heightIn: 5.625 });
  });

  it("returns the stored page as-is", () => {
    expect(deckPage({ page: { widthIn: 10, heightIn: 7.5 } })).toEqual({ widthIn: 10, heightIn: 7.5 });
    expect(deckPage({ page: { widthIn: 13.333, heightIn: 7.5 } })).toEqual({ widthIn: 13.333, heightIn: 7.5 });
  });

  it("rejects malformed dimensions instead of flipping or dividing by zero", () => {
    expect(deckPage({ page: { widthIn: 0, heightIn: 7.5 } })).toEqual(DEFAULT_SLIDE_PAGE_IN);
    expect(deckPage({ page: { widthIn: -4, heightIn: 3 } })).toEqual(DEFAULT_SLIDE_PAGE_IN);
    expect(deckPage({ page: { widthIn: NaN, heightIn: 7.5 } })).toEqual(DEFAULT_SLIDE_PAGE_IN);
  });
});

describe("pageAspect", () => {
  it("emits the CSS aspect-ratio value", () => {
    expect(pageAspect({ widthIn: 10, heightIn: 7.5 })).toBe("10 / 7.5");
    expect(pageAspect(DEFAULT_SLIDE_PAGE_IN)).toBe("10 / 5.625");
  });
});

describe("fontScaleFor", () => {
  it("is 1 when the box is exactly the page at 96dpi", () => {
    expect(fontScaleFor(960, { widthIn: 10, heightIn: 5.625 })).toBe(1);
    expect(fontScaleFor(1280, { widthIn: 13.333, heightIn: 7.5 })).toBeCloseTo(1, 3);
  });

  it("shrinks text in a narrower box, in proportion", () => {
    // The classic 780px panel box on the classic page: 780 / 960.
    expect(fontScaleFor(780, DEFAULT_SLIDE_PAGE_IN)).toBeCloseTo(0.8125, 6);
    // The same 780px box on a 4:3 page: 780 / 960 — width decides alone.
    expect(fontScaleFor(780, { widthIn: 10, heightIn: 7.5 })).toBeCloseTo(0.8125, 6);
  });

  it("keeps a safe 1 for an unmeasured box", () => {
    expect(fontScaleFor(0, DEFAULT_SLIDE_PAGE_IN)).toBe(1);
    expect(fontScaleFor(NaN, DEFAULT_SLIDE_PAGE_IN)).toBe(1);
  });
});
