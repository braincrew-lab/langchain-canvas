import { describe, expect, it } from "vitest";

import { createCanvasStore } from "../store/store";
import { isLegacySlidesData } from "../protocol/artifacts";
import { parseDeckHtml } from "../client/deck";
import { scenarios } from "./scenarios";

describe("scenarios", () => {
  it("ends every scenario with a done event", () => {
    for (const scenario of scenarios) {
      const lastEvent = scenario.events[scenario.events.length - 1];
      expect(lastEvent).toEqual({ type: "done" });
    }
  });
});

describe("slides scenario", () => {
  const scenario = scenarios.find((s) => s.id === "slides");
  if (!scenario) throw new Error("slides scenario not found in fixtures");
  const slidesEvents = scenario.events;

  function applyScenario() {
    const store = createCanvasStore();
    store.getState().applyEvents(slidesEvents);
    const artifact = store.getState().canvas.artifacts.deck;
    if (!artifact) throw new Error("deck artifact was not created by the slides scenario");
    return artifact;
  }

  it("emits a canonical (non-legacy) *.slides.html deck artifact", () => {
    const artifact = applyScenario();
    expect(isLegacySlidesData(artifact.data)).toBe(false);
  });

  it("parses to 5 slides via parseDeckHtml", () => {
    const artifact = applyScenario();
    const data = artifact.data as { html: string };
    const deck = parseDeckHtml(data.html);
    expect(deck.slides).toHaveLength(5);
  });

  it("keeps <style> as the first child of every slide template (style-first invariant)", () => {
    const artifact = applyScenario();
    const data = artifact.data as { html: string };
    const deck = parseDeckHtml(data.html);
    for (const slide of deck.slides) {
      expect(slide.bodyHtml).not.toMatch(/<style/i);
    }
  });

  it("carries meta.kind = 'deck' so the deck style panel activates", () => {
    const artifact = applyScenario();
    expect(artifact.meta?.kind).toBe("deck");
  });
});
