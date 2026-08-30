import { scenarios } from "@braincrew-lab/langchain-canvas";
import { describe, expect, it } from "vitest";

import { NAV_LINKS, SCENARIO_ICONS, TYPE_LABELS } from "./ui-constants";

describe("ui-constants", () => {
  it("NAV_LINKS matches design order", () => {
    expect(NAV_LINKS).toEqual([
      { href: "/chat", label: "Chat" },
      { href: "/replay", label: "Replay" },
      { href: "/", label: "Schema" },
    ]);
  });

  it("test_scenario_icons_cover_all_scenario_ids", () => {
    const scenarioIds = scenarios.map((scenario) => scenario.id);
    expect(scenarioIds.length).toBeGreaterThan(0);
    for (const id of scenarioIds) {
      expect(Object.keys(SCENARIO_ICONS)).toContain(id);
    }
  });

  it("test_type_labels_are_wire_type_names", () => {
    expect(Object.values(TYPE_LABELS)).toEqual([
      "html",
      "document",
      "chart",
      "table",
      "slides",
      "json",
    ]);
  });
});
