/**
 * The screen's Word page (`.cv-word__page`, `styles/canvas.css`) declares the
 * same page as the Python door writes (U6): a Letter sheet, 8.5 in wide at
 * 96 dpi, with 1 in of padding on a border-box, so the text column is
 * 816 - 2 x 96 = 624 px = 6.5 in = 9360 twips — the grid the file's tables are
 * sized to. A string test proves the declaration only; the mounted gate (M7)
 * measures the drawn column.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(HERE, "..", "styles", "canvas.css"), "utf8");
const PX_PER_IN = 96;
const TWIPS_PER_IN = 1440;

function wordPageRule(): Record<string, string> {
  const match = CSS.match(/\.cv-word__page\s*\{([^}]*)\}/);
  if (!match) throw new Error("canvas.css has no .cv-word__page rule");
  return Object.fromEntries(
    match[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
      }),
  );
}

describe("the Word page contract (U6)", () => {
  it("declares a border-box Letter page with 1 in padding, a 9360-twip text column", () => {
    const rule = wordPageRule();
    expect(rule["box-sizing"]).toBe("border-box");
    const width = parseFloat(rule.width);
    const padding = parseFloat(rule.padding);
    expect(rule.padding).toBe(`${PX_PER_IN}px`);
    expect(width).toBe(8.5 * PX_PER_IN);
    expect(((width - 2 * padding) / PX_PER_IN) * TWIPS_PER_IN).toBe(9360);
    expect(parseFloat(rule["min-height"])).toBe(11 * PX_PER_IN);
  });
});
