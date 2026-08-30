import { describe, expect, it } from "vitest";

import {
  DeckParseError,
  extractTemplateFromSlideDoc,
  parseDeckHtml,
  patchDeckNode,
  patchDeckSlide,
  readDeckSlide,
  reorderDeck,
  slideDocFor,
} from "./deck";

/**
 * Hand-built to match `langchain_canvas/deck/model.py::serialize_deck`'s exact
 * output format byte for byte (see `model.py:203-224`) — the "shared fixture"
 * both parsers must agree on, since no `.slides.html` file exists in the repo
 * yet to import directly from a TS test.
 */
function pythonStyleDeck(): string {
  return [
    "<!DOCTYPE html>",
    '<html data-lcx-dialect="1" data-ratio="16:9">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Q3 Review</title>",
    '<meta name="lcx:source" content="sources/deck.pptx">',
    "</head>",
    "<body>",
    [
      '<template data-slide-id="s1" data-slide-title="Intro">',
      "<style>.title{color:red}</style>",
      "<h1>Welcome</h1>",
      "</template>",
    ].join("\n"),
    ["<template data-slide-id=\"s2\">", "<p>No title, no style</p>", "</template>"].join("\n"),
    // A byte-identical sibling of s1's body — verifies id-scoped (not
    // content-scoped) matching for patch/reorder/node-patch.
    [
      '<template data-slide-id="s3" data-slide-title="Intro">',
      "<style>.title{color:red}</style>",
      "<h1>Welcome</h1>",
      "</template>",
    ].join("\n"),
    "</body>",
    "</html>",
  ].join("\n") + "\n";
}

describe("parseDeckHtml", () => {
  it("matches the four SlideTemplate fields Python's parse_deck produces", () => {
    const deck = parseDeckHtml(pythonStyleDeck());
    expect(deck.title).toBe("Q3 Review");
    expect(deck.ratio).toBe("16:9");
    expect(deck.source).toBe("sources/deck.pptx");
    expect(deck.slides).toEqual([
      { slideId: "s1", title: "Intro", styleCss: ".title{color:red}", bodyHtml: "<h1>Welcome</h1>" },
      { slideId: "s2", title: null, styleCss: "", bodyHtml: "<p>No title, no style</p>" },
      { slideId: "s3", title: "Intro", styleCss: ".title{color:red}", bodyHtml: "<h1>Welcome</h1>" },
    ]);
  });

  it("defaults ratio to 16:9 and title to empty when absent", () => {
    const deck = parseDeckHtml("<html><head><title></title></head><body></body></html>");
    expect(deck.ratio).toBe("16:9");
    expect(deck.title).toBe("");
    expect(deck.source).toBeNull();
    expect(deck.slides).toEqual([]);
  });
});

describe("readDeckSlide", () => {
  it("returns the one slide with the given id", () => {
    expect(readDeckSlide(pythonStyleDeck(), "s2").bodyHtml).toBe("<p>No title, no style</p>");
  });

  it("throws for a missing id", () => {
    expect(() => readDeckSlide(pythonStyleDeck(), "ghost")).toThrow(DeckParseError);
  });
});

describe("patchDeckSlide", () => {
  it("replaces only the targeted slide's template, byte for byte, leaving byte-identical siblings untouched", () => {
    const html = pythonStyleDeck();
    const replacement = '<template data-slide-id="s1"><h1>Changed</h1></template>';
    const next = patchDeckSlide(html, "s1", replacement);
    expect(parseDeckHtml(next).slides[0]).toEqual({
      slideId: "s1", title: null, styleCss: "", bodyHtml: "<h1>Changed</h1>",
    });
    // s3 is byte-identical to the old s1 — must survive unchanged despite the
    // content match, because matching is keyed on data-slide-id, not text.
    expect(parseDeckHtml(next).slides[2]).toEqual({
      slideId: "s3", title: "Intro", styleCss: ".title{color:red}", bodyHtml: "<h1>Welcome</h1>",
    });
    expect(parseDeckHtml(next).slides[1]).toEqual(parseDeckHtml(html).slides[1]); // s2 untouched
  });

  it("throws for a missing slide id", () => {
    expect(() => patchDeckSlide(pythonStyleDeck(), "ghost", "<template></template>")).toThrow(DeckParseError);
  });
});

