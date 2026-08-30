/**
 * The text estimate, held to the golden cases the Python twin
 * (`canvas-py/src/langchain_canvas/slide_text.py`) computes. Change the
 * estimate on one side only and one of the two suites fails.
 */

import { describe, expect, it } from "vitest";

import type { SlideElement } from "../protocol/artifacts";
import golden from "./slideText.golden.json";
import { boxHeightPct, fitScale, grownHeightPct, MIN_FIT_SCALE, PAGE_W_PX, textFitScale, wrappedLines } from "./slideText";

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

  it("draws a growing box at the height its text needs, and a fixed one as stored", () => {
    const long = "가나다라마바사아자차카타파하 ".repeat(8);
    const grows: SlideElement = { id: "a", type: "text", x: 5, y: 10, w: 40, h: 5, fontSize: 24, text: long, autofit: "shape" };
    const fixed: SlideElement = { ...grows, id: "b", autofit: undefined };
    expect(boxHeightPct(grows)).toBeGreaterThan(20);
    expect(boxHeightPct(fixed)).toBe(5);
    expect(boxHeightPct({ ...grows, text: "hi" })).toBe(5);
  });

  it("shrinks type only when told to, and never below a quarter", () => {
    const long = "가나다라마바사아자차카타파하 ".repeat(40);
    const shrinks: SlideElement = { id: "a", type: "text", x: 5, y: 10, w: 20, h: 4, fontSize: 40, text: long, autofit: "text" };
    expect(textFitScale(shrinks)).toBe(MIN_FIT_SCALE);
    expect(textFitScale({ ...shrinks, autofit: "shape" })).toBe(1);
    expect(textFitScale({ ...shrinks, autofit: undefined })).toBe(1);
  });
});
