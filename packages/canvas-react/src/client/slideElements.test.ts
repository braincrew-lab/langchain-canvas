/**
 * The derived slide layout — and the shared golden fixture the Python twin
 * (`canvas-py/src/langchain_canvas/slide_layout.py`) is held to by its own
 * suite. Change the layout on one side only and one of the two suites fails.
 */

import { describe, expect, it } from "vitest";

import type { Slide, SlideElement, SlidePage } from "../protocol/artifacts";
import golden from "./derivedLayout.golden.json";
import { BODY_RAMP, FONT_DISPLAY, FONT_TITLE, resolveElements, toElements } from "./slideElements";

const SCALE = new Set([FONT_DISPLAY, FONT_TITLE, ...BODY_RAMP]);
const BODY_BOTTOM = 88;

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** The wire shape the fixture stores: no undefined keys, floats rounded. */
const onWire = (el: SlideElement) =>
  Object.fromEntries(
    Object.entries(el)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === "number" ? round6(v) : v]),
  );

const bulletsOf = (s: Slide, page?: SlidePage) => toElements(s, page).filter((e) => e.id.startsWith("bul"));
const listSlide = (n: number): Slide => ({ title: "Heading", bullets: Array.from({ length: n }, (_, i) => `point ${i}`) });

describe("the golden fixture", () => {
  it("has cases", () => expect(golden.length).toBeGreaterThan(0));

  for (const kase of golden as Array<{ name: string; slide: Slide; page?: SlidePage; elements: unknown[] }>) {
    it(`matches this implementation: ${kase.name}`, () => {
      expect(toElements(kase.slide, kase.page).map(onWire)).toEqual(kase.elements);
    });
  }
});

describe("resolveElements", () => {
  it("returns the explicit elements untouched", () => {
    const explicit: SlideElement[] = [{ id: "a", type: "text", x: 1, y: 2, w: 3, h: 4, text: "hi" }];
    expect(resolveElements({ title: "ignored", elements: explicit })).toBe(explicit);
  });

  it("derives when a slide carries none", () => {
    expect(resolveElements({ title: "T" }).map((e) => e.id)).toEqual(["title"]);
  });
});

describe("the body block", () => {
  it("keeps ids stable across calls", () => {
    const s: Slide = { title: "T", bullets: ["a", "b"] };
    expect(toElements(s).map((e) => e.id)).toEqual(toElements(s).map((e) => e.id));
  });

  it.each([3, 4, 5, 6, 8, 10])("reaches the bottom of its band with %i bullets", (n) => {
    const bullets = bulletsOf(listSlide(n));
    expect(bullets).toHaveLength(n);
    const last = bullets[bullets.length - 1];
    expect(last.y + last.h).toBeCloseTo(BODY_BOTTOM, 2);
  });

  it.each([1, 2, 3, 4, 6, 9, 14, 25, 40])("never leaves the page with %i bullets", (n) => {
    for (const el of bulletsOf(listSlide(n))) {
      expect(el.y).toBeGreaterThanOrEqual(0);
      expect(el.y + el.h).toBeLessThanOrEqual(100.01);
    }
  });

  it.each([1, 2, 3, 4, 6, 9, 14, 25])("does not overlap with %i bullets", (n) => {
    const bullets = bulletsOf(listSlide(n));
    for (let i = 1; i < bullets.length; i += 1) {
      expect(bullets[i].y).toBeGreaterThanOrEqual(bullets[i - 1].y + bullets[i - 1].h - 0.01);
    }
  });

  it("gives every bullet on a slide one size", () => {
    const sizes = new Set(
      bulletsOf({
        title: "Mixed lengths",
        bullets: ["short", "a bullet long enough that it has to wrap onto a second line inside its box", "another"],
      }).map((e) => e.fontSize),
    );
    expect(sizes.size).toBe(1);
  });

  it("gives a wrapping bullet a box tall enough for both lines", () => {
    const [short, long] = bulletsOf({
      title: "T",
      bullets: ["short", "a bullet long enough that it has to wrap onto a second line inside its box"],
    });
    expect(long.h).toBeCloseTo(short.h * 2, 6);
  });

  it("steps the ramp down as a slide fills", () => {
    expect(bulletsOf(listSlide(3))[0].fontSize).toBe(BODY_RAMP[0]);
    expect(bulletsOf(listSlide(12))[0].fontSize!).toBeLessThan(bulletsOf(listSlide(3))[0].fontSize!);
  });
});

describe("the type scale", () => {
  it("covers every size the layout emits", () => {
    const slides: Slide[] = [
      { layout: "title", title: "Cover", subtitle: "Sub" },
      { layout: "section", title: "Part two" },
      { title: "Heading", subtitle: "Under it", bullets: ["a", "b", "c"] },
      { layout: "two-column", title: "T", bullets: ["a"], bullets2: ["b", "c"] },
      ...[1, 3, 5, 8, 12, 20].map(listSlide),
    ];
    for (const s of slides) {
      for (const el of toElements(s)) {
        if (el.fontSize) expect(SCALE.has(el.fontSize)).toBe(true);
      }
    }
  });
});

describe("layouts", () => {
  it("draws a subtitle on a content slide", () => {
    const ids = toElements({ title: "Heading", subtitle: "A line under it", bullets: ["a"] }).map((e) => e.id);
    expect(ids.slice(0, 2)).toEqual(["title", "subtitle"]);
  });

  it("pushes the body down for a wrapping title", () => {
    const long = "A heading long enough that it has to wrap onto a second line to fit the box";
    expect(bulletsOf({ title: long, bullets: ["a", "b", "c", "d", "e", "f"] })[0].y).toBeGreaterThan(
      bulletsOf({ title: "Short", bullets: ["a", "b", "c", "d", "e", "f"] })[0].y,
    );
  });

  it("gives both columns one size", () => {
    const sizes = new Set(
      toElements({
        layout: "two-column",
        title: "Compare",
        bullets: ["one"],
        bullets2: Array.from({ length: 8 }, (_, i) => `a longer line number ${i}`),
      })
        .filter((e) => e.id.startsWith("bul"))
        .map((e) => e.fontSize),
    );
    expect(sizes.size).toBe(1);
  });

  it("centres a cover's title and subtitle", () => {
    const els = toElements({ layout: "title", title: "Cover", subtitle: "Sub" });
    const top = Math.min(...els.map((e) => e.y));
    const bottom = Math.max(...els.map((e) => e.y + e.h));
    expect(top).toBeCloseTo(100 - bottom, 2);
  });

  it("derives nothing from an empty slide", () => {
    expect(toElements({})).toEqual([]);
  });
});

describe("the deck page", () => {
  it("gives a taller page shorter boxes in percent", () => {
    const s: Slide = { title: "T", bullets: ["one"] };
    expect(bulletsOf(s, { widthIn: 10, heightIn: 7.5 })[0].h).toBeLessThan(bulletsOf(s)[0].h);
  });

  it("falls back to the classic canvas for a malformed page", () => {
    const s: Slide = { title: "T", bullets: ["one"] };
    expect(bulletsOf(s, { widthIn: 0, heightIn: 0 })[0].h).toBe(bulletsOf(s)[0].h);
  });
});