describe("patchDeckNode", () => {
  function deckWithNodes(): string {
    return [
      '<html data-ratio="16:9"><head><title>D</title></head><body>',
      '<template data-slide-id="s1">',
      '<p data-node-id="n1">one</p><p data-node-id="n2">two</p>',
      "</template>",
      '<template data-slide-id="s2">',
      // Same nodeId text as s1's n1 — id-scoping within the slide span must
      // still resolve to *this* slide's node, not s1's.
      '<p data-node-id="n1">two-s2</p>',
      "</template>",
      "</body></html>",
    ].join("\n");
  }

  it("replaces only the addressed node inside the addressed slide", () => {
    const next = patchDeckNode(deckWithNodes(), "s1", "n2", '<p data-node-id="n2">TWO</p>');
    expect(next).toContain('<p data-node-id="n1">one</p><p data-node-id="n2">TWO</p>');
    // The other slide's byte-identical node id is untouched.
    expect(next).toContain('<p data-node-id="n1">two-s2</p>');
  });

  it("scopes by slide: the same nodeId in a different slide is not touched", () => {
    const next = patchDeckNode(deckWithNodes(), "s2", "n1", '<p data-node-id="n1">CHANGED</p>');
    expect(next).toContain('<p data-node-id="n1">CHANGED</p>');
    expect(next).toContain('<p data-node-id="n1">one</p>'); // s1's n1 untouched
  });

  it("throws — never silently no-ops — when the slide is missing", () => {
    expect(() => patchDeckNode(deckWithNodes(), "ghost", "n1", "<p>x</p>")).toThrow(DeckParseError);
  });

  it("throws — never silently no-ops — when the node id is missing", () => {
    expect(() => patchDeckNode(deckWithNodes(), "s1", "ghost", "<p>x</p>")).toThrow(DeckParseError);
  });
});

describe("reorderDeck", () => {
  it("reorders top-level templates, carrying each slide's bytes over unchanged", () => {
    const next = reorderDeck(pythonStyleDeck(), ["s3", "s1", "s2"]);
    expect(parseDeckHtml(next).slides.map((s) => s.slideId)).toEqual(["s3", "s1", "s2"]);
  });

  it("throws when the id set does not match exactly", () => {
    expect(() => reorderDeck(pythonStyleDeck(), ["s1", "s2"])).toThrow(DeckParseError);
    expect(() => reorderDeck(pythonStyleDeck(), ["s1", "s2", "s3", "ghost"])).toThrow(DeckParseError);
  });

  it("is a no-op on a deck with no slides", () => {
    const html = "<html><body></body></html>";
    expect(reorderDeck(html, [])).toBe(html);
  });
});

describe("slideDocFor / extractTemplateFromSlideDoc round trip", () => {
  it("lifts a slide's template content into a real <body>, then reconstructs the same fragment", () => {
    const slide = readDeckSlide(pythonStyleDeck(), "s1");
    const doc = slideDocFor(slide, "16:9");
    expect(doc).toContain('data-slide-id="s1"');
    expect(doc).toContain('data-slide-title="Intro"');
    expect(doc).toContain("<h1>Welcome</h1>");

    const fragment = extractTemplateFromSlideDoc(doc, "s1");
    expect(fragment).toBe('<template data-slide-id="s1" data-slide-title="Intro">\n<style>.title{color:red}</style>\n<h1>Welcome</h1>\n</template>');
  });

  it("round-trips edited body content back through patchDeckSlide", () => {
    const html = pythonStyleDeck();
    const slide = readDeckSlide(html, "s2");
    const doc = slideDocFor(slide, "16:9").replace("<p>No title, no style</p>", "<p>Edited</p>");
    const fragment = extractTemplateFromSlideDoc(doc, "s2");
    const next = patchDeckSlide(html, "s2", fragment);
    expect(readDeckSlide(next, "s2").bodyHtml).toBe("<p>Edited</p>");
  });

  it("throws when the doc's slide id does not match the one requested", () => {
    const doc = slideDocFor(readDeckSlide(pythonStyleDeck(), "s1"), "16:9");
    expect(() => extractTemplateFromSlideDoc(doc, "s2")).toThrow(DeckParseError);
  });

  it("rewrites assets/ and sources/ src references against assetBaseUrl", () => {
    const slide = readDeckSlide(pythonStyleDeck(), "s1");
    const withImage = { ...slide, bodyHtml: '<img src="assets/logo.png">' };
    const doc = slideDocFor(withImage, "16:9", "http://host/file?path=");
    expect(doc).toContain('src="http://host/file?path=assets%2Flogo.png"');
  });
});
