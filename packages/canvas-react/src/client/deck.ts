/**
 * The canonical deck dialect, client side — one `*.slides.html` document per
 * presentation. Mirror of `langchain_canvas/deck/model.py`
 * (`parse_deck` / `serialize_deck` / `read_slide` / `patch_slide` /
 * `reorder_slides`): a deck's `<body>` holds one
 * `<template data-slide-id="…">` per slide, so a one-slide edit never
 * rewrites bytes belonging to any other slide, and two byte-identical slides
 * (a duplicated template) are still addressed by id, not content.
 *
 * Every patch function operates on the deck HTML as a *string* — a plain
 * span-splice on the matched `<template>`, never a full parse/reserialize
 * round trip through `DOMParser` — because reserializing would perturb
 * whitespace and attribute order in every *other* slide's markup, and
 * `<template>` content is inert in a live DOM (`template.content` is a
 * `DocumentFragment`), so a document-level `querySelector` can't reach into
 * it anyway.
 *
 * `slideDocFor` is the one function that *does* build a real (non-template)
 * document: it's the srcDoc for an iframe that actually renders a slide, so
 * the slide's `<template>` contents are lifted into a live `<body>`.
 */

import { isAssetReference, resolveAssetUrl } from "../io/canvasAssets";

export class DeckParseError extends Error {}

/** One slide's `<template>` contents — the four fields `SlideTemplate` (Python) carries. */
export interface DeckSlideTemplate {
  slideId: string;
  title: string | null;
  styleCss: string;
  bodyHtml: string;
}

/** A parsed deck: document-level metadata plus its slides in order. */
export interface Deck {
  title: string;
  ratio: string;
  source: string | null;
  slides: DeckSlideTemplate[];
}

const NODE_ID_ATTR = "data-node-id";

// --- attribute / entity helpers --------------------------------------------------

