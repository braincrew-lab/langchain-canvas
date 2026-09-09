import { act, createElement } from "react";
// @ts-expect-error — react-dom ships no types here and this package adds no
// devDependency for a single test; the runtime import is real.
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlideElement } from "../../protocol/artifacts";
import { BULLET_HANG_EM, DEFAULT_LINE_HEIGHT } from "../../client/slideText";
import { FittedText, shapeStyle, SlideTable, textBoxStyle, textStyle } from "./FreeSlide";

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

describe("square corners (U4)", () => {
  it("a rectangle and a line have square corners like the file", () => {
    // The file writes `prst="rect"` (square) and a straight connector; the
    // browser surfaces must not round what the file draws square. An ellipse
    // keeps its 50 %.
    const rect = shapeStyle({ id: "r", type: "shape", shape: "rect", x: 5, y: 48, w: 30, h: 10, fill: "#00aa00" });
    const line = shapeStyle({ id: "l", type: "shape", shape: "line", x: 5, y: 62, w: 40, h: 2, fill: "#0000ff", strokeWidth: 2 });
    const ellipse = shapeStyle({ id: "e", type: "shape", shape: "ellipse", x: 0, y: 0, w: 10, h: 10, fill: "#000" });
    expect(rect.borderRadius ?? 0).toBe(0);
    expect(line.borderRadius ?? 0).toBe(0);
    expect(ellipse.borderRadius).toBe("50%");
  });
});

describe("a text element's leading (U2)", () => {
  // The estimator (`slideText.ts`), the print sheet and every browser surface
  // agree on one default; a box that names no `lineHeight` must carry it
  // explicitly instead of inheriting the host page's or a stylesheet's own.
  it("textStyle draws the shared default leading when the element names none", () => {
    const style = textStyle({ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: "a" });
    expect(style.lineHeight).toBe(1.2);
    expect(style.lineHeight).toBe(DEFAULT_LINE_HEIGHT);
  });

  it("textStyle keeps an explicit lineHeight", () => {
    const style = textStyle({ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: "a", lineHeight: 1.5 });
    expect(style.lineHeight).toBe(1.5);
  });
});

describe("a text element's box (U1 ink guard)", () => {
  // A box that grows with its text is drawn at the estimator's height plus the
  // face-derived ink guard (plan R3 addendum): `1lh` on a `line-height: normal`
  // box is the face's content area, `L·1em` the line box the text child draws;
  // the last line's bottom half of the difference is what would otherwise be
  // counted as overflow. Fixed boxes and shrink-to-fit boxes never grow.
  const grown: SlideElement = {
    id: "g", type: "text", x: 5, y: 5, w: 40, h: 6, fontSize: 24, fontFamily: "Noto Sans CJK KR",
    text: "• " + "가".repeat(40), autofit: "shape",
  };

  it("draws a growing box at its grown height plus the guard, on a line-height: normal box", () => {
    const style = textBoxStyle(grown);
    expect(style.height).toBe("calc(16% + max(0px, (1lh - 1.2em) / 2))");
    expect(style.lineHeight).toBe("normal");
    expect(style.fontSize).toBe(24);
    expect(style.fontFamily).toBe("Noto Sans CJK KR");
  });

  it("scales the guard exactly once with the thumbnail's font size", () => {
    const style = textBoxStyle(grown, 0.25);
    expect(style.fontSize).toBe(6);
    expect(style.height).toBe("calc(16% + max(0px, (1lh - 1.2em) / 2))");
  });

  it("keeps an explicit leading in the guard", () => {
    const style = textBoxStyle({ ...grown, lineHeight: 1.5 });
    expect(style.height).toBe("calc(20% + max(0px, (1lh - 1.5em) / 2))");
  });

  it("a fixed box and a shrink-to-fit box keep their stored height and carry no guard", () => {
    expect(textBoxStyle({ ...grown, autofit: undefined })).toEqual({ height: "6%" });
    expect(textBoxStyle({ ...grown, autofit: "text" })).toEqual({ height: "6%" });
  });
});

