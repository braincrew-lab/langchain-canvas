/**
 * Test-only support for the browser gates (`printGeometry.browser.test.ts`,
 * `mountedParity.browser.test.ts`).
 *
 * The render gate (LibreOffice in the local Docker image) and the browser
 * gates must see the SAME glyph advances, so the font Chromium measures with
 * is the exact `.ttc` extracted from that image
 * (`.omb/office-parity-evidence/fonts/NotoSansCJK-Regular.ttc`). The bytes
 * are served from a loopback HTTP server — never installed on the host, never
 * loaded through `file://` — with the CORS header a cross-origin `@font-face`
 * load needs.
 *
 * Fail-closed hash contract (plan task 1b): the served bytes' sha256 must
 * equal the `font_sha256` the render gate's R1 preflight recorded from INSIDE
 * the image (`env/render-gate-preflight.json`). A missing record or a
 * different hash throws before the server starts, so `beforeAll` fails and
 * the whole suite FAILS — never a skip, never a fallback font.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `<repo>` — five levels above `packages/canvas-react/src/export/__gate__`. */
export const REPO_ROOT = path.resolve(HERE, "../../../../..");
export const GATE_DIR = HERE;

export const FONT_FAMILY = "Noto Sans CJK KR";
export const FONT_FILE = "NotoSansCJK-Regular.ttc";
/** The `document.fonts.load()` probe: the deck's body size in the shared face. */
export const FONT_PROBE = `24px "${FONT_FAMILY}"`;

export function evidenceDir(): string {
  return process.env.CANVAS_PARITY_EVIDENCE_DIR ?? path.join(REPO_ROOT, ".omb", "office-parity-evidence");
}

/** Chromium lives under the ignored `node_modules/` unless the caller says otherwise. */
export function ensureBrowsersPath(): void {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(REPO_ROOT, "node_modules", ".playwright-browsers");
}

export interface ServedFont {
  url: string;
  sha256: string;
  bytes: number;
  /** The `@font-face` rule to inject with `page.addStyleTag({ content })`. */
  css: string;
  close: () => Promise<void>;
}

/** The R1 preflight record — the in-image sha256 the served bytes must match. */
export const PREFLIGHT_RECORD = path.join("env", "render-gate-preflight.json");

/** The `font_sha256` R1 wrote; throws when the record or the field is absent. */
export function recordedFontSha256(): string {
  const record = path.join(evidenceDir(), PREFLIGHT_RECORD);
  if (!existsSync(record)) {
    throw new Error(
      `${record} is missing — run the render gate's R1 preflight first (it records the in-image font sha256 this gate must match)`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(record, "utf8"));
  const sha = (parsed as { font_sha256?: unknown } | null)?.font_sha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`${record} carries no sha256 font_sha256 — re-run the render gate's R1 preflight`);
  }
  return sha;
}

/**
 * Serve the render image's font on a loopback port. `delayMs` holds every
 * response back that long — the print gate uses it to make a face that
 * arrives AFTER a fixed beat (production's old 200 ms) a deterministic
 * event instead of a race the loopback server would otherwise always win.
 */
export async function serveFont({ delayMs = 0 }: { delayMs?: number } = {}): Promise<ServedFont> {
  const file = path.join(evidenceDir(), "fonts", FONT_FILE);
  if (!existsSync(file)) {
    throw new Error(`${file} is missing — extract it from the render image first (plan task 1)`);
  }
  const body = readFileSync(file);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const recorded = recordedFontSha256();
  if (sha256 !== recorded) {
    throw new Error(
      `${file} is not the render image's font: sha256 ${sha256} differs from the R1-recorded ${recorded} — the browser gate would measure with different glyph advances than LibreOffice`,
    );
  }
  const route = `/fonts/${FONT_FILE}`;
  const server = createServer((req, res) => {
    if (req.url !== route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "font/collection");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Length", body.length);
    setTimeout(() => res.end(body), delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}${route}`;
  return {
    url,
    sha256,
    bytes: body.length,
    css: `@font-face { font-family: "${FONT_FAMILY}"; src: url("${url}"); font-weight: 400; font-style: normal; }`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export interface FontPreflight {
  /** What `document.fonts.load(probe)` resolved with — family/status pairs. */
  loaded: { family: string; status: string }[];
  /** The rejection reason when Chromium refused the face (e.g. a rejected TTC). */
  error: string | null;
  /** `document.fonts.check(probe)` after the load settled. */
  check: boolean;
  /** Advance of one Hangul syllable at 24px in the loaded face (expected 24 = 1.0 em). */
  hangulAdvancePx: number;
}

/** Load the injected face in the page and report what Chromium says about it. */
export async function fontPreflight(page: {
  evaluate: <R, A>(fn: (arg: A) => Promise<R> | R, arg: A) => Promise<R>;
}): Promise<FontPreflight> {
  return page.evaluate(async (probe: string) => {
    let loaded: { family: string; status: string }[] = [];
    let error: string | null = null;
    try {
      loaded = (await document.fonts.load(probe)).map((face) => ({ family: face.family, status: face.status }));
    } catch (reason) {
      error = String(reason);
    }
    await document.fonts.ready;
    const span = document.createElement("span");
    span.textContent = "가".repeat(40);
    span.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${probe}`;
    document.body.appendChild(span);
    const hangulAdvancePx = span.getBoundingClientRect().width / 40;
    span.remove();
    return { loaded, error, check: document.fonts.check(probe), hangulAdvancePx };
  }, FONT_PROBE);
}
