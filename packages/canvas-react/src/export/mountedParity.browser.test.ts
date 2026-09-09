// @vitest-environment node
/**
 * Mounted editor gate (Chromium) — the REAL `<Canvas>` with the shared parity
 * deck, measured on its main stage and its rail thumbnail
 * (`.omb/plans/2026-09-09-office-render-parity.md`, §공유 픽스처, M1-M6).
 *
 * `__gate__/mount.tsx` is served by a Vite dev server the suite starts; the
 * render image's font is injected and preflighted (M1); the main stage's
 * `.cv-free__el` boxes and the active thumbnail's children are read in the
 * same `resolveElements` order and compared element by element. A style
 * helper unit test is not a substitute for this.
 *
 * `CANVAS_BROWSER_GATE=1` is the call switch only; with it on, a missing
 * Chromium, Vite failure or refused font is a FAIL.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SlidesData } from "../protocol/artifacts";
import deckFixture from "./__fixtures__/parity-deck.slides.json";
import {
  ensureBrowsersPath,
  evidenceDir,
  fontPreflight,
  GATE_DIR,
  REPO_ROOT,
  serveFont,
  type FontPreflight,
  type ServedFont,
} from "./__gate__/fontServer";
import { bulletAlignment, renderedText, type BulletAlignment } from "./__gate__/textMetrics";

const deck = deckFixture as { title: string; data: SlidesData };
const elements = deck.data.slides[0].elements ?? [];
const ids = elements.map((el) => el.id);

const MAIN = ".cv-slide--blank .cv-free > .cv-free__el";
const THUMB = ".cv-deck__thumb-wrap.is-active .cv-deck__thumb-slide > div:last-child > *";
const DEFAULT_LEADING = 1.2;

interface SurfaceBox {
  id: string;
  text: string;
  fontSizePx: number;
  lineHeight: string;
  lineHeightPx: number;
  drawnLines: number;
  scrollHeight: number;
  clientHeight: number;
  textIndent: string;
  borderRadius: string;
  fontFamily: string;
}

describe.skipIf(process.env.CANVAS_BROWSER_GATE !== "1")("mounted editor: main stage vs rail thumbnail", () => {
  let browser: import("playwright").Browser | undefined;
  let server: import("vite").ViteDevServer | undefined;
  let font: ServedFont | undefined;
  let preflight: FontPreflight;
  let negative: { height: number; lines: number; legacyHeightEstimate: number }[] = [];
  let main: SurfaceBox[] = [];
  let thumb: SurfaceBox[] = [];
  /** The mounted Word page (M7): the drawn `.cv-word__page` box model and text column. */
  let wordPage: { boxSizing: string; clientWidth: number; paddingLeft: number; paddingRight: number; columnPx: number } | null = null;
  /** `grow`'s bullet block on each surface (M6); null when the surface draws none. */
  const bullets: Record<"main" | "thumb", (BulletAlignment & { textIndent: string }) | null> = { main: null, thumb: null };
  const pageErrors: string[] = [];

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
    font = await serveFont();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    await page.goto(`${base}mount.html`);
    await page.addStyleTag({ content: font.css });
    preflight = await fontPreflight(page);
    await page.waitForSelector(MAIN);
    await page.waitForSelector(THUMB);
    // Let the ResizeObserver-driven font scale and the font swap settle.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
    );
    const read = (nodes: Element[]) =>
      nodes.map((node) => {
        // Both surfaces: a text element is a box wrapper holding the
        // `.cv-free__text` body (the body carries the leading — U1 ink guard);
        // a shape is a wrapper holding the shape div on the main stage and the
        // shape div itself in the thumbnail.
        const target =
          (node.querySelector(".cv-free__text") as HTMLElement | null) ??
          (node.firstElementChild as HTMLElement | null) ??
          (node as HTMLElement);
        const style = getComputedStyle(target);
        const tops: number[] = [];
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width > 0 && rect.height > 0 && !tops.some((top) => Math.abs(top - rect.top) <= 0.5)) tops.push(rect.top);
          }
        }
        return {
          drawnLines: tops.length,
          text: target.textContent ?? "",
          fontSizePx: parseFloat(style.fontSize),
          lineHeight: style.lineHeight,
          lineHeightPx: parseFloat(style.lineHeight),
          scrollHeight: target.scrollHeight,
          clientHeight: target.clientHeight,
          textIndent: style.textIndent,
          borderRadius: style.borderRadius,
          fontFamily: style.fontFamily,
        };
      });
    const mainRaw = await page.$$eval(MAIN, read);
    // Real DOM negative control: identical tall boxes, deliberately different
    // widths. The same measurement function used by the positive gate must
    // reject their divergent wrapping despite identical allocated heights.
    await page.$eval(MAIN, (source) => {
      for (const scale of [1, 0.5]) {
        const clone = source.cloneNode(true) as HTMLElement;
        clone.classList.add("line-count-control");
        clone.style.width = `${source.getBoundingClientRect().width * scale}px`;
        clone.style.height = "1000px";
        const text = clone.querySelector<HTMLElement>(".cv-free__text, .el__text");
        if (text) text.style.height = "1000px";
        source.parentElement!.appendChild(clone);
      }
    });
    const controlBoxes = await page.$$eval(".line-count-control", read);
    const heights = await page.$$eval(".line-count-control", (nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    negative = controlBoxes.map((box, i) => ({ height: heights[i], lines: box.drawnLines, legacyHeightEstimate: Math.round(box.scrollHeight / box.lineHeightPx) }));
    await page.$$eval(".line-count-control", (nodes) => nodes.forEach((node) => node.remove()));

    const thumbRaw = await page.$$eval(THUMB, read);
    main = mainRaw.map((box, index) => ({ id: ids[index] ?? `#${index}`, ...box }));
    thumb = thumbRaw.map((box, index) => ({ id: ids[index] ?? `#${index}`, ...box }));
    // M6: the first bullet block on each surface is `grow`'s (the only bulleted
    // element, first in order). Absent → null, asserted in M6.
    for (const [surface, selector] of [["main", MAIN], ["thumb", THUMB]] as const) {
      const block = await page.$(`${selector} .cv-bullet`);
      bullets[surface] = block
        ? { ...(await block.evaluate(bulletAlignment)), textIndent: await block.evaluate((node) => getComputedStyle(node).textIndent) }
        : null;
    }
    const dir = evidenceDir();
    mkdirSync(dir, { recursive: true });
    await page.locator(".cv-slide--blank").first().screenshot({ path: path.join(dir, "mounted-main.png") });
    await page
      .locator(".cv-deck__thumb-wrap.is-active .cv-deck__thumb-slide")
      .first()
      .screenshot({ path: path.join(dir, "mounted-thumb.png") });
    await page.screenshot({ path: path.join(dir, "mounted-page.png"), fullPage: true });
    writeFileSync(
      path.join(dir, "mounted-parity.measurements.json"),
      JSON.stringify(
        {
          engine: `Chromium ${browser.version()} (playwright headless)`,
          viewport: { widthPx: 1400, heightPx: 900 },
          font: { url: font.url, sha256: font.sha256, bytes: font.bytes },
          preflight,
          negative,
          pageErrors,
          main,
          thumb,
          bullets,
        },
        null,
        1,
      ),
    );
    await page.close();

    // M7: the same mount with a document artifact — the real `.cv-word__page`
    // at a viewport wide enough for the full 816 px sheet (U6).
    const wordView = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    wordView.on("pageerror", (error) => pageErrors.push(String(error)));
    await wordView.goto(`${base}mount.html?artifact=document`);
    await wordView.waitForSelector(".cv-word__page");
    wordPage = await wordView.$eval(".cv-word__page", (node) => {
      const style = getComputedStyle(node);
      const paddingLeft = parseFloat(style.paddingLeft);
      const paddingRight = parseFloat(style.paddingRight);
      return {
        boxSizing: style.boxSizing,
        clientWidth: node.clientWidth,
        paddingLeft,
        paddingRight,
        columnPx: node.clientWidth - paddingLeft - paddingRight,
      };
    });
    await wordView.screenshot({ path: path.join(dir, "mounted-word-page.png"), fullPage: true });
    await wordView.close();
    // Hook timeout raised with a reason: Vite's first dependency pre-bundle,
    // Chromium launch and the 19 MB font load exceed the 10 s hook default.
  }, 90_000);

  it("detects divergent wrapping with identical box heights (negative control)", () => {
    expect(negative).toHaveLength(2);
    expect(negative[0].height).toBe(negative[1].height);
    // Falsify the old height-based gate: it reports equality for this mismatch.
    expect(negative[0].legacyHeightEstimate).toBe(negative[1].legacyHeightEstimate);
    expect(negative[0].lines).toBeGreaterThan(0);
    expect(negative[1].lines).toBeGreaterThan(negative[0].lines);
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await font?.close();
  });

  it("M1: the render image's font loads in Chromium (preflight)", () => {
    expect(preflight.error).toBeNull();
    expect(preflight.loaded).toHaveLength(1);
    expect(preflight.loaded[0].status).toBe("loaded");
    expect(preflight.check).toBe(true);
  });

  it("both surfaces list the fixture elements in the same order", () => {
    expect(pageErrors).toEqual([]);
    expect(main.map((b) => b.id)).toEqual(ids);
    expect(thumb.map((b) => b.id)).toEqual(ids);
    for (const el of elements) {
      if (el.type !== "text") continue;
      // A bullet paragraph renders as marker + body (U3); everything else as-is.
      expect(main.find((b) => b.id === el.id)?.text).toBe(renderedText(el.text ?? ""));
      expect(thumb.find((b) => b.id === el.id)?.text).toBe(renderedText(el.text ?? ""));
    }
  });

  it("M6: a bullet paragraph hangs the same on both surfaces", () => {
    // U3 on the mounted surfaces: one marker, a 1.2 em hanging indent at each
    // surface's own font size, and the wrapped body under the first body
    // character — on the main stage and in the rail thumbnail alike.
    const off: { surface: string; reason: string; measured: unknown }[] = [];
    for (const surface of ["main", "thumb"] as const) {
      const block = bullets[surface];
      const box = (surface === "main" ? main : thumb).find((b) => b.id === "grow");
      if (!block || !box) {
        off.push({ surface, reason: "no .cv-bullet block for grow", measured: block });
        continue;
      }
      const checks: [string, boolean][] = [
        ["textIndent = -1.2 x fontSize", Math.abs(parseFloat(block.textIndent) + 1.2 * block.fontSizePx) <= 0.05],
        ["markerCount === 1", block.markerCount === 1],
        ["body wraps", block.continuationLeft !== null],
        ["continuation under first body char", Math.abs(block.firstBodyLeft - (block.continuationLeft ?? NaN)) <= 1],
        ["1.2 em offset", Math.abs((block.firstBodyLeft - block.blockLeft) / block.fontSizePx - 1.2) <= 0.05],
      ];
      for (const [reason, ok] of checks) if (!ok) off.push({ surface, reason, measured: block });
    }
    expect(off).toEqual([]);
  });

  it("M2: every text element draws the same leading ratio on the main stage and in the rail thumbnail", () => {
    const off: { id: string; surface: string; expected: number; ratio: number; lineHeight: string }[] = [];
    for (const el of elements) {
      if (el.type !== "text") continue;
      const expected = el.lineHeight ?? DEFAULT_LEADING;
      for (const [surface, boxes] of [["main", main], ["thumb", thumb]] as const) {
        const box = boxes.find((b) => b.id === el.id);
        const ratio = box ? box.lineHeightPx / box.fontSizePx : Number.NaN;
        if (!(Math.abs(ratio - expected) <= 0.01)) {
          off.push({ id: el.id, surface, expected, ratio: Number(ratio.toFixed(3)), lineHeight: box?.lineHeight ?? "missing" });
        }
      }
    }
    expect(off).toEqual([]);
  });

  it("M3: every text element wraps to the same line count on both surfaces", () => {
    // Range text rects count drawn lines independently of the allocated box height.
    const lines = (boxes: SurfaceBox[], id: string) => {
      const box = boxes.find((b) => b.id === id);
      return box ? box.drawnLines : Number.NaN;
    };
    const off: { id: string; main: number; thumb: number }[] = [];
    for (const el of elements) {
      if (el.type !== "text") continue;
      const m = lines(main, el.id);
      const t = lines(thumb, el.id);
      if (!(m === t)) off.push({ id: el.id, main: m, thumb: t });
    }
    expect(off).toEqual([]);
  });

  it("M4: a rectangle has no corner radius on both surfaces", () => {
    // U4 on the mounted surfaces: the file's square rectangle (and flat line)
    // is drawn square on the main stage and in the rail thumbnail.
    const off: { id: string; surface: string; borderRadius: string }[] = [];
    for (const id of ["rect", "line"]) {
      for (const [surface, boxes] of [["main", main], ["thumb", thumb]] as const) {
        const box = boxes.find((b) => b.id === id);
        if (box?.borderRadius !== "0px") off.push({ id, surface, borderRadius: box?.borderRadius ?? "missing" });
      }
    }
    expect(off).toEqual([]);
  });

  it("M7: the mounted Word page exposes a 624px text column", () => {
    // U6 on the mounted document view: a border-box sheet whose padding
    // leaves 816 - 2 x 96 = 624 px = 6.5 in — the column the file's section
    // declares and its tables are gridded to.
    expect(wordPage, "mount.html?artifact=document drew no .cv-word__page").not.toBeNull();
    expect(wordPage!.boxSizing).toBe("border-box");
    expect(wordPage!.columnPx, JSON.stringify(wordPage)).toBe(624);
  });

  it("M5: a box that grows with its text holds every line on the main stage and in the rail thumbnail", () => {
    // U1 on the mounted surfaces (plan R3 addendum): the grown box, drawn at
    // the estimator's height plus the face-derived ink guard, reports no
    // scrollable overflow on either surface — measured at the text body.
    const off: { id: string; surface: string; scrollHeight: number; clientHeight: number }[] = [];
    for (const id of ["grow", "korean_body"]) {
      for (const [surface, boxes] of [["main", main], ["thumb", thumb]] as const) {
        const box = boxes.find((b) => b.id === id);
        if (!box || !(box.scrollHeight <= box.clientHeight + 1)) {
          off.push({ id, surface, scrollHeight: box?.scrollHeight ?? Number.NaN, clientHeight: box?.clientHeight ?? Number.NaN });
        }
      }
    }
    expect(off).toEqual([]);
  });
});
