/**
 * PPTX import tests. The fixtures are ZIPs assembled byte-by-byte in the test
 * (local headers + central directory + EOCD) around hand-written
 * PresentationML, so no binary fixture is checked into the repo.
 */

import { describe, expect, it } from "vitest";

import { pptxToSlides } from "./pptx";

const enc = new TextEncoder();

type ZipEntry = { name: string; data: Uint8Array; method: 0 | 8 };

/** Assemble a minimal valid ZIP (CRCs zeroed — the reader doesn't verify them). */
function makeZip(entries: ZipEntry[]): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const { name, data, method } of entries) {
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size (unused by reader)
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cdir = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdir.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdir.set(nameBytes, 46);
    central.push(cdir);

    offset += local.length + data.length;
  }

  const cdirSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdirSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) { out.set(c, pos); pos += c.length; }
  return out.buffer;
}

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Wrap spTree content (and an optional `p:bg`) into a full slide part. */
const slidePart = (spTree: string, bg = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS}><p:cSld>${bg}<p:spTree>${spTree}</p:spTree></p:cSld></p:sld>`;

/** A positioned text box; `rPr`/`pPr` are raw DrawingML property strings. */
const textSp = (text: string, { rPr = "", pPr = "" } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr>` +
  `<p:txBody><a:bodyPr/><a:p>${pPr}<a:r>${rPr}<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

/**
 * Assemble a whole deck: presentation.xml (12192000×6858000 EMU, sldIdLst in
 * `order`), its rels mapping rIdN → slideN.xml, the given slide parts, and any
 * per-slide rels / extra entries (media, notes).
 */
function makePptx(opts: {
  slides: string[];
  /** Slide numbers in `p:sldIdLst` order; defaults to 1..N. */
  order?: number[];
  /** Extra `<Relationship>` elements for slideN's own rels. */
  slideRels?: Record<number, string>;
  extra?: Record<string, Uint8Array>;
}): ArrayBuffer {
  const order = opts.order ?? opts.slides.map((_, i) => i + 1);
  const presentation =
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}>` +
    `<p:sldIdLst>${order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n}"/>`).join("")}</p:sldIdLst>` +
    `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`;
  const presRels =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships ${REL_NS}>` +
    opts.slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/slide" Target="slides/slide${i + 1}.xml"/>`).join("") +
    `</Relationships>`;

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc.encode("<Types/>"), method: 0 },
    { name: "ppt/presentation.xml", data: enc.encode(presentation), method: 0 },
    { name: "ppt/_rels/presentation.xml.rels", data: enc.encode(presRels), method: 0 },
  ];
  opts.slides.forEach((xml, i) => entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: enc.encode(xml), method: 0 }));
  for (const [num, rels] of Object.entries(opts.slideRels ?? {})) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Relationships ${REL_NS}>${rels}</Relationships>`;
    entries.push({ name: `ppt/slides/_rels/slide${num}.xml.rels`, data: enc.encode(xml), method: 0 });
  }
  for (const [name, data] of Object.entries(opts.extra ?? {})) entries.push({ name, data, method: 0 });
  return makeZip(entries);
}

// 1×1 transparent PNG — atob→btoa round-trips, so the data URL is predictable.
const PNG_1PX_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_1PX = Uint8Array.from(atob(PNG_1PX_B64), (c) => c.charCodeAt(0));

describe("pptxToSlides", () => {
  it("orders slides by sldIdLst, not by part file name", async () => {
    const { slides } = await pptxToSlides(makePptx({
      slides: [slidePart(textSp("One")), slidePart(textSp("Two"))],
      order: [2, 1],
    }));
    expect(slides).toHaveLength(2);
    expect(slides.map((s) => s.layout)).toEqual(["blank", "blank"]);
    expect(slides[0].elements?.[0].text).toBe("Two");
    expect(slides[1].elements?.[0].text).toBe("One");
  });

  it("maps the first run's rPr and paragraph algn onto the text element", async () => {
    const { slides } = await pptxToSlides(makePptx({
      slides: [slidePart(textSp("제목", {
        rPr: '<a:rPr lang="ko-KR" sz="2400" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>',
        pPr: '<a:pPr algn="ctr"/>',
      }))],
    }));
    const el = slides[0].elements?.[0];
    expect(el).toMatchObject({
      type: "text",
      text: "제목",
      fontSize: 24, // sz=2400 centipoints
      bold: true,
      color: "#FF0000",
      align: "center",
    });
  });

  it("converts EMU offsets/extents to percent of the slide size", async () => {
    // Slide is 12192000×6858000 EMU; off (1219200, 685800) is 10% of each
    // axis and ext (6096000, 3429000) is 50% — the textSp fixture's box.
    const { slides } = await pptxToSlides(makePptx({ slides: [slidePart(textSp("geo"))] }));
    const el = slides[0].elements?.[0];
    expect(el).toMatchObject({ x: 10, y: 10, w: 50, h: 50 });
  });

  it("reads the slide background solid fill", async () => {
    const bg = '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>';
    const { slides } = await pptxToSlides(makePptx({ slides: [slidePart(textSp("x"), bg)] }));
    expect(slides[0].background).toBe("#112233");
  });

  it("inlines a picture as a data URL via the slide's own rels", async () => {
    const pic =
      `<p:pic><p:nvPicPr><p:cNvPr id="3" name="img"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="rId7"/></p:blipFill>` +
      `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3048000" cy="1714500"/></a:xfrm></p:spPr></p:pic>`;
    const { slides } = await pptxToSlides(makePptx({
      slides: [slidePart(pic)],
      slideRels: { 1: `<Relationship Id="rId7" Type="${REL_TYPE}/image" Target="../media/image1.png"/>` },
      extra: { "ppt/media/image1.png": PNG_1PX },
    }));
    const el = slides[0].elements?.[0];
    expect(el).toMatchObject({ type: "image", x: 0, y: 0, w: 25, h: 25 });
    expect(el?.src).toBe(`data:image/png;base64,${PNG_1PX_B64}`);
  });

  it("maps text-less preset-geometry shapes with their fill (roundRect → radius)", async () => {
    const shapeSp = (prst: string, fill: string) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm>` +
      `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></p:spPr></p:sp>`;
    const { slides } = await pptxToSlides(makePptx({
      slides: [slidePart(shapeSp("rect", "00FF00") + shapeSp("roundRect", "0000FF") + shapeSp("ellipse", "ABCDEF"))],
    }));
    const [rect, round, ellipse] = slides[0].elements ?? [];
    expect(rect).toMatchObject({ type: "shape", shape: "rect", fill: "#00FF00", x: 10, y: 10, w: 50, h: 50 });
    expect(round).toMatchObject({ shape: "rect", fill: "#0000FF", radius: 8 });
    expect(ellipse).toMatchObject({ shape: "ellipse", fill: "#ABCDEF" });
  });

  it("pulls speaker notes from the notesSlide rel, skipping chrome placeholders", async () => {
    const notesSp = (ph: string, text: string) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name=""/><p:cNvSpPr/><p:nvPr><p:ph type="${ph}" idx="1"/></p:nvPr></p:nvSpPr>` +
      `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const notes =
      `<?xml version="1.0" encoding="UTF-8"?><p:notes ${NS}><p:cSld><p:spTree>` +
      notesSp("body", "발표자 노트입니다") + notesSp("sldNum", "3") +
      `</p:spTree></p:cSld></p:notes>`;
    const { slides } = await pptxToSlides(makePptx({
      slides: [slidePart(textSp("x"))],
      slideRels: { 1: `<Relationship Id="rId2" Type="${REL_TYPE}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>` },
      extra: { "ppt/notesSlides/notesSlide1.xml": enc.encode(notes) },
    }));
    expect(slides[0].notes).toBe("발표자 노트입니다");
  });

  it("rejects a ZIP without any slides", async () => {
    const zip = makeZip([{ name: "mimetype", data: enc.encode("application/zip"), method: 0 }]);
    await expect(pptxToSlides(zip)).rejects.toThrow(/PPTX/);
  });
});
