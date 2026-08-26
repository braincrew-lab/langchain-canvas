/**
 * Painting a Word shape with the colours its own file states.
 *
 * The rules under test are the ones that keep the paint honest: a shape is
 * matched to its file by where it sits rather than by its turn in a list, only
 * the colours the file states are used, and shapes the pass does not handle
 * are left exactly as the renderer drew them.
 */

import { describe, expect, it } from "vitest";

import { paintVmlShapes } from "./docxVmlPaint";

const VML = 'xmlns:v="urn:schemas-microsoft-com:vml"';

function partXml(body: string): Document {
  return new DOMParser().parseFromString(`<root ${VML}>${body}</root>`, "application/xml");
}

const AT = "position:absolute;margin-left:0;margin-top:1.75pt;width:20.1pt;height:17.6pt";

/** The same place, spelled the way a browser gives it back. */
const AT_RENDERED =
  "position: absolute; margin-left: 0px; margin-top: 1.75pt; width: 20.1pt; height: 17.6pt;";

function page(svgs: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = svgs;
  return host;
}

const RING = (style = AT_RENDERED) =>
  `<svg style="${style}"><ellipse cx="50%" cy="50%" rx="50%" ry="50%"></ellipse></svg>`;

describe("paintVmlShapes", () => {
  it("gives an outlined shape its outline", () => {
    const host = page(RING());
    const xml = partXml(`<v:oval style="${AT}" filled="f" strokecolor="black [3213]"/>`);
    expect(paintVmlShapes(host, [xml])).toBe(1);
    const ring = host.querySelector("ellipse") as SVGElement;
    expect(ring.style.fill).toBe("none");
    expect(ring.style.stroke).toBe("black");
    expect(ring.style.strokeWidth).toBe("0.75pt");
  });

  it("keeps the width the file states", () => {
    const host = page(RING());
    const xml = partXml(`<v:oval style="${AT}" strokecolor="#c00000" strokeweight="2.5pt"/>`);
    paintVmlShapes(host, [xml]);
    expect((host.querySelector("ellipse") as SVGElement).style.strokeWidth).toBe("2.5pt");
  });

  it("paints a plain fill", () => {
    const host = page(RING());
    const xml = partXml(`<v:oval style="${AT}" fillcolor="#c00000"/>`);
    paintVmlShapes(host, [xml]);
    expect((host.querySelector("ellipse") as SVGElement).style.fill).toBe("#c00000");
  });

  it("leaves a gradient fill alone", () => {
    const host = page(RING());
    const xml = partXml(
      `<v:oval style="${AT}"><v:fill type="gradient" color="#c00000"/></v:oval>`,
    );
    expect(paintVmlShapes(host, [xml])).toBe(0);
    expect((host.querySelector("ellipse") as SVGElement).style.fill).toBe("");
  });

  it("invents no colour for a shape that states none", () => {
    const host = page(RING());
    expect(paintVmlShapes(host, [partXml(`<v:oval style="${AT}"/>`)])).toBe(0);
  });

  it("says a shape has no outline when the file does", () => {
    const host = page(RING());
    const xml = partXml(`<v:oval style="${AT}" fillcolor="red" stroked="f"/>`);
    paintVmlShapes(host, [xml]);
    const ring = host.querySelector("ellipse") as SVGElement;
    expect(ring.style.stroke).toBe("none");
  });

  it("matches a shape by its place, not by its turn", () => {
    const elsewhere = "position:absolute;margin-left:90pt;margin-top:1.75pt;width:20.1pt;height:17.6pt";
    const host = page(RING());
    const xml = partXml(
      // A shape the renderer cannot draw comes first; pairing in order would
      // put its colour on the ring.
      `<v:curve style="${elsewhere}" strokecolor="red"/>` +
        `<v:oval style="${AT}" strokecolor="blue"/>`,
    );
    paintVmlShapes(host, [xml]);
    expect((host.querySelector("ellipse") as SVGElement).style.stroke).toBe("blue");
  });

  it("pairs shapes that share a place in the order they appear", () => {
    const host = page(RING() + RING());
    const xml = partXml(
      `<v:oval style="${AT}" strokecolor="red"/><v:oval style="${AT}" strokecolor="blue"/>`,
    );
    expect(paintVmlShapes(host, [xml])).toBe(2);
    const [first, second] = Array.from(host.querySelectorAll("ellipse")) as SVGElement[];
    expect(first.style.stroke).toBe("red");
    expect(second.style.stroke).toBe("blue");
  });

  it("leaves a shape whose place does not match", () => {
    const host = page(RING("position: absolute; margin-left: 40pt; width: 20.1pt;"));
    const xml = partXml(`<v:oval style="${AT}" strokecolor="blue"/>`);
    expect(paintVmlShapes(host, [xml])).toBe(0);
  });

  it("leaves the shape kinds it does not handle", () => {
    const host = page(`<svg style="${AT_RENDERED}"><line x1="0" y1="0" x2="9" y2="9"></line></svg>`);
    const xml = partXml(`<v:line style="${AT}" strokecolor="blue"/>`);
    expect(paintVmlShapes(host, [xml])).toBe(0);
  });

  it("does nothing when the file was not kept", () => {
    const host = page(RING());
    expect(paintVmlShapes(host, [])).toBe(0);
  });

  it("reads a rectangle as a rectangle", () => {
    const host = page(`<svg style="${AT_RENDERED}"><rect width="100%" height="100%"></rect></svg>`);
    const xml = partXml(`<v:rect style="${AT}" strokecolor="blue"/>`);
    expect(paintVmlShapes(host, [xml])).toBe(1);
  });
});
