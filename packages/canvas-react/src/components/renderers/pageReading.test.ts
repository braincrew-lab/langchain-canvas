import { describe, expect, it } from "vitest";
import { pageDisplayWidth, parsePageDestination, readingScrollPosition } from "./pageReading";

describe("page fit", () => {
  it("fits portrait and non-widescreen slides using their real aspect ratio", () => {
    expect(pageDisplayWidth("page", 1000, 600, 3 / 4)).toBe(450);
    expect(pageDisplayWidth("page", 1000, 600, 4 / 3)).toBe(800);
    expect(pageDisplayWidth("page", 400, 600, 16 / 9)).toBe(400);
  });

  it("keeps width-fit independent of height and baseline zoom independent of container size", () => {
    expect(pageDisplayWidth("width", 1000, 300, 3 / 4)).toBe(1000);
    expect(pageDisplayWidth(1.2, 320, 300, 3 / 4)).toBe(1920);
  });
});

describe("page destination", () => {
  it.each([["1", 1], [" 03 ", 3], ["0", 1], ["999", 8]])("accepts and clamps %s", (input, result) => {
    expect(parsePageDestination(String(input), 8)).toBe(result);
  });
  it.each(["", " ", "-1", "2.5", "1e2", "3 pages", "Infinity", "9007199254740992"])("rejects %s rather than partially parsing it", (input) => {
    expect(parsePageDestination(input, 8)).toBeNull();
  });
});

describe("reading center", () => {
  it("preserves the same point in a page when both axes grow", () => {
    expect(readingScrollPosition({ page: 2, x: 0.6, y: 0.75 },
      { left: 24, top: 2024, width: 1760, height: 2200 }, { width: 1000, height: 600 }))
      .toEqual({ left: 580, top: 3374 });
  });
  it("clamps a centered short first page without introducing negative scroll", () => {
    expect(readingScrollPosition({ page: 1, x: 0.5, y: 0.5 },
      { left: 100, top: 24, width: 400, height: 300 }, { width: 1000, height: 600 }))
      .toEqual({ left: 0, top: 0 });
  });
});