function decodeHtmlEntities(value: string): string {
  if (typeof document === "undefined") return value;
  const box = document.createElement("textarea");
  box.innerHTML = value;
  return box.value;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Read `name="value"` (or `'value'`) out of a raw attribute-list string. */
function readAttr(attrsText: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attrsText.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  if (!match) return null;
  return decodeHtmlEntities(match[2] ?? match[3] ?? "");
}

function firstTagText(html: string, tagName: string): string | null {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>`, "i"));
  return match ? match[0] : null;
}

// --- top-level <template> span scanning ------------------------------------------

interface SlideSpan {
  slideId: string;
  outerStart: number;
  outerEnd: number;
}

/** Byte offsets of every top-level `<template>` in `html`, depth-tracked so a
 *  `<template>` nested inside a slide's own body never terminates its parent's span. */
function findSlideSpans(html: string): SlideSpan[] {
  const spans: SlideSpan[] = [];
  const tagRe = /<(\/?)template\b([^>]*)>/gi;
  let depth = 0;
  let outerStart = -1;
  let slideId = "";
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const isClose = match[1] === "/";
    if (!isClose) {
      if (depth === 0) {
        outerStart = match.index;
        slideId = readAttr(match[2], "data-slide-id") ?? "";
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) {
        spans.push({ slideId, outerStart, outerEnd: match.index + match[0].length });
      }
    }
  }
  return spans;
}

// --- generic element-by-attribute scanning (for node-scoped patching) -----------

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

interface ElementSpan {
  outerStart: number;
  outerEnd: number;
}

/**
 * The first element in `html` whose `attrName` equals `attrValue`, by tag-name
 * depth tracking (not a real HTML parser — sufficient for the well-formed
 * markup a deck's own tools produce, and deliberately scoped to a single
 * slide's substring rather than the whole document).
 */
function findElementByAttr(html: string, attrName: string, attrValue: string): ElementSpan | null {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/g;
  const stack: { tagName: string; start: number; attrs: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const [whole, closing, tagName, attrs, selfClose] = match;
    const lower = tagName.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tagName !== lower) continue;
        const [opened] = stack.splice(i);
        if (readAttr(opened.attrs, attrName) === attrValue) {
          return { outerStart: opened.start, outerEnd: match.index + whole.length };
        }
        break;
      }
      continue;
    }
    if (selfClose || VOID_TAGS.has(lower)) {
      if (readAttr(attrs, attrName) === attrValue) {
        return { outerStart: match.index, outerEnd: match.index + whole.length };
      }
      continue;
    }
    stack.push({ tagName: lower, start: match.index, attrs });
  }
  return null;
}

// --- slide template (de)serialization --------------------------------------------

const STYLE_RE = /^\s*<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/i;
// Unanchored variant: a slide document's <head> carries <meta charset> before
// the <style>, so the ^-anchored STYLE_RE (which enforces style-first inside a
// <template>) would miss it. Used only when reading style out of a full <head>.
const HEAD_STYLE_RE = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/i;

function buildSlideTemplate(templateOuterHtml: string, slideId: string): DeckSlideTemplate {
  const openTag = templateOuterHtml.match(/^<template\b([^>]*)>/i);
  const attrsText = openTag ? openTag[1] : "";
  const title = readAttr(attrsText, "data-slide-title");
  const innerStart = openTag ? openTag[0].length : 0;
  const rawContent = templateOuterHtml.slice(innerStart, templateOuterHtml.length - "</template>".length);
  const styleMatch = rawContent.match(STYLE_RE);
  const styleCss = styleMatch ? styleMatch[1].trim() : "";
  const bodyHtml = styleMatch ? rawContent.slice(styleMatch[0].length).trim() : rawContent.trim();
  return { slideId, title, styleCss, bodyHtml };
}

function serializeSlideTemplate(slide: DeckSlideTemplate): string {
  let attrs = ` data-slide-id="${escapeAttr(slide.slideId)}"`;
  if (slide.title) attrs += ` data-slide-title="${escapeAttr(slide.title)}"`;
  const parts = [`<template${attrs}>`];
  if (slide.styleCss) parts.push(`<style>${slide.styleCss}</style>`);
  parts.push(slide.bodyHtml);
  parts.push("</template>");
  return parts.join("\n");
}

// --- public API -------------------------------------------------------------------

/** Parse a `*.slides.html` document into a {@link Deck}. */
export function parseDeckHtml(html: string): Deck {
  const htmlTag = firstTagText(html, "html");
  const ratio = (htmlTag && readAttr(htmlTag, "data-ratio")) || "16:9";
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : "";
  const source = findMetaSource(html);
  const slides = findSlideSpans(html).map((span) =>
    buildSlideTemplate(html.slice(span.outerStart, span.outerEnd), span.slideId),
  );
  return { title, ratio, source, slides };
}

function findMetaSource(html: string): string | null {
  const metaRe = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRe.exec(html))) {
    if ((readAttr(match[1], "name") ?? "").toLowerCase() === "lcx:source") {
      return readAttr(match[1], "content");
    }
  }
  return null;
}

/** The one slide with `slideId` out of `deckHtml`. Throws if absent. */
export function readDeckSlide(deckHtml: string, slideId: string): DeckSlideTemplate {
  for (const slide of parseDeckHtml(deckHtml).slides) {
    if (slide.slideId === slideId) return slide;
  }
  throw new DeckParseError(`no slide with id ${JSON.stringify(slideId)}`);
}

/**
 * `deckHtml` with only the `slideId` template replaced. `newTemplateHtml` is a
 * full `<template data-slide-id="…">…</template>` fragment. Every other
 * slide's bytes are untouched — the replacement is a plain string slice on
 * the matched span, keyed by id so a duplicated (byte-identical) sibling
 * slide is never affected.
 */
export function patchDeckSlide(deckHtml: string, slideId: string, newTemplateHtml: string): string {
  const span = findSlideSpans(deckHtml).find((s) => s.slideId === slideId);
  if (!span) throw new DeckParseError(`no slide with id ${JSON.stringify(slideId)}`);
  return deckHtml.slice(0, span.outerStart) + newTemplateHtml + deckHtml.slice(span.outerEnd);
}

/**
 * `deckHtml` with the element carrying `data-node-id="nodeId"` inside slide
 * `slideId` replaced by `nodeHtml` — scoped to that slide's own `<template>`
 * span, never a document-level `querySelector`. Throws if the slide or the
 * node is missing (a stale id must not silently no-op a user's edit).
 */
export function patchDeckNode(deckHtml: string, slideId: string, nodeId: string, nodeHtml: string): string {
  const span = findSlideSpans(deckHtml).find((s) => s.slideId === slideId);
  if (!span) throw new DeckParseError(`no slide with id ${JSON.stringify(slideId)}`);
  const slideHtml = deckHtml.slice(span.outerStart, span.outerEnd);
  const nodeSpan = findElementByAttr(slideHtml, NODE_ID_ATTR, nodeId);
  if (!nodeSpan) {
    throw new DeckParseError(`no node with id ${JSON.stringify(nodeId)} in slide ${JSON.stringify(slideId)}`);
  }
  const patchedSlide = slideHtml.slice(0, nodeSpan.outerStart) + nodeHtml + slideHtml.slice(nodeSpan.outerEnd);
  return deckHtml.slice(0, span.outerStart) + patchedSlide + deckHtml.slice(span.outerEnd);
}

/**
 * `deckHtml` with its top-level `<template>` blocks reordered. `orderedIds`
 * must be exactly the deck's existing slide ids, in the desired order; each
 * slide's bytes carry over unchanged.
 */
export function reorderDeck(deckHtml: string, orderedIds: string[]): string {
  const spans = findSlideSpans(deckHtml);
  if (!spans.length) return deckHtml;
  const byId = new Map(spans.map((s) => [s.slideId, deckHtml.slice(s.outerStart, s.outerEnd)]));
  const currentIds = new Set(spans.map((s) => s.slideId));
  const wantedIds = new Set(orderedIds);
  const sameSet =
    currentIds.size === wantedIds.size && [...currentIds].every((id) => wantedIds.has(id));
  if (!sameSet) throw new DeckParseError("reorderDeck requires exactly the deck's existing slide ids");
  const regionStart = Math.min(...spans.map((s) => s.outerStart));
  const regionEnd = Math.max(...spans.map((s) => s.outerEnd));
  const reordered = orderedIds.map((id) => byId.get(id) as string).join("\n");
  return deckHtml.slice(0, regionStart) + reordered + deckHtml.slice(regionEnd);
}

/**
 * The iframe `srcDoc` for one slide — shared by the thumbnail rail and the
 * active stage. The slide's `<template>` contents are lifted into a real
 * `<body>` (a `<template>`'s own content never renders), tagged with the
 * slide's id/title so {@link extractTemplateFromSlideDoc} can rebuild the
 * `<template>` fragment after a structural edit. Canvas-asset references
 * (`assets/…` / `sources/…`) are resolved against `assetBaseUrl` for display,
 * the same contract `io/canvasAssets.ts::resolveAssetUrl` documents.
 */
export function slideDocFor(slide: DeckSlideTemplate, ratio: string, assetBaseUrl?: string): string {
  const [rw, rh] = ratio.split(/[:x/]/).map(Number);
  const height = rw > 0 && rh > 0 ? Math.round(1280 * rh / rw) : 720;
  // Identical layout in stage, thumbnail, and export. Injected chrome is
  // excluded from edit serialization via data-lcx.
  const baseStyle =
    `<style data-lcx>html{margin:0;overflow:hidden;background:transparent}` +
    `body{margin:0;width:1280px;height:${height}px}*{box-sizing:border-box}</style>`;
  const styleTag = slide.styleCss ? `<style>${slide.styleCss}</style>` : "";
  const titleAttr = slide.title ? ` data-slide-title="${escapeAttr(slide.title)}"` : "";
  const doc =
    `<!doctype html>\n<html data-ratio="${escapeAttr(ratio)}"><head><meta charset="utf-8">` +
    `${baseStyle}${styleTag}</head><body data-slide-id="${escapeAttr(slide.slideId)}"${titleAttr}>` +
    `${slide.bodyHtml}</body></html>`;
  return rewriteAssetSrcs(doc, assetBaseUrl);
}

/**
 * Resolve `assets/…` / `sources/…` `src` references to `assetBaseUrl` for
 * display, keeping the original relative reference in `data-lcx-src` — the
 * same convention `client/inspector.ts::rewriteAssetSrcs` uses inside the
 * iframe. `scrub()` there restores `src` from `data-lcx-src` before a
 * `node_edit`/`doc_edit` leaves the frame, so a saved edit persists the
 * portable relative reference, never the resolved absolute URL.
 */
function rewriteAssetSrcs(html: string, assetBaseUrl: string | undefined): string {
  if (!assetBaseUrl) return html;
  return html.replace(
    /<img\b([^>]*?)\ssrc=(["'])([^"']*)\2([^>]*)>/gi,
    (whole, pre: string, quote: string, src: string, post: string) =>
      isAssetReference(src)
        ? `<img${pre} data-lcx-src=${quote}${src}${quote} src=${quote}${resolveAssetUrl(src, assetBaseUrl)}${quote}${post}>`
        : whole,
  );
}

/**
 * The `<template data-slide-id="…">…</template>` fragment for `slideId`, out
 * of the active slide iframe's current document (as produced by
 * {@link slideDocFor} and possibly edited in place). The inverse of
 * `slideDocFor`'s `<body>` framing — feeds {@link patchDeckSlide}.
 */
export function extractTemplateFromSlideDoc(slideDoc: string, slideId: string): string {
  const bodyMatch = slideDoc.match(/<body\b([^>]*)>([\s\S]*)<\/body>/i);
  if (!bodyMatch) throw new DeckParseError("slide document has no <body>");
  const [, bodyAttrs, bodyHtml] = bodyMatch;
  const docSlideId = readAttr(bodyAttrs, "data-slide-id");
  if (docSlideId !== slideId) {
    throw new DeckParseError(
      `slide document data-slide-id ${JSON.stringify(docSlideId)} does not match ${JSON.stringify(slideId)}`,
    );
  }
  const title = readAttr(bodyAttrs, "data-slide-title");
  const headMatch = slideDoc.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  // Injected chrome (the fixed-canvas base style, inspector css) is tagged
  // data-lcx — never the slide's own styleCss, so drop it before matching.
  const headContent = headMatch ? headMatch[1].replace(/<style\s[^>]*\bdata-lcx\b[^>]*>[\s\S]*?<\/style>/gi, "") : "";
  const styleMatch = headContent ? headContent.match(HEAD_STYLE_RE) : null;
  const styleCss = styleMatch ? styleMatch[1].trim() : "";
  return serializeSlideTemplate({ slideId, title, styleCss, bodyHtml: bodyHtml.trim() });
}
