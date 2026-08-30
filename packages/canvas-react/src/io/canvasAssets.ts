/**
 * Canvas asset references — relative paths that point at files on the canvas.
 *
 * The reference contract: inside canvas content, a relative path starting with
 * `assets/` (files brought in by the agent) or `sources/` (the user's uploads)
 * points at a file on the *same* canvas — `<img src="assets/logo.png">` in an
 * html page, `![logo](assets/logo.png)` in a document, `src: "assets/logo.png"`
 * on a slide image element.
 *
 * Display resolves a reference against the host's file endpoint
 * (`resolveAssetUrl`), keeping the stored content relative. Export restores
 * self-containment at the door (`inlineArtifactAssets` / `inlineHtmlAssets`):
 * every reference becomes a `data:` URI so the exported file carries its
 * images. The unit of self-containment is the canvas folder while
 * collaborating, and the single file once exported.
 *
 * The Python twin lives in `langchain_canvas/assets.py`; the prefix list below
 * is compared against it by the protocol parity tests.
 */

import { isLegacySlidesData, type Artifact, type HtmlData, type SlidesData } from "../protocol/artifacts";

export const ASSET_REFERENCE_PREFIXES = ["assets/", "sources/"] as const;

/**
 * The canvas-root-relative path `src` refers to, or `null`.
 *
 * References are root-relative by contract, but a model writing a page that
 * lives in a folder often produces the document-relative form
 * (`../sources/photo.png`). Store paths can never contain `..` (the store
 * contract rejects them), and `assets/` / `sources/` exist only at the root —
 * so folding leading `./` / `../` segments onto the root reading is lossless
 * tolerance, not guesswork. Stored content is never rewritten; only consumers
 * (display, export inlining) interpret leniently.
 */
export function normalizeAssetReference(src: string | undefined | null): string | null {
  if (typeof src !== "string") return null;
  let folded = src;
  while (folded.startsWith("./") || folded.startsWith("../")) {
    folded = folded.startsWith("./") ? folded.slice(2) : folded.slice(3);
  }
  return ASSET_REFERENCE_PREFIXES.some((p) => folded.startsWith(p)) ? folded : null;
}

export function isAssetReference(src: string | undefined | null): src is string {
  return normalizeAssetReference(src) !== null;
}

/**
 * Absolute URL for a canvas-relative asset path. `assetBaseUrl` is a prefix the
 * whole (URI-encoded) path is appended to — e.g. the reference server's
 * `http://host/api/canvas/<id>/file?path=`.
 */
export function resolveAssetUrl(src: string, assetBaseUrl: string): string {
  return assetBaseUrl + encodeURIComponent(normalizeAssetReference(src) ?? src);
}

/**
 * Absolute URL for a stored canvas file, wherever on the canvas it sits.
 *
 * Not the same question as `isAssetReference`. That one reads a string found
 * *inside* content and asks whether it points at a canvas file — a guess that
 * has to be conservative, because most strings in a document are not paths. A
 * `file` artifact's `path` needs no guessing: it came from the store, so it is
 * a canvas file by definition, at the root or under any folder. Asking the
 * reference gate instead would leave every file outside `assets/` / `sources/`
 * with no URL — no preview, no download — and widening that gate to fix it
 * would make body-text scanning claim paths it should leave alone.
 */
export function resolveCanvasFileUrl(path: string, assetBaseUrl: string): string {
  return assetBaseUrl + encodeURIComponent(path);
}

// src="assets/..." / src='sources/...' (leading ./ and ../ tolerated) — built
// from the constant above so the matcher can never drift from the contract.
const REF_ALTERNATION = ASSET_REFERENCE_PREFIXES.map((p) => p.slice(0, -1)).join("|");
const srcAttrPattern = () =>
  new RegExp(`(src=(["']))((?:\\.\\.?/)*(?:${REF_ALTERNATION})/[^"']+)(\\2)`, "g");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Fetch one canvas asset and encode it as a `data:` URI (null on any failure). */
export async function fetchAssetDataUri(path: string, assetBaseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(resolveAssetUrl(path, assetBaseUrl));
    if (!res.ok) return null;
    const type = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/**
 * Replace canvas-asset references in an HTML string with `data:` URIs.
 *
 * Handles both the stored form (`src="assets/logo.png"`) and the display form a
 * rendered DOM serializes (`src="<assetBaseUrl><encoded path>"`). A reference
 * that cannot be fetched is left untouched — honest: the export shows exactly
 * what could be resolved. Only `src` attributes are rewritten; CSS `url(...)`
 * references are out of contract.
 */
export async function inlineHtmlAssets(html: string, assetBaseUrl: string): Promise<string> {
  const relative = srcAttrPattern();
  const absolute = new RegExp(
    `(src=(["']))${escapeRegExp(assetBaseUrl)}([^"']+)(\\2)`,
    "g",
  );
  const paths = new Set<string>();
  for (const m of html.matchAll(relative)) paths.add(m[3]);
  for (const m of html.matchAll(absolute)) {
    const decoded = safeDecode(m[3]);
    if (isAssetReference(decoded)) paths.add(decoded);
  }
  if (!paths.size) return html;

  const resolved = new Map<string, string>();
  await Promise.all(
    [...paths].map(async (p) => {
      const uri = await fetchAssetDataUri(p, assetBaseUrl);
      if (uri) resolved.set(p, uri);
    }),
  );
  return html
    .replace(relative, (whole, pre, _q, path, post) => {
      const uri = resolved.get(path);
      return uri ? `${pre}${uri}${post}` : whole;
    })
    .replace(absolute, (whole, pre, _q, encoded, post) => {
      const uri = resolved.get(safeDecode(encoded));
      return uri ? `${pre}${uri}${post}` : whole;
    });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * An artifact with every canvas-asset reference inlined as a `data:` URI —
 * the export chokepoint. `html` inlines its page source; a canonical `slides`
 * deck (`{ html }`) inlines the same way; a legacy `{ slides: [...] }` deck
 * and other types (and a missing `assetBaseUrl`) pass through unchanged, so
 * hosts without a file endpoint keep today's behavior exactly.
 */
export async function inlineArtifactAssets<T extends Artifact>(
  artifact: T,
  assetBaseUrl: string | null | undefined,
): Promise<T> {
  if (!assetBaseUrl) return artifact;
  if (artifact.type === "html") {
    const data = artifact.data as HtmlData;
    const html = await inlineHtmlAssets(data.html, assetBaseUrl);
    return html === data.html ? artifact : { ...artifact, data: { ...data, html } };
  }
  if (artifact.type === "slides") {
    const data = artifact.data as SlidesData;
    // A legacy `{ slides: [...] }` artifact carries no `html` to inline — the
    // renderer already falls back to a read-only card for it, so exporting it
    // as-is (no asset references resolved) is the same "unresolved but honest"
    // contract `inlineHtmlAssets` documents above.
    if (isLegacySlidesData(data) || typeof data.html !== "string") return artifact;
    const html = await inlineHtmlAssets(data.html, assetBaseUrl);
    return html === data.html ? artifact : { ...artifact, data: { ...data, html } };
  }
  return artifact;
}
