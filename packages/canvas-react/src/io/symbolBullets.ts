/**
 * Symbol-font bullets, drawn as standard characters.
 *
 * Word writes a list bullet as a character in a *symbol font's* own private
 * area — `U+F0B7` in `Symbol`, `U+F075` in `Wingdings`. Those code points mean
 * nothing on their own. `U+F0B7` is not "a bullet"; it is "draw slot 0xB7 of
 * the font called Symbol", and every symbol font fills that area differently.
 * A machine without that exact font has nothing to fall back to — no other
 * font claims the code point — so the marker comes out as an empty box while
 * the rest of the document looks fine.
 *
 * The fix is to say the same thing in a language every font speaks: swap the
 * private code point for the standard character that means the same mark. The
 * page then needs no particular font, and nothing has to be shipped.
 *
 * Two rules keep this honest:
 *
 * - **The font decides.** A private code point is read through the table of
 *   the font that was asked for, never on its own. The same `U+F075` is a
 *   diamond in Wingdings and something else elsewhere.
 * - **Only what is known.** The tables below hold marks used as list bullets,
 *   each one checked against the font it comes from. A private code point with
 *   no entry is left exactly as it was: an empty box is a visible, honest
 *   failure, and a plausible-looking wrong mark is not.
 *
 * This changes what is drawn, never what is stored. The file on the canvas is
 * untouched; a download is byte-for-byte the document that was uploaded.
 */

/** One replacement made on the page, for telling the reader about it. */
export interface BulletSwap {
  /** The private-area character the file asked for. */
  from: string;
  /** The standard character drawn instead. */
  to: string;
  /** The font family the file named. */
  font: string;
}

/**
 * Private-area bullets per font, as `code point → standard character`.
 *
 * Keys are lowercase font family names. Values are the marks that appear as
 * list bullets in real documents; the shapes were compared against the fonts
 * themselves and against the same document rendered by an office engine.
 *
 * Deliberately small. `Symbol` carries one entry because `0xB7` is the only
 * slot Word uses as a bullet there — the rest of that font is Greek letters
 * and maths signs, and the neighbouring slot people assume is a square is
 * really a club suit. `Wingdings 2`, `Wingdings 3` and `Webdings` have no
 * entries: their slots differ from `Wingdings`, and nothing here has been
 * checked against them, so their marks are left alone.
 */
export const SYMBOL_FONT_BULLETS: Readonly<
  Record<string, Readonly<Record<number, string>>>
> = {
  symbol: {
    0xf0b7: "•", // • bullet — Word's default list bullet
  },
  wingdings: {
    0xf06c: "●", // ● black circle
    0xf06d: "❍", // ❍ shadowed white circle
    0xf06e: "■", // ■ black square
    0xf06f: "□", // □ white square
    0xf071: "❑", // ❑ lower-right shadowed white square
    0xf075: "◆", // ◆ black diamond
    0xf0a7: "▪", // ▪ black small square
    0xf0d8: "➢", // ➢ three-d top-lighted right arrowhead
    0xf0fc: "✔", // ✔ heavy check mark
    0xf0fe: "☑", // ☑ ballot box with check
  },
};

/** True for the private use area — the range that means nothing on its own. */
export function isPrivateUse(codePoint: number): boolean {
  return codePoint >= 0xe000 && codePoint <= 0xf8ff;
}

/**
 * The font family a CSS `font-family` value asks for first, lowercased.
 *
 * Only the first family matters: it is the one the document named, and the
 * rest are the browser's fallbacks, which is exactly what fails here.
 */
export function primaryFont(fontFamily: string): string {
  const first = fontFamily.split(",")[0] ?? "";
  return first.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

/** The standard character for this code point in this font, or null. */
export function standardBullet(codePoint: number, fontFamily: string): string | null {
  const table = SYMBOL_FONT_BULLETS[primaryFont(fontFamily)];
  return table?.[codePoint] ?? null;
}

/**
 * True when something on the page is actually styled by this rule.
 *
 * A Word file carries the whole list-definition set its template shipped with,
 * used or not, and docx-preview writes a rule for every one. Rewriting a
 * marker nothing draws changes nothing a reader can see — and saying so on
 * screen would be a notice about nothing. Selectors are matched with the
 * pseudo-element dropped, since that is the part that has no element of
 * its own.
 */
function drawnOnPage(root: HTMLElement, selectorText: string): boolean {
  return selectorText.split(",").some((part) => {
    const base = part.trim().replace(/::?(before|after)\s*$/i, "").trim();
    if (!base) return false;
    try {
      return root.querySelector(base) !== null;
    } catch {
      return false; // a selector this browser cannot parse is not ours to fix
    }
  });
}

/** Every rule in a sheet, group rules (`@media`, `@supports`) walked into. */
function styleRules(sheet: CSSStyleSheet): CSSStyleRule[] {
  const found: CSSStyleRule[] = [];
  const stack: CSSRule[] = [...sheet.cssRules];
  while (stack.length) {
    const rule = stack.pop() as CSSRule & {
      cssRules?: CSSRuleList;
      style?: CSSStyleDeclaration;
      selectorText?: string;
    };
    if (rule.cssRules?.length) {
      stack.push(...rule.cssRules);
      continue;
    }
    if (rule.style && rule.selectorText) found.push(rule as CSSStyleRule);
  }
  return found;
}

/**
 * Rewrite private-area bullets in a rendered document's own stylesheets.
 *
 * List markers are drawn by generated `::before` rules, not by text in the
 * page, so this is where the swap has to happen — walking the DOM would find
 * nothing. Each rule carries the font the file named alongside the character
 * it asked for, which is what makes reading the code point safe at all.
 *
 * Returns what was swapped, so the reader can be told where the screen and
 * the file differ. Rules without a `font-family` are left alone — without the
 * font the code point cannot be read — and so are rules nothing on the page
 * is drawn by.
 */
export function restoreSymbolBullets(root: HTMLElement): BulletSwap[] {
  const swaps: BulletSwap[] = [];
  for (const style of Array.from(root.querySelectorAll("style"))) {
    let rules: CSSStyleRule[];
    try {
      rules = style.sheet ? styleRules(style.sheet) : [];
    } catch {
      continue; // a sheet the browser will not let us read is not ours to fix
    }
    for (const rule of rules) {
      const content = rule.style.getPropertyValue("content");
      if (!content) continue;
      const font = rule.style.getPropertyValue("font-family");
      if (!font) continue;
      if (!drawnOnPage(root, rule.selectorText)) continue;
      let next = "";
      let changed = false;
      for (const character of content) {
        const code = character.codePointAt(0) ?? 0;
        const standard = isPrivateUse(code) ? standardBullet(code, font) : null;
        if (standard === null) {
          next += character;
          continue;
        }
        next += standard;
        changed = true;
        swaps.push({ from: character, to: standard, font: primaryFont(font) });
      }
      if (changed) rule.style.setProperty("content", next);
    }
  }
  return swaps;
}

/** The fonts whose marks were redrawn, in the order first seen. */
export function redrawnFonts(swaps: BulletSwap[]): string[] {
  return [...new Set(swaps.map((swap) => swap.font))];
}
