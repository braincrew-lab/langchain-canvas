import { describe, expect, it } from "vitest";

import { shapeStyle } from "./FreeSlide";

describe("a line shape is drawn by its stroke", () => {
  it("paints the stroke colour when there is no fill, with a visible thickness", () => {
    const style = shapeStyle({ id: "l", type: "shape", shape: "line", x: 8, y: 52, w: 80, h: 0.2, stroke: "#FD7F00", strokeWidth: 2 });
    expect(style.background).toBe("#FD7F00");
    expect(style.minHeight).toBe("2px");
  });

  it("still prefers an explicit fill, and leaves boxes outline-only", () => {
    expect(shapeStyle({ id: "l", type: "shape", shape: "line", x: 0, y: 0, w: 10, h: 1, fill: "#000", stroke: "#fff" }).background).toBe("#000");
    const box = shapeStyle({ id: "b", type: "shape", shape: "rect", x: 0, y: 0, w: 10, h: 10, stroke: "#f00" });
    expect(box.background).toBe("transparent");
    expect(String(box.border)).toContain("#f00");
  });
});
