import { describe, expect, it, vi } from "vitest";

import { afterRenderCell, beforeRenderCell, openWebLink, patternTile } from "./sheetPaint";

const box = { row: 0, column: 0, startX: 10, startY: 20, endX: 110, endY: 40 };

/** A 2D context that records what was asked of it. */
function recorder() {
  const calls: string[] = [];
  const gradient = { stops: [] as Array<[number, string]>, addColorStop(p: number, c: string) { this.stops.push([p, c]); } };
  const ctx = {
    fillStyle: "#FFFFFF" as unknown,
    calls,
    gradient,
    createPattern: vi.fn(() => ({ kind: "pattern" })),
    createLinearGradient: vi.fn((...args: number[]) => { calls.push(`linear:${args.map((n) => Math.round(n)).join(",")}`); return gradient; }),
    createRadialGradient: vi.fn(() => { calls.push("radial"); return gradient; }),
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    arc: () => calls.push("arc"),
    fill: () => calls.push("fill"),
    translate: () => calls.push("translate"),
    rotate: (a: number) => calls.push(`rotate:${a.toFixed(2)}`),
    fillRect: () => calls.push("fillRect"),
  };
  return ctx as unknown as CanvasRenderingContext2D & typeof ctx;
}

describe("sheetPaint", () => {
  it("should leave a plain cell alone", () => {
    const ctx = recorder();
    expect(beforeRenderCell({ bg: "#FF0000" }, box, ctx)).toBe(true);
    expect(ctx.fillStyle).toBe("#FFFFFF");
    afterRenderCell(null, box, ctx);
    expect(ctx.calls).toEqual([]);
  });

  it("should swap the background brush for a gradient across the cell", () => {
    const ctx = recorder();
    beforeRenderCell({ lcx: { fill: { gradient: "linear", degree: 0, stops: [[0, "#4472C4"], [1, "#FFFFFF"]] } } }, box, ctx);
    expect(ctx.calls).toContain("linear:10,30,110,30");
    expect(ctx.gradient.stops).toEqual([[0, "#4472C4"], [1, "#FFFFFF"]]);
    expect(ctx.fillStyle).toBe(ctx.gradient);
  });

  it("should run a 90-degree gradient top to bottom", () => {
    const ctx = recorder();
    beforeRenderCell({ lcx: { fill: { gradient: "linear", degree: 90, stops: [[0, "#FFF2CC"], [1, "#ED7D31"]] } } }, box, ctx);
    expect(ctx.calls).toContain("linear:60,20,60,40");
  });

  it("should fill a pattern with a repeating tile", () => {
    const tileCtx = { fillStyle: "", fillRect: vi.fn() };
    const tile = patternTile("lightDown", "#4472C4", "#FFFFFF", () => ({ getContext: () => tileCtx }) as unknown as HTMLCanvasElement);
    expect(tile).not.toBeNull();
    // background first (one full tile), then the ink pixels of the diagonal
    expect(tileCtx.fillRect).toHaveBeenNthCalledWith(1, 0, 0, 8, 8);
    expect(tileCtx.fillRect.mock.calls.length).toBe(1 + 16);
  });

  it("should draw a data bar as a hard-stop gradient over the background", () => {
    const ctx = recorder();
    beforeRenderCell({ lcx: { bar: { ratio: 0.25, color: "#638EC6" } } }, box, ctx);
    expect(ctx.gradient.stops.map(([p]) => p)).toEqual([0, 0.25, 0.25, 1]);
    expect(ctx.gradient.stops[0][1]).toBe("#638EC6");
    expect(ctx.gradient.stops[3][1]).toBe("#FFFFFF");
  });

  it("should point the lowest arrow down and the highest up", () => {
    const low = recorder();
    afterRenderCell({ lcx: { icon: { set: "3Arrows", index: 0 } } }, box, low);
    expect(low.calls).toContain("rotate:1.57");
    const high = recorder();
    afterRenderCell({ lcx: { icon: { set: "3Arrows", index: 2 } } }, box, high);
    expect(high.calls).toContain("rotate:-1.57");
  });

  it("should draw the list arrow at the right edge", () => {
    const ctx = recorder();
    afterRenderCell({ lcx: { dropdown: true } }, box, ctx);
    expect(ctx.calls.filter((c) => c === "lineTo").length).toBe(2);
    expect(ctx.calls).toContain("fill");
  });

  it("should open only web and mail links, in a new tab without an opener", () => {
    const open = vi.fn();
    expect(openWebLink("https://www.shinhan.com", open as never)).toBe(true);
    expect(open).toHaveBeenCalledWith("https://www.shinhan.com", "_blank", "noopener,noreferrer");
    expect(openWebLink("javascript:alert(1)", open as never)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
