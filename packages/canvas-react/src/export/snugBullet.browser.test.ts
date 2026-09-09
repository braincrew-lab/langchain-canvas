// @vitest-environment node
/**
 * Snug bullet one-liner gate (Chromium) — the independent review's HIGH
 * finding on U3: a one-line bullet paragraph is drawn as a fixed 1.2 em
 * marker plus its body, but the snug one-line fit measured the "• " prefix's
 * own glyphs (0.564 em in Noto Sans CJK KR), so when the fit fired the drawn
 * line was wider than the box and `overflow: hidden` clipped the last glyph.
 *
 * Two real surfaces, one fixture (`__fixtures__/snug-bullet.slides.json`:
 * `• 가나다라마` at 24 px in a 12.5 % box on the 960 px page = 120 px):
 *   print — `__gate__/print.html`: the `slidesToPrintHtml` sheet driven
 *     through the PRODUCTION `preparePrintFrame` (`pdf.ts`) — the sandboxed
 *     srcdoc frame, its wait and its `fitSnugLines` call exactly as
 *     `printToPdf` makes them before `print()`. The render image's face is
 *     declared in the sheet only (the frame's document, never the host's)
 *     and served with a delay longer than any fixed beat, so the fit is
 *     right only if production waits for the frame's own face and measures
 *     with the frame's own canvas;
 *   mounted — `__gate__/mount.html?deck=snug-bullet`: the REAL `<Canvas>`,
 *     its main stage (`FittedText` in the editor) and its rail thumbnail,
 *     with the face injected after load as the parity gate does.
 * Every box is measured character by character (`snugContainment`), the
 * trailing glyph as ink; screenshots and a measurements JSON land in the
 * evidence directory.
 *
 * `CANVAS_BROWSER_GATE=1` is the call switch only; with it on, a missing
 * Chromium, Vite failure or refused font is a FAIL — never a skip.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SlidesData } from "../protocol/artifacts";
import deckFixture from "./__fixtures__/snug-bullet.slides.json";
import {
  ensureBrowsersPath,
  evidenceDir,
  FONT_FAMILY,
  fontPreflight,
  GATE_DIR,
  REPO_ROOT,
  serveFont,
  type FontPreflight,
  type ServedFont,
} from "./__gate__/fontServer";
import { renderedText, snugContainment, type SnugContainment } from "./__gate__/textMetrics";

const deck = deckFixture as { title: string; data: SlidesData };
const elements = deck.data.slides[0].elements ?? [];
const ids = elements.map((el) => el.id);

const PRINT = ".slide:first-of-type .el";
const MAIN = ".cv-slide--blank .cv-free > .cv-free__el";
const THUMB = ".cv-deck__thumb-wrap.is-active .cv-deck__thumb-slide > div:last-child > *";
const SURFACES = ["print", "main", "thumb"] as const;
type Surface = (typeof SURFACES)[number];
type Box = SnugContainment & { id: string };

/** One Chromium LayoutUnit — the only slack a glyph's advance rect gets against the box edge. */
const LAYOUT_UNIT_PX = 1 / 64;
/** How long the font server holds every response: longer than production's old 200 ms beat. */
const FONT_DELAY_MS = 700;
/** The fixture's stored type size and the render face's Hangul advance in em (preflight-checked). */
const FONT_PX = 24;
const HANGUL_EM = 0.92;
/** Fitted type size = stored size x box / drawn width at the stored size; scale cancels. */
function fittedFontPx(boxPx: number, drawnEmAtStored: number): number {
  return (FONT_PX * boxPx) / (drawnEmAtStored * FONT_PX);
}
/** Drawn width in em at the stored size: bullet = 1.2 marker + 5 syllables; plain = 6 syllables. */
const DRAWN_EM = { snug: 1.2 + 5 * HANGUL_EM, plain_snug: 6 * HANGUL_EM } as const;

