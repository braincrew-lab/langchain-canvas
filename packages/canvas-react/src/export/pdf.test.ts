/**
 * The print pipeline's snug one-line fit (`fitSnugLines`), run against a
 * jsdom document with the sheet's own markup. jsdom has no canvas and no
 * layout, so the 2D context and the box width are stubbed to arithmetic:
 * every glyph advances 10 px whatever the font, and the box is as wide as
 * the test says. The face-true measurements are the Chromium gate's
 * (`snugBullet.browser.test.ts`); this file pins the measurement RULE.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { BULLET_HANG_EM } from "../client/slideText";
import { fitSnugLines } from "./pdf";

function fakeContext(): CanvasRenderingContext2D {
  return { font: "", measureText: (text: string) => ({ width: Array.from(text).length * 10 }) } as unknown as CanvasRenderingContext2D;
}

describe("fitSnugLines (the print sheet's snug one-line fit)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** A `data-snug` box as `slidesToPrintHtml` writes it, `clientWidth` px wide. */
  function snugBox(inner: string, clientWidth: number): HTMLElement {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext() as never);
    const node = document.createElement("div");
    node.setAttribute("data-snug", "1");
    node.style.fontSize = "24px";
    node.style.fontWeight = "400";
    node.style.fontFamily = "Noto Sans CJK KR";
    node.innerHTML = inner;
    document.body.appendChild(node);
    Object.defineProperty(node, "clientWidth", { value: clientWidth, configurable: true });
    return node;
  }

  it("measures a bullet one-liner as the 1.2em marker plus its body, so the fitted line is the box", () => {
    // Body 5 glyphs (50 px) + the marker 1.2 x 24 = 78.8 px in a 70 px box:
    // inside the snug window (70 x 1.22 = 85.4), so the type shrinks to
    // 70 / 78.8 of 24 px and the drawn line — marker + body at the fitted
    // size — is exactly the box. Measuring the marker's own glyph instead
    // (10 px here, 0.34 em in the render font) read 60 px, fitted nothing,
    // and the sheet's 1.2 em marker pushed the last glyph past the box.
    const node = snugBox('<div class="p-bullet"><span class="p-bullet__marker">•</span>가나다라마</div>', 70);
    fitSnugLines(document);
    const needed = BULLET_HANG_EM * 24 + 50;
    expect(node.style.whiteSpace).toBe("nowrap");
    expect(parseFloat(node.style.fontSize)).toBeCloseTo(24 * (70 / needed), 6);
  });

  it("leaves a bullet one-liner past the snug window to wrap, as a real overflow should", () => {
    // marker 28.8 + 6 glyphs 60 = 88.8 > 70 x 1.22 = 85.4.
    const node = snugBox('<div class="p-bullet"><span class="p-bullet__marker">•</span>가나다라마바</div>', 70);
    fitSnugLines(document);
    expect(node.style.whiteSpace).toBe("");
    expect(node.style.fontSize).toBe("24px");
  });

  it("measures plain text as-is, as before", () => {
    const node = snugBox("가나다라마바사", 65); // 70 px in a 65 px box
    fitSnugLines(document);
    expect(node.style.whiteSpace).toBe("nowrap");
    expect(parseFloat(node.style.fontSize)).toBeCloseTo(24 * (65 / 70), 6);
  });
});

describe("fitSnugLines measures with the frame's own document", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("creates its measuring canvas on the document it fits, not on the host", () => {
    // The sheet's faces belong to the print frame's document; a canvas made
    // by the host document measures with the host's faces (or a fallback the
    // frame never draws), so the fit would be computed for the wrong font.
    // jsdom gives the frame its own realm, so both realms' canvas classes
    // are watched; whichever document made the canvas is recorded.
    const owners: Document[] = [];
    const record = function (this: HTMLCanvasElement) {
      owners.push(this.ownerDocument);
      return fakeContext() as never;
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(record);
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const frameDoc = iframe.contentDocument;
    const frameWin = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!frameDoc || !frameWin) throw new Error("jsdom gave the iframe no document");
    vi.spyOn(frameWin.HTMLCanvasElement.prototype, "getContext").mockImplementation(record);
    const node = frameDoc.createElement("div");
    node.setAttribute("data-snug", "1");
    node.style.fontSize = "24px";
    node.textContent = "가나다라마바사";
    frameDoc.body.appendChild(node);
    Object.defineProperty(node, "clientWidth", { value: 65, configurable: true });
    fitSnugLines(frameDoc);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toBe(frameDoc);
    expect(owners[0]).not.toBe(document);
    expect(node.style.whiteSpace).toBe("nowrap");
  });
});