describe("a bulleted text body (U3)", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function mountText(text: string): HTMLDivElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const el: SlideElement = { id: "t", type: "text", x: 0, y: 0, w: 50, h: 10, text, fontSize: 24 };
    act(() => root!.render(createElement(FittedText, { el, scale: 1, style: {} })));
    const body = host.firstElementChild as HTMLDivElement | null;
    if (!body) throw new Error("FittedText rendered nothing");
    return body;
  }

  it("draws one hanging block per bullet paragraph with exactly one fixed-width marker", () => {
    const body = mountText("• 하나\n• 둘");
    const blocks = Array.from(body.querySelectorAll<HTMLElement>(".cv-bullet"));
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.style.paddingLeft).toBe("1.2em");
      expect(block.style.textIndent).toBe("-1.2em");
      const markers = block.querySelectorAll<HTMLElement>(".cv-bullet__marker");
      expect(markers).toHaveLength(1);
      expect(markers[0].textContent).toBe("•");
      expect(markers[0].style.display).toBe("inline-block");
      expect(markers[0].style.width).toBe("1.2em");
      expect(parseFloat(markers[0].style.textIndent)).toBe(0);
    }
    expect(blocks[0].textContent).toBe("•하나");
    expect(body.textContent).not.toContain("• ");
  });

  it("keeps plain paragraphs as blocks beside bullets and holds an empty line open", () => {
    const body = mountText("• a\n\nb");
    const blocks = Array.from(body.children).map((node) => node.textContent);
    expect(blocks).toEqual(["•a", " ", "b"]);
  });

  it("renders a body with no bullet paragraph as plain text, as before", () => {
    const body = mountText("plain\ntext");
    expect(body.querySelector(".cv-bullet")).toBeNull();
    expect(body.children).toHaveLength(0);
    expect(body.textContent).toBe("plain\ntext");
  });
});

describe("a table cell's leading (U2)", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function mountCell(lineHeight?: number): HTMLTableCellElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const el = { id: "tbl", type: "table" as const, x: 0, y: 0, w: 50, h: 20, rows: [["a"]], ...(lineHeight ? { lineHeight } : {}) };
    act(() => root!.render(createElement(SlideTable, { el })));
    const td = host.querySelector("td");
    if (!td) throw new Error("SlideTable rendered no cell");
    return td;
  }

  it("draws the shared default leading when the element names none", () => {
    expect(mountCell().style.lineHeight).toBe(String(DEFAULT_LINE_HEIGHT));
  });

  it("keeps an explicit lineHeight", () => {
    expect(mountCell(1.5).style.lineHeight).toBe("1.5");
  });
});

describe("a snug bullet one-liner (U3 snug fit)", () => {
  // Chromium measures the real thing in `snugBullet.browser.test.ts`; jsdom
  // has no canvas, no layout and no ResizeObserver, so all three are stubbed
  // to arithmetic here — every glyph 10 px whatever the font, the box 65 px —
  // and this file pins the measurement RULE: a bullet one-liner is measured
  // as the fixed 1.2 em marker `FittedText` draws plus its body, not as the
  // "• " prefix's own glyphs.
  let root: ReturnType<typeof createRoot> | null = null;
  let host: HTMLDivElement | null = null;
  const hadResizeObserver = "ResizeObserver" in globalThis;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (!hadResizeObserver) delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
  });

  function mountSnug(text: string, boxPx: number): HTMLDivElement {
    if (!hadResizeObserver) {
      (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({ font: "", measureText: (s: string) => ({ width: Array.from(s).length * 10 }) }) as never,
    );
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { get: () => boxPx, configurable: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const el: SlideElement = { id: "s", type: "text", x: 5, y: 5, w: 12.5, h: 6, text, fontSize: 24, fontFamily: "Noto Sans CJK KR" };
    act(() => root!.render(createElement(FittedText, { el, scale: 1, style: {} })));
    const body = host.firstElementChild as HTMLDivElement | null;
    if (!body) throw new Error("FittedText rendered nothing");
    return body;
  }

  it("fits the line to the box measured as the 1.2em marker plus the body, not as the prefix's glyphs", () => {
    // marker 1.2 x 24 = 28.8 + body 50 = 78.8 px in a 65 px box (window 79.3):
    // the fit is 65 / 78.8. Measured as "• 가나다라마" (70 px) the fit was
    // 65 / 70 and the drawn line, 78.8 x 65 / 70 = 73.2 px, overran the box.
    const body = mountSnug("• 가나다라마", 65);
    const needed = BULLET_HANG_EM * 24 + 50;
    expect(body.style.whiteSpace).toBe("nowrap");
    expect(parseFloat(body.style.fontSize)).toBeCloseTo(24 * (65 / needed), 6);
    expect(body.querySelector(".cv-bullet__marker")?.textContent).toBe("•");
  });

  it("still fits a plain one-liner exactly as before", () => {
    const body = mountSnug("가나다라마바사", 65); // 70 px in a 65 px box
    expect(body.style.whiteSpace).toBe("nowrap");
    expect(parseFloat(body.style.fontSize)).toBeCloseTo(24 * (65 / 70), 6);
  });
});
