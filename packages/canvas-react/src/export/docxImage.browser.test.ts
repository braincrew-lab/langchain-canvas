// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/docx-images.json";
import { assertEmbeddedImage } from "./__gate__/docxAssertions";
import { ensureBrowsersPath, evidenceDir, GATE_DIR, REPO_ROOT } from "./__gate__/fontServer";

describe.skipIf(process.env.CANVAS_BROWSER_GATE !== "1")("real Chromium DOCX image export", () => {
  let browser: import("playwright").Browser;
  let server: import("vite").ViteDevServer;
  let base: string;
  beforeAll(async () => {
    ensureBrowsersPath();
    const { chromium } = await import("playwright");
    const { createServer } = await import("vite");
    server = await createServer({ configFile: false, root: GATE_DIR, cacheDir: path.join(REPO_ROOT, "node_modules/.vite-parity-gate"), logLevel: "error", server: { host: "127.0.0.1", port: 0, fs: { allow: [REPO_ROOT] } } });
    await server.listen();
    base = server.resolvedUrls!.local[0];
    browser = await chromium.launch();
    mkdirSync(evidenceDir(), { recursive: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  it.each(["native", "absent", "rejecting"])("%s decoder: embeds all formats and exports the full fixture", async (mode) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}docx.html`);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const fixture = readFileSync(path.join(GATE_DIR, "../__fixtures__/parity-document.md"), "utf8");
      const outputs = await page.evaluate(async ({ mode, fixtures, fixture }) => {
        const original = globalThis.createImageBitmap;
        let calls = 0;
        if (mode === "absent") Object.defineProperty(globalThis, "createImageBitmap", { value: undefined, configurable: true });
        else Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: (...args: Parameters<typeof createImageBitmap>) => {
          calls++;
          if (mode === "rejecting") return Promise.reject(new Error("forced decode failure"));
          return original(...args);
        } });
        const build = (window as unknown as { buildDocx: (content: string) => Promise<string> }).buildDocx;
        const images: Record<string, string> = {};
        for (const [format, bytes] of Object.entries(fixtures)) images[format] = await build(`![sample](data:image/${format};base64,${bytes})`);
        const full = await build(fixture);
        let invalid = "";
        try { await build("![broken](data:image/png;base64,AA==)"); } catch (error) { invalid = String(error); }
        return { images, full, calls, invalid, nativeAvailable: typeof original === "function" };
      }, { mode, fixtures, fixture });
      expect(outputs.nativeAvailable).toBe(true);
      expect(outputs.calls).toBe(0);
      expect(outputs.invalid).toContain("DOCX image");
      for (const [format, bytes] of Object.entries(outputs.images)) {
        const buffer = Buffer.from(bytes, "base64");
        await assertEmbeddedImage(buffer, fixtures[format as keyof typeof fixtures], format === "jpeg" ? "jpg" : format);
        writeFileSync(path.join(evidenceDir(), `image-${mode}-${format}.docx`), buffer);
      }
      writeFileSync(path.join(evidenceDir(), `parity-document.${mode}.docx`), Buffer.from(outputs.full, "base64"));
      if (mode === "native") writeFileSync(path.join(evidenceDir(), "parity-document.browser.docx"), Buffer.from(outputs.full, "base64"));
      writeFileSync(path.join(evidenceDir(), `image-${mode}.json`), JSON.stringify({ engine: browser.version(), calls: outputs.calls, nativeAvailable: outputs.nativeAvailable, invalid: outputs.invalid, errors }, null, 2));
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
