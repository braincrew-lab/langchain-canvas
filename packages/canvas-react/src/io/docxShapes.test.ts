/**
 * Counting shapes a Word file draws, and how many of them the reader can see.
 *
 * The rules under test are the ones that keep the count honest: one object is
 * one shape however many times the file writes it, a shape with no fill and no
 * outline is not missing, and a shape that was rendered but paints nothing is
 * not shown.
 */

import { describe, expect, it } from "vitest";

import { paints, shapesAskedFor, shapesShown, tallyShapes } from "./docxShapes";

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
].join(" ");

function partXml(body: string): Document {
  return new DOMParser().parseFromString(
    `<w:document ${NS}><w:body>${body}</w:body></w:document>`,
    "application/xml",
  );
}

/** A shape written twice — once modern, once legacy — as Word writes it. */
const PAIRED_OVAL = `
  <w:r><mc:AlternateContent>
    <mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="255270" cy="223520"/>
      <a:graphic><a:graphicData><wps:wsp><wps:spPr><a:prstGeom prst="ellipse"/></wps:spPr></wps:wsp></a:graphicData></a:graphic>
    </wp:anchor></w:drawing></mc:Choice>
    <mc:Fallback><w:pict><v:oval id="oval1" style="width:20pt;height:18pt" filled="f" strokecolor="black [3213]"/></w:pict></mc:Fallback>
  </mc:AlternateContent></w:r>`;

const PICTURE = `
  <w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/>
    <a:graphic><a:graphicData><pic:pic><pic:blipFill/></pic:pic></a:graphicData></a:graphic>
  </wp:inline></w:drawing></w:r>`;

/** A rendered document: SVG shapes the way the preview writes them. */
function drawn(...svgs: string[]): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = svgs.map((s) => `<svg style="width:20pt;height:18pt">${s}</svg>`).join("");
  document.body.replaceChildren(host);
  return host;
}

describe("shapesAskedFor", () => {
  it("counts a shape written twice as one shape", () => {
    // Word writes the modern form and a legacy twin for older readers. Two
    // spellings of one circle is still one circle.
    expect(shapesAskedFor(partXml(PAIRED_OVAL))).toBe(1);
    expect(shapesAskedFor(partXml(PAIRED_OVAL + PAIRED_OVAL))).toBe(2);
  });

  it("counts a legacy shape standing on its own", () => {
    const xml = partXml(`<w:r><w:pict><v:rect id="r1" fillcolor="red"/></w:pict></w:r>`);
    expect(shapesAskedFor(xml)).toBe(1);
  });

  it("counts a modern shape with no legacy twin — the one that vanishes", () => {
    const xml = partXml(`
      <w:r><w:drawing><wp:anchor><wp:extent cx="1" cy="1"/>
        <a:graphic><a:graphicData><wps:wsp/></a:graphicData></a:graphic>
      </wp:anchor></w:drawing></w:r>`);
    expect(shapesAskedFor(xml)).toBe(1);
  });

  it("leaves pictures out — they are not shapes and have their own path", () => {
    expect(shapesAskedFor(partXml(PICTURE))).toBe(0);
    expect(shapesAskedFor(partXml(PICTURE + PAIRED_OVAL))).toBe(1);
  });

  it("does not count a shape the file itself draws nothing for", () => {
    // No fill and no outline: Word shows nothing here either, so a preview
    // showing nothing is right and must not claim something is missing.
    const xml = partXml(
      `<w:r><w:pict><v:oval id="o" filled="f" stroked="f"/></w:pict></w:r>`,
    );
    expect(shapesAskedFor(xml)).toBe(0);
  });

  it("counts a group as one shape, not one per shape inside it", () => {
    const xml = partXml(
      `<w:r><w:pict><v:group id="g"><v:oval id="a"/><v:rect id="b"/></v:group></w:pict></w:r>`,
    );
    expect(shapesAskedFor(xml)).toBe(1);
  });

  it("counts nothing in a document that draws nothing", () => {
    expect(shapesAskedFor(partXml(`<w:p><w:r><w:t>plain text</w:t></w:r></w:p>`))).toBe(0);
  });
});

