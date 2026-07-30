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

// --- layout / master / theme fixtures --------------------------------------------

/** An Office-default-ish clrScheme: dk1/lt1 as sysClr (lastClr), the rest srgb. */
const THEME_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="t"><a:themeElements><a:clrScheme name="t">` +
  `<a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1>` +
  `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>` +
  `<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
  `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
  `</a:clrScheme></a:themeElements></a:theme>`;

/** A placeholder shape (`p:ph` attrs raw); xfrm/rPr are raw DrawingML strings. */
const phSp = (ph: string, text: string, { xfrm = "", rPr = "" } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="5" name="ph"/><p:cNvSpPr/><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>` +
  `<p:spPr>${xfrm}</p:spPr>` +
  `<p:txBody><a:bodyPr/><a:p><a:r>${rPr}<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

/** A single-slide deck chained slide → layout → master → theme, with
 *  injectable layout/master spTree content, master txStyles, and backgrounds. */
function themedPptx(
  slideXml: string,
  opts: { layoutTree?: string; masterTree?: string; txStyles?: string; layoutBg?: string; masterBg?: string } = {},
): ArrayBuffer {
  const layout =
    `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout ${NS}><p:cSld>${opts.layoutBg ?? ""}` +
    `<p:spTree>${opts.layoutTree ?? ""}</p:spTree></p:cSld></p:sldLayout>`;
  const master =
    `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster ${NS}><p:cSld>${opts.masterBg ?? ""}` +
    `<p:spTree>${opts.masterTree ?? ""}</p:spTree></p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3"` +
    ` accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `${opts.txStyles ?? ""}</p:sldMaster>`;
  const relsXml = (content: string) =>
    enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Relationships ${REL_NS}>${content}</Relationships>`);
  return makePptx({
    slides: [slideXml],
    slideRels: { 1: `<Relationship Id="rId9" Type="${REL_TYPE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` },
    extra: {
      "ppt/slideLayouts/slideLayout1.xml": enc.encode(layout),
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relsXml(
        `<Relationship Id="rId1" Type="${REL_TYPE}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`,
      ),
      "ppt/slideMasters/slideMaster1.xml": enc.encode(master),
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": relsXml(
        `<Relationship Id="rId1" Type="${REL_TYPE}/theme" Target="../theme/theme1.xml"/>`,
      ),
      "ppt/theme/theme1.xml": enc.encode(THEME_XML),
    },
  });
}

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
      fontSize: 32, // sz=2400 centipoints → 24pt → 32px @1280 design (×4/3)
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

  it("resolves schemeClr through the master's clrMap and the theme's clrScheme", async () => {
    const accented = textSp("accent", {
      rPr: '<a:rPr sz="1800"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr>',
    });
    const mapped = textSp("text color", {
      rPr: '<a:rPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr>',
    });
    const { slides } = await pptxToSlides(themedPptx(slidePart(accented + mapped)));
    expect(slides[0].elements?.[0].color).toBe("#4472C4"); // accent1, direct
    expect(slides[0].elements?.[1].color).toBe("#111111"); // tx1 → clrMap → dk1 sysClr lastClr
  });

  it("darkens a scheme color with lumMod (HSL approximation)", async () => {
    const sp = textSp("dark", {
      rPr: '<a:rPr sz="1800"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></a:rPr>',
    });
    const { slides } = await pptxToSlides(themedPptx(slidePart(sp)));
    const color = slides[0].elements?.[0].color ?? "";
    expect(color).toMatch(/^#[0-9A-F]{6}$/);
    const luma = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(luma(color)).toBeLessThan(luma("#4472C4"));
  });

  it("inherits a placeholder's transform from the layout", async () => {
    const slide = slidePart(phSp('type="title"', "Inherited title"));
    const layoutPh = phSp('type="title"', "", {
      xfrm: '<a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm>',
    });
    const { slides } = await pptxToSlides(themedPptx(slide, { layoutTree: layoutPh }));
    // The layout's xfrm, not the hardcoded TITLE_BOX fallback.
    expect(slides[0].elements?.[0]).toMatchObject({ text: "Inherited title", x: 10, y: 10, w: 50, h: 50 });
  });

  it("inherits run size from the master's bodyStyle", async () => {
    const slide = slidePart(phSp('type="body" idx="1"', "본문"));
    const txStyles =
      `<p:txStyles><p:titleStyle/><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle>` +
      `<p:otherStyle/></p:txStyles>`;
    const { slides } = await pptxToSlides(themedPptx(slide, { txStyles }));
    expect(slides[0].elements?.[0].fontSize).toBe(27); // 20pt × 4/3
  });

  it("splits paragraphs with different sizes into stacked elements", async () => {
    const sp =
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr>` +
      `<p:txBody><a:bodyPr/>` +
      `<a:p><a:r><a:rPr sz="2800"/><a:t>큰 제목</a:t></a:r></a:p>` +
      `<a:p><a:r><a:rPr sz="1400"/><a:t>작은 본문</a:t></a:r></a:p>` +
      `</p:txBody></p:sp>`;
    const { slides } = await pptxToSlides(makePptx({ slides: [slidePart(sp)] }));
    const els = slides[0].elements ?? [];
    expect(els).toHaveLength(2);
    expect(els[0]).toMatchObject({ type: "text", text: "큰 제목", fontSize: 37, x: 10, y: 10, w: 50 });
    expect(els[1]).toMatchObject({ type: "text", text: "작은 본문", fontSize: 19, x: 10, w: 50 });
    expect(els[1].y).toBeGreaterThan(els[0].y);
    expect(els[0].h + els[1].h).toBeCloseTo(50, 1); // slices tile the original box
  });

  it("flattens a gradient background to its first stop", async () => {
    const bg =
      `<p:bg><p:bgPr><a:gradFill><a:gsLst>` +
      `<a:gs pos="0"><a:srgbClr val="AABBCC"/></a:gs><a:gs pos="100000"><a:srgbClr val="112233"/></a:gs>` +
      `</a:gsLst></a:gradFill></p:bgPr></p:bg>`;
    const { slides } = await pptxToSlides(makePptx({ slides: [slidePart(textSp("x"), bg)] }));
    expect(slides[0].background).toBe("#AABBCC");
  });

  it("inherits the slide background from the master through the layout chain", async () => {
    const masterBg = '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/></a:solidFill></p:bgPr></p:bg>';
    const { slides } = await pptxToSlides(themedPptx(slidePart(textSp("x")), { masterBg }));
    expect(slides[0].background).toBe("#E7E6E6"); // bg2 → clrMap → lt2
  });

  it("emits one text element per table cell, in row-major grid positions", async () => {
    const cell = (t: string) =>
      `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1000"/><a:t>${t}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
    const frame =
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="3429000"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>` +
      `<a:tblGrid><a:gridCol w="3048000"/><a:gridCol w="3048000"/></a:tblGrid>` +
      `<a:tr h="1714500">${cell("A1")}${cell("B1")}</a:tr>` +
      `<a:tr h="1714500">${cell("A2")}${cell("B2")}</a:tr>` +
      `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const { slides } = await pptxToSlides(makePptx({ slides: [slidePart(frame)] }));
    const els = slides[0].elements ?? [];
    expect(els).toHaveLength(4);
    expect(els.map((e) => e.text)).toEqual(["A1", "B1", "A2", "B2"]);
    expect(els[0]).toMatchObject({ type: "text", x: 10, y: 10, w: 25, h: 25, fontSize: 13 });
    expect(els[1]).toMatchObject({ x: 35, y: 10 });
    expect(els[2]).toMatchObject({ x: 10, y: 35 });
    expect(els[3]).toMatchObject({ x: 35, y: 35 });
  });

  it("skips custGeom freeforms and exotic presets instead of emitting cover-all rects", async () => {
    const geomSp = (geom: string) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="deco"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="3429000"/></a:xfrm>` +
      `${geom}<a:solidFill><a:srgbClr val="808080"/></a:solidFill></p:spPr></p:sp>`;
    const { slides } = await pptxToSlides(makePptx({
      slides: [slidePart(
        geomSp("<a:custGeom><a:pathLst/></a:custGeom>") +
        geomSp('<a:prstGeom prst="wave"><a:avLst/></a:prstGeom>') +
        geomSp('<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'),
      )],
    }));
    const els = slides[0].elements ?? [];
    expect(els).toHaveLength(1); // only the plain rect survives
    expect(els[0]).toMatchObject({ type: "shape", shape: "rect", fill: "#808080" });
  });

  it("shrinks overflowing un-autofitted text to fit its box (floored at 60%)", async () => {
    const sp =
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="342900"/></a:xfrm></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"/><a:t>${"x".repeat(200)}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const { slides } = await pptxToSlides(makePptx({ slides: [slidePart(sp)] }));
    // 18pt → 24px, ~5 estimated lines × 1.3 line-height ≫ a 5%-tall box →
    // clamped to the 60% floor: round(24 × 0.6) = 14.
    expect(slides[0].elements?.[0].fontSize).toBe(14);
  });

  it("rejects a ZIP without any slides", async () => {
    const zip = makeZip([{ name: "mimetype", data: enc.encode("application/zip"), method: 0 }]);
    await expect(pptxToSlides(zip)).rejects.toThrow(/PPTX/);
  });
});
