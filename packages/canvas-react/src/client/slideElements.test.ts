import { describe, expect, it } from "vitest";

import type { Slide } from "../protocol/artifacts";
import { resolveElements, toElements } from "./slideElements";

describe("toElements", () => {
  it("derives title + bullets with deterministic ids for the content layout", () => {
    const els = toElements({ title: "Q4", bullets: ["one", "two"] });
    expect(els.map((e) => e.id)).toEqual(["title", "bul_0", "bul_1"]);
    expect(els[0].text).toBe("Q4");
    expect(els[1].text).toBe("• one");
  });

  it("lays out two columns from bullets/bullets2", () => {
    const els = toElements({ layout: "two-column", title: "T", bullets: ["l"], bullets2: ["r"] });
    const ids = els.map((e) => e.id);
    expect(ids).toContain("bul_0");
    expect(ids).toContain("bul2_0");
    // second column sits to the right of the first
    const left = els.find((e) => e.id === "bul_0")!;
    const right = els.find((e) => e.id === "bul2_0")!;
    expect(right.x).toBeGreaterThan(left.x);
  });

  it("ids are stable across calls (safe as React keys)", () => {
    const s: Slide = { title: "T", bullets: ["a", "b"] };
    expect(toElements(s).map((e) => e.id)).toEqual(toElements(s).map((e) => e.id));
  });
});

describe("resolveElements", () => {
  it("prefers an explicit elements array once the user has edited", () => {
    const explicit = [{ id: "x", type: "text" as const, x: 1, y: 1, w: 1, h: 1, text: "edited" }];
    expect(resolveElements({ title: "ignored", elements: explicit })).toBe(explicit);
  });

  it("falls back to derived elements when none are explicit", () => {
    expect(resolveElements({ title: "T" }).map((e) => e.id)).toEqual(["title"]);
  });
});