describe("shapesShown", () => {
  it("counts a shape with ink in it", () => {
    expect(shapesShown(drawn(`<ellipse fill="red"/>`))).toBe(1);
    expect(shapesShown(drawn(`<ellipse fill="none" stroke="black"/>`))).toBe(1);
  });

  it("does not count a shape that was rendered and paints nothing", () => {
    // Present in the markup, invisible to the reader. Only the reader counts.
    expect(shapesShown(drawn(`<ellipse fill="none" stroke="none"/>`))).toBe(0);
    expect(shapesShown(drawn(`<ellipse fill="transparent"/>`))).toBe(0);
    expect(shapesShown(drawn(`<ellipse/>`, `<rect fill="rgba(0,0,0,0)"/>`))).toBe(0);
  });

  it("counts a picture or a text box as carrying content", () => {
    expect(shapesShown(drawn(`<image href="x.png"/>`))).toBe(1);
  });

  it("does not read a colour channel as transparency", () => {
    // `rgb(192, 0, 0)` ends in a zero that is the blue channel. Reading it as
    // alpha would call a solid red shape invisible.
    expect(shapesShown(drawn(`<ellipse fill="rgb(192, 0, 0)"/>`))).toBe(1);
    expect(shapesShown(drawn(`<ellipse fill="rgb(0, 0, 0)"/>`))).toBe(1);
    expect(shapesShown(drawn(`<ellipse fill="none" stroke="rgb(0, 0, 0)"/>`))).toBe(1);
    expect(shapesShown(drawn(`<ellipse fill="rgba(192, 0, 0, 0)"/>`))).toBe(0);
    expect(shapesShown(drawn(`<ellipse fill="rgb(0 0 0 / 0)"/>`))).toBe(0);
    expect(shapesShown(drawn(`<ellipse fill="rgb(0 0 0 / 50%)"/>`))).toBe(1);
  });

  it("counts nothing on a page with no shapes", () => {
    const host = document.createElement("div");
    host.innerHTML = "<p>plain text</p>";
    expect(shapesShown(host)).toBe(0);
  });
});

describe("paints", () => {
  it("reads what the reader sees, not what the markup claims", () => {
    const host = drawn(`<ellipse fill="black"/>`);
    const ellipse = host.querySelector("ellipse")!;
    expect(paints(ellipse)).toBe(true);
    ellipse.setAttribute("fill", "none");
    ellipse.removeAttribute("stroke");
    expect(paints(ellipse)).toBe(false);
  });
});

describe("tallyShapes", () => {
  it("reports the gap between what is asked for and what is shown", () => {
    const host = drawn(`<ellipse fill="none" stroke="none"/>`);
    expect(tallyShapes(host, [partXml(PAIRED_OVAL + PAIRED_OVAL)])).toEqual({
      askedFor: 2,
      shown: 0,
      missing: 2,
    });
  });

  it("reports no gap when every shape is on the page", () => {
    const host = drawn(`<ellipse stroke="black"/>`);
    expect(tallyShapes(host, [partXml(PAIRED_OVAL)])).toEqual({
      askedFor: 1,
      shown: 1,
      missing: 0,
    });
  });

  it("never reports a negative gap", () => {
    const host = drawn(`<ellipse fill="red"/>`, `<ellipse fill="red"/>`);
    expect(tallyShapes(host, [partXml(PAIRED_OVAL)]).missing).toBe(0);
  });

  it("claims nothing without the stored parts to read", () => {
    const host = drawn(`<ellipse fill="none" stroke="none"/>`);
    expect(tallyShapes(host, [])).toEqual({ askedFor: 0, shown: 0, missing: 0 });
  });
});
