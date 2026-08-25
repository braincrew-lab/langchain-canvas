/**
 * Word-preview addressing — the screen and the agent point at the same paragraph.
 *
 * The document tools address a `.docx` by position: `[p12]` is the thirteenth
 * `w:p` child of the document body, blanks counted, and `[t3]` the fourth
 * body-level table. The preview has to agree with that exactly. If the screen
 * calls a paragraph `p12` and the tools call a different one `p12`, a person
 * points at one sentence and the agent rewrites another — wrong in a way
 * nobody sees until the file comes back changed in the wrong place.
 *
 * So the rule lives here, in one place, stated the same way the reader states
 * it: walk each rendered page's body in order, count `<p>` and `<table>`, skip
 * everything else. Headers and footers are deliberately not addressed — the
 * preview repeats them on every page it draws, so their position on screen
 * says nothing about their position in the file.
 *
 * Pure DOM functions, no React: the parity test runs them over a real
 * rendered document and checks every paragraph, not a sample.
 */

/** Which counter an address belongs to. */
export type DocxBlockKind = "paragraph" | "table";

/** One addressed block of a rendered document. */
export interface DocxBlock {
  kind: DocxBlockKind;
  /** Position among blocks of its kind — the number in `p12` / `t3`. */
  index: number;
  /** The address as the reader and the tools both write it. */
  address: string;
  element: HTMLElement;
}

/** What a click or a text selection resolved to. */
export interface DocxPick {
  /** `p12` / `t3` — hand this to the agent as the place. */
  address: string;
  kind: DocxBlockKind;
  /** Chip text: the address, or the exact words when the user selected some. */
  label: string;
  /** The block's own text, for context. */
  text: string;
  /** The exact substring the user selected, when they selected one. */
  literal?: string;
}

/** Counts the status bar can state honestly. */
export interface DocxStats {
  words: number;
  /** Page areas the preview drew. Not a page count — see `paginates`. */
  pagesDrawn: number;
  /**
   * False always, today: the preview splits pages where the document says to,
   * and does not reflow text into pages of its own. A page number derived from
   * what it drew would be a guess, so nothing here reports one.
   */
  paginates: false;
  /** Fonts the document asks for that this machine does not have. */
  substitutedFonts: string[];
}

export const DOCX_ADDRESS_ATTRIBUTE = "data-canvas-docx";

const BODY_SELECTOR = "section.docx";

function bodyOf(section: Element): Element {
  return section.querySelector(":scope > article") ?? section;
}

function pages(root: HTMLElement): Element[] {
  const sections = Array.from(root.querySelectorAll(BODY_SELECTOR));
  return sections.length > 0 ? sections : [root];
}

/**
 * Number every body paragraph and table, and write the address onto the node.
 *
 * Returns the blocks in document order. Call it after each render — the
 * attribute is what a click reads back.
 */
export function stampDocxAddresses(root: HTMLElement): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  let paragraphs = 0;
  let tables = 0;
  for (const page of pages(root)) {
    for (const element of Array.from(bodyOf(page).children)) {
      const tag = element.tagName.toLowerCase();
      if (tag !== "p" && tag !== "table") continue;
      const kind: DocxBlockKind = tag === "table" ? "table" : "paragraph";
      const index = kind === "table" ? tables++ : paragraphs++;
      const address = `${kind === "table" ? "t" : "p"}${index}`;
      (element as HTMLElement).setAttribute(DOCX_ADDRESS_ATTRIBUTE, address);
      blocks.push({ kind, index, address, element: element as HTMLElement });
    }
  }
  return blocks;
}

function addressedAncestor(
  root: HTMLElement,
  node: Node | null,
): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (
      current instanceof Element &&
      current.hasAttribute(DOCX_ADDRESS_ATTRIBUTE)
    ) {
      return current as HTMLElement;
    }
    current = current.parentNode;
  }
  return null;
}

function pickOf(element: HTMLElement, literal?: string): DocxPick {
  const address = element.getAttribute(DOCX_ADDRESS_ATTRIBUTE) ?? "";
  const kind: DocxBlockKind = address.startsWith("t") ? "table" : "paragraph";
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return {
    address,
    kind,
    label: literal ? `“${literal}”` : `[${address}]`,
    text,
    ...(literal ? { literal } : {}),
  };
}

/** The block a click landed in, or null outside the addressed body. */
export function pickFromNode(
  root: HTMLElement,
  node: Node | null,
): DocxPick | null {
  const element = addressedAncestor(root, node);
  return element ? pickOf(element) : null;
}

/**
 * The block a text selection sits in, carrying the exact words selected.
 *
 * A selection spanning several paragraphs resolves to the one it starts in —
 * the anchor the agent gets has to name a single place, and the first is the
 * one the user reached for.
 */
