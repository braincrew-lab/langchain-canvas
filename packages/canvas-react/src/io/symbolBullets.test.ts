/**
 * Symbol-font bullet replacement — what gets swapped, and what must not.
 *
 * The rules under test are the ones that keep a wrong mark off the page: the
 * font decides how a private code point is read, an unknown one stays as it
 * is, and standard characters are never touched.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  isPrivateUse,
  primaryFont,
  redrawnFonts,
  restoreSymbolBullets,
  standardBullet,
} from "./symbolBullets";

const SYMBOL_BULLET = "\u{F0B7}";
const WINGDINGS_DIAMOND = "\u{F075}";
const UNMAPPED_PUA = "\u{F8F0}";

/**
 * A rendered document: its own stylesheet, plus a paragraph for every class
 * the sheet styles — the same pairing docx-preview produces.
 */
function drawn(css: string): HTMLElement {
  const host = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = css;
  host.appendChild(style);
  for (const match of css.matchAll(/p\.([\w-]+)/g)) {
    const paragraph = document.createElement("p");
    paragraph.className = match[1];
    host.appendChild(paragraph);
  }
  document.body.appendChild(host);
  return host;
}

/** The same, with the stylesheet but none of the paragraphs. */
function unused(css: string): HTMLElement {
  const host = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = css;
  host.appendChild(style);
  document.body.appendChild(host);
  return host;
}

function contentOf(host: HTMLElement, index = 0): string {
  const sheet = host.querySelector("style")!.sheet!;
  return (sheet.cssRules[index] as CSSStyleRule).style.getPropertyValue("content");
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("standardBullet", () => {
  it("reads a private code point through the font that was asked for", () => {
    expect(standardBullet(0xf0b7, "Symbol")).toBe("•");
    expect(standardBullet(0xf075, "Wingdings")).toBe("◆");
    // Same code point, different font, different mark — which is why the font
    // has to be part of the question.
    expect(standardBullet(0xf06c, "Wingdings")).toBe("●");
    expect(standardBullet(0xf06c, "Symbol")).toBeNull();
  });

  it("knows nothing about fonts it has not been checked against", () => {
    for (const font of ["Wingdings 2", "Wingdings 3", "Webdings", "Arial"]) {
      expect(standardBullet(0xf0b7, font)).toBeNull();
      expect(standardBullet(0xf075, font)).toBeNull();
    }
  });

  it("reads the family the document named, quoted or not", () => {
    expect(primaryFont('"Symbol"')).toBe("symbol");
    expect(primaryFont("Symbol, serif")).toBe("symbol");
    expect(primaryFont("  'Wingdings' , Arial ")).toBe("wingdings");
    expect(standardBullet(0xf0b7, '"Symbol", serif')).toBe("•");
  });

  it("calls the private area what it is", () => {
    expect(isPrivateUse(0xf0b7)).toBe(true);
    expect(isPrivateUse(0x2610)).toBe(false);
    expect(isPrivateUse(0x25cf)).toBe(false);
  });
});

describe("restoreSymbolBullets", () => {
  it("swaps a Symbol bullet for the standard one, keeping the rest of the value", () => {
    const host = drawn(
      `p.docx-num-1-0::before { content: "${SYMBOL_BULLET}\\9 "; font-family: Symbol; }`,
    );
    const swaps = restoreSymbolBullets(host);
    expect(swaps).toEqual([{ from: SYMBOL_BULLET, to: "•", font: "symbol" }]);
    const content = contentOf(host);
    expect(content).toContain("•");
    expect(content).not.toContain(SYMBOL_BULLET);
    // The tab that follows the marker is part of the value and stays.
    expect(content).toMatch(/\\9/);
  });

  it("leaves a private code point it has no entry for exactly as it was", () => {
    const host = drawn(
      `p.a::before { content: "${UNMAPPED_PUA}"; font-family: Symbol; }`,
    );
    expect(restoreSymbolBullets(host)).toEqual([]);
    expect(contentOf(host)).toContain(UNMAPPED_PUA);
  });

  it("changes nothing in a font it does not know", () => {
    const host = drawn(
      `p.a::before { content: "${SYMBOL_BULLET}"; font-family: "Wingdings 2"; }`,
    );
    expect(restoreSymbolBullets(host)).toEqual([]);
    expect(contentOf(host)).toContain(SYMBOL_BULLET);
  });

  it("changes nothing when the rule does not say which font", () => {
    // Without the font the code point cannot be read, so it is not guessed at.
    const host = drawn(`p.a::before { content: "${SYMBOL_BULLET}"; }`);
    expect(restoreSymbolBullets(host)).toEqual([]);
    expect(contentOf(host)).toContain(SYMBOL_BULLET);
  });

  it("leaves standard characters alone", () => {
    const host = drawn(
      `p.a::before { content: "☐ ○ → ▲"; font-family: Symbol; }`,
    );
    expect(restoreSymbolBullets(host)).toEqual([]);
    expect(contentOf(host)).toContain("☐");
    expect(contentOf(host)).toContain("▲");
  });

  it("leaves a counter-based marker alone", () => {
    const css = `p.a::before { content: "" counter(docx-num-1-0) ". "; font-family: Symbol; }`;
    const host = drawn(css);
    expect(restoreSymbolBullets(host)).toEqual([]);
    expect(contentOf(host)).toContain("counter(");
  });

  it("reports every font it redrew, once each", () => {
    const host = drawn(
      `p.a::before { content: "${SYMBOL_BULLET}"; font-family: Symbol; }\n` +
        `p.b::before { content: "${WINGDINGS_DIAMOND}"; font-family: Wingdings; }\n` +
        `p.c::before { content: "${SYMBOL_BULLET}"; font-family: Symbol; }`,
    );
    const swaps = restoreSymbolBullets(host);
    expect(swaps).toHaveLength(3);
    expect(redrawnFonts(swaps)).toEqual(["symbol", "wingdings"]);
  });

  it("leaves a list definition nothing on the page uses alone", () => {
    // A Word file carries every list definition its template shipped with.
    // Rewriting one no paragraph draws changes nothing anyone can see, and
    // reporting it would be a notice about nothing.
    const host = unused(
      `p.docx-num-9-0::before { content: "${SYMBOL_BULLET}"; font-family: Symbol; }`,
    );
    expect(restoreSymbolBullets(host)).toEqual([]);
    expect(contentOf(host)).toContain(SYMBOL_BULLET);
  });

  it("walks into grouped rules", () => {
    const host = drawn(
      `@media screen { p.a::before { content: "${SYMBOL_BULLET}"; font-family: Symbol; } }`,
    );
    expect(restoreSymbolBullets(host)).toHaveLength(1);
  });
});