describe.skipIf(process.env.CANVAS_BROWSER_GATE !== "1")("snug bullet one-liner: print sheet and mounted editor", () => {
  let browser: import("playwright").Browser | undefined;
  let server: import("vite").ViteDevServer | undefined;
  let font: ServedFont | undefined;
  const preflight: Partial<Record<"print" | "mounted", FontPreflight>> = {};
  const boxes: Record<Surface, Box[]> = { print: [], main: [], thumb: [] };
  const pageErrors: string[] = [];

  /** Measure the clipping box of every element handle, in surface order. */
  async function measure(handles: import("playwright").ElementHandle<SVGElement | HTMLElement>[], inner?: string): Promise<Box[]> {
    const out: Box[] = [];
    for (const [index, handle] of handles.entries()) {
      const target = inner ? await handle.$(inner) : handle;
      if (!target) throw new Error(`element ${ids[index] ?? index} has no ${inner} body`);
      out.push({ id: ids[index] ?? `#${index}`, ...(await target.evaluate(snugContainment)) });
    }
    return out;
  }

  beforeAll(async () => {
    ensureBrowsersPath();
    const { chromium } = await import("playwright");
    const { createServer } = await import("vite");
    server = await createServer({
      configFile: false,
      root: GATE_DIR,
      cacheDir: path.join(REPO_ROOT, "node_modules", ".vite-parity-gate"),
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, fs: { allow: [REPO_ROOT] } },
    });
    await server.listen();
    const base = server.resolvedUrls?.local[0];
    if (!base) throw new Error("vite did not report a local URL");
    font = await serveFont({ delayMs: FONT_DELAY_MS });
    browser = await chromium.launch();
    const dir = evidenceDir();
    mkdirSync(dir, { recursive: true });

    // Print: the host page hands the sheet (with the face declared inside it)
    // to the production `preparePrintFrame` and marks the body when it resolves.
    // No face is injected into the host page.
    const printPage = await browser.newPage({ viewport: { width: 960, height: 540 } });
    printPage.on("pageerror", (error) => pageErrors.push(`print: ${String(error)}`));
    printPage.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(`print: ${message.text()}`);
    });
    const query = `deck=snug-bullet&font=${encodeURIComponent(font.url)}&family=${encodeURIComponent(FONT_FAMILY)}`;
    await printPage.goto(`${base}print.html?${query}`);
    await printPage.waitForSelector("body[data-snug-fit='done']", { timeout: 30_000 });
    const frame = printPage.frames().find((candidate) => candidate !== printPage.mainFrame());
    if (!frame) throw new Error("print.html drew no print frame");
    // The preflight is taken AFTER production declared the frame ready: the
    // face it reports loaded is the face the fit had to be computed with.
    preflight.print = await fontPreflight(frame);
    boxes.print = await measure(await frame.$$(PRINT));
    await printPage.screenshot({ path: path.join(dir, "snug-print.png"), fullPage: true });
    await printPage.close();

    // Mounted: the real editor with the snug deck; the font is injected after
    // load like the parity gate does, so the fit must re-measure once the
    // face arrives (production loads its faces the same way).
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(`mounted: ${String(error)}`));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(`mounted: ${message.text()}`);
    });
    await page.goto(`${base}mount.html?deck=snug-bullet`);
    await page.addStyleTag({ content: font.css });
    preflight.mounted = await fontPreflight(page);
    await page.waitForSelector(MAIN);
    await page.waitForSelector(THUMB);
    // Let the ResizeObserver-driven scale, the font swap and React's commit settle.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
        ),
    );
    boxes.main = await measure(await page.$$(MAIN), ".cv-free__text");
    boxes.thumb = await measure(await page.$$(THUMB), ".cv-free__text");
    await page.locator(".cv-slide--blank").first().screenshot({ path: path.join(dir, "snug-mounted-main.png") });
    await page
      .locator(".cv-deck__thumb-wrap.is-active .cv-deck__thumb-slide")
      .first()
      .screenshot({ path: path.join(dir, "snug-mounted-thumb.png") });
    await page.close();

    writeFileSync(
      path.join(dir, "snug-bullet.measurements.json"),
      JSON.stringify(
        {
          engine: `Chromium ${browser.version()} (playwright headless)`,
          fixture: { ids, elements },
          font: { url: font.url, sha256: font.sha256, bytes: font.bytes },
          preflight,
          pageErrors,
          boxes,
        },
        null,
        1,
      ),
    );
    // Hook timeout raised with a reason: Vite's dependency pre-bundle, two
    // Chromium pages and the 19 MB font load exceed the 10 s hook default.
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await font?.close();
  });

  it("the render image's font loads in the print frame and the mounted editor (preflight)", () => {
    for (const surface of ["print", "mounted"] as const) {
      const flight = preflight[surface];
      expect(flight, surface).toBeDefined();
      expect(flight!.error, surface).toBeNull();
      expect(flight!.loaded.map((face) => face.status), surface).toEqual(["loaded"]);
      expect(flight!.check, surface).toBe(true);
      expect(flight!.hangulAdvancePx / FONT_PX, surface).toBeCloseTo(HANGUL_EM, 2);
    }
  });

  it("every surface lists the fixture elements in order, with the bullet drawn as marker + body", () => {
    expect(pageErrors).toEqual([]);
    for (const surface of SURFACES) {
      expect(boxes[surface].map((b) => b.id), surface).toEqual(ids);
      for (const el of elements) {
        if (el.type !== "text") continue;
        expect(boxes[surface].find((b) => b.id === el.id)?.text, `${surface} ${el.id}`).toBe(renderedText(el.text ?? ""));
      }
    }
  });

  /**
   * The containment proof for one fitted one-liner on one surface. The fit
   * must have fired (nowrap: the sheet's and the editor's base style is
   * pre-wrap) at the size the surface's own loaded face dictates — so a fit
   * taken before that face arrived, or with another document's canvas, is
   * out; the paragraph stays on ONE line; and the trailing glyph is wholly
   * visible: its INK ends inside the clipping box (no tolerance), its
   * advance rect ends within one LayoutUnit of the box edge, and the box
   * reports no horizontal scroll overflow. Recorded values name the surface.
   */
  function containment(surface: Surface, id: keyof typeof DRAWN_EM, lastChar: string) {
    const box = boxes[surface].find((b) => b.id === id);
    if (!box) return [{ surface, reason: `no box for ${id}`, measured: null as Box | null }];
    const boxPx = box.boxRight - box.boxLeft;
    const expectedFontPx = fittedFontPx(boxPx, DRAWN_EM[id]);
    const checks: [string, boolean][] = [
      ["fit fired (white-space: nowrap)", box.whiteSpace === "nowrap"],
      [`fit computed from the loaded face (font-size ${expectedFontPx.toFixed(3)} px +- 0.02)`, Math.abs(box.fontSizePx - expectedFontPx) <= 0.02],
      ["one drawn line", box.drawnLines === 1],
      [`last glyph is ${lastChar}`, box.lastChar === lastChar],
      ["last glyph ink inside the box (no tolerance)", box.lastCharInkRight !== null && box.lastCharInkRight <= box.boxRight && box.lastCharInkLeft !== null && box.lastCharInkLeft >= box.boxLeft],
      ["last glyph advance rect within one LayoutUnit of the box edge", box.lastCharRight !== null && box.lastCharRight <= box.boxRight + LAYOUT_UNIT_PX],
      ["no horizontal overflow (scrollWidth <= clientWidth)", box.scrollWidth <= box.clientWidth],
    ];
    return checks.filter(([, ok]) => !ok).map(([reason]) => ({ surface, reason, measured: box as Box | null }));
  }

  it("a snug bullet one-liner is fitted from the surface's loaded face onto one line, its trailing glyph's ink inside the box, on every surface", () => {
    expect(SURFACES.flatMap((surface) => containment(surface, "snug", "마"))).toEqual([]);
  });

  it("a plain snug one-liner keeps fitting exactly as before, under the same proof (control)", () => {
    // 6 Hangul syllables at 0.92 em (132.5 px) in the same 120 px box: inside
    // the snug window on every surface.
    expect(SURFACES.flatMap((surface) => containment(surface, "plain_snug", "바"))).toEqual([]);
  });
});