export function pickFromSelection(
  root: HTMLElement,
  selection: Selection | null,
): DocxPick | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0)
    return null;
  const literal = selection.toString().replace(/\s+/g, " ").trim();
  if (!literal) return null;
  const element = addressedAncestor(
    root,
    selection.getRangeAt(0).startContainer,
  );
  return element ? pickOf(element, literal) : null;
}

const CJK = /[ㄱ-ㆎ가-힣぀-ヿ一-鿿]/gu;
const LATIN_WORD = /[A-Za-z0-9][A-Za-z0-9'’-]*/gu;

/**
 * Word count the way word processors do it: a run of Latin letters is one
 * word, and each CJK character is one. Splitting on spaces alone would report
 * a Korean paragraph as a single word.
 */
export function countWords(text: string): number {
  return (text.match(LATIN_WORD)?.length ?? 0) + (text.match(CJK)?.length ?? 0);
}

/**
 * Shrink the drawn page to the width it has to live in, and return the scale.
 *
 * The renderer draws at the document's real page width — 816px for Letter —
 * and a canvas panel is often narrower than that, so without this the page is
 * cut off and read through a horizontal scrollbar. `zoom` rather than a
 * transform because it changes layout: the container's height follows, and
 * the browser hit-tests clicks against the scaled boxes, so an address still
 * resolves from whatever the user pressed. Never enlarges — a short page
 * blown up to fill the panel is worse than one at its own size.
 */
export function fitToWidth(root: HTMLElement, available: number): number {
  const wrapper = root.querySelector<HTMLElement>(".docx-wrapper");
  const page = root.querySelector<HTMLElement>(BODY_SELECTOR);
  if (!wrapper || !page || available <= 0) return 1;
  wrapper.style.zoom = "";
  // scrollWidth, not the wrapper's own box: the wrapper is a block that takes
  // the container's width while the page inside it overflows.
  const width = Math.max(root.scrollWidth, page.getBoundingClientRect().width);
  if (width <= 0) return 1;
  const scale = Math.min(1, available / width);
  wrapper.style.zoom = scale < 1 ? String(scale) : "";
  return scale;
}

/**
 * Every font family the rendered document asks for.
 *
 * The renderer puts the document's fonts in the stylesheet it generates, not
 * on the elements, so reading `element.style` alone finds nothing at all —
 * both places are scanned. CSS variables and the generic families are not
 * fonts a machine can be missing, so they are dropped here.
 */
export function declaredFontFamilies(root: HTMLElement): string[] {
  const declarations: string[] = [];
  for (const sheet of Array.from(root.querySelectorAll("style"))) {
    for (const match of (sheet.textContent ?? "").matchAll(
      /font-family:\s*([^;}]+)/g,
    )) {
      declarations.push(match[1]);
    }
  }
  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>("[style]"),
  )) {
    if (element.style?.fontFamily) declarations.push(element.style.fontFamily);
  }
  const families = new Set<string>();
  for (const declaration of declarations) {
    for (const part of declaration.split(",")) {
      const family = part.trim().replace(/^['"]|['"]$/g, "");
      if (!family || family.startsWith("var(")) continue;
      if (
        /^(serif|sans-serif|monospace|cursive|fantasy|inherit|initial|unset)$/i.test(
          family,
        )
      )
        continue;
      families.add(family);
    }
  }
  return Array.from(families).sort();
}

/**
 * Of those, the ones this machine cannot draw — so the status line can say the
 * page is not quite the document.
 *
 * Measured, not asked: a missing family silently falls back, and
 * `document.fonts.check` reports system families as present whether they are
 * or not. Rendering the same string in the family and in a control face and
 * comparing widths is the only answer that matches what the user sees. An
 * environment without a 2D canvas gets an empty list rather than a guess.
 */
export function substitutedFonts(root: HTMLElement): string[] {
  const families = declaredFontFamilies(root);
  if (families.length === 0) return [];
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement("canvas").getContext("2d");
  } catch {
    return [];
  }
  if (!context) return [];
  const measured = context;
  const probe = "가나다 Handgloves 0123";
  const width = (font: string) => {
    measured.font = `24px ${font}`;
    return measured.measureText(probe).width;
  };
  const control = width("monospace");
  return families.filter(
    (family) => width(`"${family}", monospace`) === control,
  );
}

/** What the status bar states — every number measured from what was drawn. */
export function docxStats(root: HTMLElement): DocxStats {
  const bodies = pages(root).map((page) => bodyOf(page).textContent ?? "");
  return {
    words: countWords(bodies.join(" ")),
    pagesDrawn: root.querySelectorAll(BODY_SELECTOR).length,
    paginates: false,
    substitutedFonts: substitutedFonts(root),
  };
}
