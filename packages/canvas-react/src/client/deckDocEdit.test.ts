import { describe, expect, it } from "vitest";

import { DeckParseError, extractTemplateFromSlideDoc, parseDeckHtml, patchDeckSlide, readDeckSlide, slideDocFor } from "./deck";

/**
 * Regression guard for the `DeckStage` `doc_edit` path
 * (`components/renderers/DeckStage.tsx`): a structural edit inside one
 * slide's iframe — `extractTemplateFromSlideDoc` (the edited slide document
 * turned back into a `<template>` fragment) then `patchDeckSlide` (spliced
 * into the deck at that slide's own span) — must never touch the bytes of
 * any other slide. Regressing to a whole-deck `html` replace (the clobber
 * the module doc comment on `DeckStage.tsx` calls out) would fail this test
 * by mutating `s2`/`s3`.
 */
function threeSlideDeck(): string {
  return [
    "<!doctype html>",
    '<html data-ratio="16:9">',
    "<head><title>Deck</title></head>",
    "<body>",
    '<template data-slide-id="s1" data-slide-title="One"><style>.a{color:red}</style><h1>One</h1></template>',
    '<template data-slide-id="s2"><p>Two, untouched</p></template>',
    '<template data-slide-id="s3"><p>Three, untouched</p></template>',
    "</body>",
    "</html>",
  ].join("\n");
}

describe("DeckStage doc_edit path (extractTemplateFromSlideDoc -> patchDeckSlide)", () => {
  it("leaves every other slide's bytes byte-for-byte unchanged", () => {
    const deckHtml = threeSlideDeck();
    const s2Before = readDeckSlide(deckHtml, "s2");
    const s3Before = readDeckSlide(deckHtml, "s3");

    // Simulate the inspector's structural edit: the active slide's iframe
    // document (built by slideDocFor) gets a new heading, then the inspector
    // posts the edited document back as doc_edit's `html`.
    const slide = readDeckSlide(deckHtml, "s1");
    const editedSlideDoc = slideDocFor(slide, "16:9").replace("<h1>One</h1>", "<h1>One (edited)</h1>");

    const templateHtml = extractTemplateFromSlideDoc(editedSlideDoc, "s1");
    const nextDeckHtml = patchDeckSlide(deckHtml, "s1", templateHtml);

    expect(readDeckSlide(nextDeckHtml, "s1").bodyHtml).toContain("One (edited)");
    // The regression this guards against: a whole-deck replace would drop or
    // rewrite s2/s3 instead of leaving them exactly as they were.
    expect(readDeckSlide(nextDeckHtml, "s2")).toEqual(s2Before);
    expect(readDeckSlide(nextDeckHtml, "s3")).toEqual(s3Before);
  });

  it("preserves the edited slide's own styleCss through the round trip", () => {
    const deckHtml = threeSlideDeck();
    const slide = readDeckSlide(deckHtml, "s1");
    const editedSlideDoc = slideDocFor(slide, "16:9").replace("<h1>One</h1>", "<h2>One v2</h2>");

    const templateHtml = extractTemplateFromSlideDoc(editedSlideDoc, "s1");
    const nextDeckHtml = patchDeckSlide(deckHtml, "s1", templateHtml);

    const patched = readDeckSlide(nextDeckHtml, "s1");
    expect(patched.styleCss).toBe(".a{color:red}");
    expect(patched.bodyHtml).toContain("<h2>One v2</h2>");
    expect(patched.title).toBe("One");
  });

  it("keeps deck slide count and order stable across the doc_edit round trip", () => {
    const deckHtml = threeSlideDeck();
    const slide = readDeckSlide(deckHtml, "s2");
    const editedSlideDoc = slideDocFor(slide, "16:9").replace("Two, untouched", "Two, edited");

    const templateHtml = extractTemplateFromSlideDoc(editedSlideDoc, "s2");
    const nextDeckHtml = patchDeckSlide(deckHtml, "s2", templateHtml);

    expect(parseDeckHtml(nextDeckHtml).slides.map((s) => s.slideId)).toEqual(["s1", "s2", "s3"]);
  });

  it("throws (never silently clobbers) when the edited document's slide id no longer matches", () => {
    const slide = readDeckSlide(threeSlideDeck(), "s1");
    const slideDoc = slideDocFor(slide, "16:9");
    // A stale/foreign slide id — extractTemplateFromSlideDoc must refuse to
    // rebuild a template under the wrong address rather than mislabel it.
    expect(() => extractTemplateFromSlideDoc(slideDoc, "s-does-not-exist")).toThrow(DeckParseError);
  });
});
