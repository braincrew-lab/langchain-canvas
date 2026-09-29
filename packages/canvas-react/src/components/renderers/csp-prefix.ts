/**
 * Prefixes generated `html` artifact content with a Content-Security-Policy
 * `<meta>` tag, so the sandbox is enforced inside the `srcDoc` document itself
 * rather than relying on the parent page's route-scoped CSP header — a soft
 * SPA navigation never re-fetches the document response, so a route-based CSP
 * is not re-applied when the canvas mounts on an already-loaded page.
 *
 * The prefix is a plain string operation, never a `<head>` search: model HTML
 * can hide a `<head>` token inside a comment, inside a script string, behind
 * an uppercase tag, or omit `<head>` entirely, and any of those defeats a
 * search-and-insert approach. Prepending before all model bytes has no such
 * bypass — the browser's HTML parser always creates an implicit `<head>` and
 * inserts our `<meta>` as its first child before any model markup is parsed.
 */

const BOM = "﻿";
const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

/** Strip a leading BOM and every leading `<!doctype …>` declaration
 *  (case-insensitive, looped to also cover a duplicated doctype). Leading
 *  whitespace around each doctype is consumed along with it. */
function stripLeadingNoise(doc: string): string {
  let rest = doc.charCodeAt(0) === 0xfeff ? doc.slice(BOM.length) : doc;
  let match = rest.match(LEADING_DOCTYPE);
  while (match) {
    rest = rest.slice(match[0].length);
    match = rest.match(LEADING_DOCTYPE);
  }
  return rest;
}

/** `style-src`/`img-src`/`font-src` allow the given asset origins in addition
 *  to inline/data content; every other directive is origin-independent.
 *  `connect-src` and `frame-src` are intentionally absent — they fall back to
 *  `default-src 'none'`. `form-action` does not fall back to `default-src`,
 *  so it is set explicitly; the sandbox missing `allow-forms` is the primary
 *  defense against form submission. */
function cspContent(assetOrigins: string[]): string {
  const extra = assetOrigins.length > 0 ? " " + assetOrigins.join(" ") : "";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    `style-src 'unsafe-inline'${extra}`,
    `img-src data: blob:${extra}`,
    `font-src data:${extra}`,
    "form-action 'none'",
  ].join("; ");
}

/** Prepend a CSP `<meta>` tag before every model byte. `assetOrigins`
 *  (default none) are appended to `style-src`/`img-src`/`font-src` only. */
export function withCspPrefix(doc: string, assetOrigins: string[] = []): string {
  const rest = stripLeadingNoise(doc);
  return `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${cspContent(assetOrigins)}">${rest}`;
}

/**
 * Derives the origin that serves canvas assets from `assetBaseUrl`, so the
 * `srcDoc` CSP can allow it without every host having to pass `assetOrigins`
 * explicitly (`<Canvas>` has no prop path to forward one to `HtmlRenderer`).
 *
 * An absolute `assetBaseUrl` (e.g. `"https://api.example.com/files/"`) resolves
 * to its own origin. A relative one (e.g. `"/api/files/"`) resolves against the
 * *parent page's* address, not the iframe's: a `srcDoc` iframe sandboxed with
 * `allow-scripts` only (no `allow-same-origin`) has an opaque origin, so `'self'`
 * in the CSP would never match it, and the HTML spec resolves a `srcDoc`
 * document's relative URLs against its parent browsing context's address —
 * `window.location` here IS the parent page, since this runs in the host page,
 * not inside the sandboxed iframe. Returns `null` when there is no base URL, or
 * when it cannot be parsed (e.g. no `window` in a non-browser environment).
 */
export function deriveAssetOrigin(assetBaseUrl: string | null | undefined): string | null {
  if (!assetBaseUrl) return null;
  try {
    const base = typeof window !== "undefined" ? window.location.href : undefined;
    return new URL(assetBaseUrl, base).origin;
  } catch {
    return null;
  }
}
