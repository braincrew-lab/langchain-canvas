import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// This suite asserts on the raw stylesheet text — canvas.css has no build step of
// its own (consumers import it directly), so a text-level contract is the correct
// granularity: it verifies the token contract and theme-scoping shape without
// needing a CSS parser dependency.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(TEST_DIR, "canvas.css");
const css = readFileSync(CSS_PATH, "utf-8");

/** Extract the body of the first `:root { ... }` block in the stylesheet. */
function extractRootBlock(source: string): string {
  const match = source.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!match) {
    throw new Error("no :root block found in canvas.css");
  }
  return match[1];
}

describe("canvas.css token contract", () => {
  it("scopes dark-theme overrides to a `.dark` class instead of an auto media query", () => {
    const mediaQueryCount = (css.match(/prefers-color-scheme/g) ?? []).length;
    expect(mediaQueryCount).toBe(0);
    expect(css).toContain(".dark {");
  });

  it("defines the full light-default token contract in :root", () => {
    const root = extractRootBlock(css);

    const expectedTokens = [
      "--cv-bg",
      "--cv-surface",
      "--cv-border",
      "--cv-border-soft",
      "--cv-text",
      "--cv-text-secondary",
      "--cv-muted",
      "--cv-tag-bg",
      "--cv-accent",
      "--cv-accent-weak",
      "--cv-accent-text",
      "--cv-accent-border",
      "--cv-cta",
      "--cv-cta-hover",
      "--cv-sidebar-active",
      "--cv-sidebar-selected",
      "--cv-user-bubble",
      "--cv-destructive-text",
      "--cv-destructive-light",
      "--cv-destructive-border",
      "--cv-radius",
      "--cv-radius-md",
      "--cv-radius-xl",
      "--cv-shadow-card",
      "--cv-font",
      "--cv-font-display",
      "--cv-mono",
    ];

    for (const token of expectedTokens) {
      expect(root).toMatch(new RegExp(`${token}\\s*:`));
    }

    expect(root).toMatch(/--cv-bg\s*:\s*#F9FAFB/i);
    expect(root).toMatch(/--cv-accent\s*:\s*#9360FF/i);
    expect(root).toMatch(/--cv-cta\s*:\s*#704BD6/i);
    expect(root).toMatch(/--cv-radius\s*:\s*0/i);
    expect(root).toMatch(/--cv-sidebar-active\s*:\s*#EFE4F7/i);
    expect(root).toMatch(/--cv-destructive-text\s*:\s*#B91C1C/i);
  });

  it("never falls back to a hard-coded accent literal via var(--cv-accent, #...)", () => {
    const matches = css.match(/var\(--cv-accent,\s*#/g) ?? [];
    expect(matches).toHaveLength(0);
  });

  it("cards use a soft border and the sm radius token (not a hard-coded 12px)", () => {
    // Anchor on `cursor: pointer`, the property unique to the inline artifact
    // card ruleset — `.cv-card` is reused by the entrance-animation keyframe
    // rule earlier in the file, so a plain selector match would find the
    // wrong block.
    const match = css.match(/\.cv-card\s*\{[^}]*cursor:\s*pointer[^}]*\}/);
    expect(match).not.toBeNull();
    const block = match![0];
    expect(block).toContain("var(--cv-border-soft)");
    expect(block).toContain("var(--cv-radius)");
  });

  it("the active tab state is an underline, not a pill background", () => {
    const match = css.match(/\.cv-tab\.is-active\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const block = match![1];
    expect(block).toContain("border-bottom-color");
    expect(block).not.toContain("var(--cv-accent-weak)");
  });

  it("badges use semantic accent/destructive tokens instead of hard-coded hex/rgba", () => {
    const match = css.match(/\.cv-badge--streaming\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("var(--cv-accent-text)");

    expect((css.match(/#059669/g) ?? []).length).toBe(0);
    expect((css.match(/rgba\(16,\s*185,\s*129/g) ?? []).length).toBe(0);
  });

  it("the active deck thumbnail is marked by a brand border, not a ring shadow", () => {
    expect((css.match(/box-shadow:\s*0 0 0 1px/g) ?? []).length).toBe(0);
  });
});
