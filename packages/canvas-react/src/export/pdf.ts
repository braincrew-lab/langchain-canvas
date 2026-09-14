/**
 * PDF export via the browser's own print pipeline — zero dependencies, and the
 * output is pixel-faithful to what the canvas renders (the browser is the best
 * HTML→PDF engine there is).
 *
 * We write the standalone HTML into an offscreen iframe and trigger `print()`
 * on it; the user picks "Save as PDF" in the print dialog. Using an iframe (not
 * a popup) avoids popup blockers and never navigates the host page away.
 */

/**
 * Print an HTML document to PDF through an offscreen iframe.
 *
 * Security: the export HTML may be untrusted (LLM-generated or imported), so the
 * frame is **sandboxed without `allow-scripts`** — scripts, `onerror`, `onload`,
 * etc. never execute, so nothing can run in the host origin. `allow-same-origin`
 * (safe here precisely because scripts are disabled) lets us call `print()` on
 * the frame; `allow-modals` permits the print dialog. `srcdoc` is used instead of
 * `document.write` so the content is parsed inertly.
 */
import { snugLineWidth } from "../client/slideText";
import { PRINT_KEEP_ATTR } from "./exporters";

/** How much wider than its box a one-line text may run before fitting gives
 *  up and lets it wrap — the print twin of the renderer's snug fit. */
const SNUG_MAX_OVERFLOW = 1.22;

/** A printed page at 96 dpi, taken from the smaller of the two common papers
 *  on each side: US Letter's height (11 in) and A4's width (210 mm). A box
 *  measured at the narrower width is never shorter than it prints, and one
 *  under the shorter height fits a page of either paper. */
const PRINT_PAGE_WIDTH_PX = 794;
const PRINT_PAGE_HEIGHT_PX = 1056;

/** Display values of a box that a page break could cut through. */
const BOX_DISPLAYS = new Set(["block", "flex", "grid", "list-item", "table", "flow-root"]);

/** Whether a computed style draws a box: a block with a fill, a border or a shadow. */
function drawsBox(computed: CSSStyleDeclaration): boolean {
  if (!BOX_DISPLAYS.has(computed.display)) return false;
  const color = computed.backgroundColor;
  const clear = !color || color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);
  const filled = !clear || (!!computed.backgroundImage && computed.backgroundImage !== "none");
  const bordered = (["Top", "Right", "Bottom", "Left"] as const).some(
    (side) => parseFloat(computed[`border${side}Width`]) > 0 && computed[`border${side}Style`] !== "none",
  );
  const shadowed = !!computed.boxShadow && computed.boxShadow !== "none";
  return filled || bordered || shadowed;
}

/**
 * Mark the boxes a reader sees as one card, so the print keeps each on one page.
 *
 * A box shorter than a page gets `PRINT_KEEP_ATTR`, which the web page's print
 * sheet turns into `break-inside: avoid`, unless it holds a card of its own (a
 * box a tenth of a page tall or more — a badge or a chip does not count). Such
 * a section may break between its cards, and each card stays whole: keeping
 * the whole section pushed it to a fresh page and left the page before it two
 * thirds empty. A box a page tall or taller fits no page and is left alone.
 * Runs from the host on the sandboxed frame's document.
 */
export function markWholeBoxes(doc: Document, pageHeightPx: number): void {
  const view = doc.defaultView;
  if (!view || !doc.body) return;
  const boxes: { node: HTMLElement; height: number }[] = [];
  doc.body.querySelectorAll<HTMLElement>("*").forEach((node) => {
    if (drawsBox(view.getComputedStyle(node))) boxes.push({ node, height: node.getBoundingClientRect().height });
  });
  const cardHeightPx = pageHeightPx / 10;
  for (const { node, height } of boxes) {
    if (height <= 0 || height >= pageHeightPx) continue;
    const holdsCard = boxes.some(
      (other) => other.node !== node && other.height >= cardHeightPx && node.contains(other.node),
    );
    if (!holdsCard) node.setAttribute(PRINT_KEEP_ATTR, "");
  }
}

export interface PrintFrameOptions {
  /** Lay a fluid web page out at paper width and keep each card on one page
   *  (`markWholeBoxes`). A slide sheet sets its own pages and leaves this off. */
  wholeBoxes?: boolean;
}

/**
 * Shrink marked one-line texts a hair instead of letting them wrap.
 *
 * The deck's snug labels (`data-snug`) fit their file's own font exactly;
 * the print font runs a few percent wider and folded them onto a second
 * line the original never had. This runs from the *host* (trusted code) on
 * the sandboxed frame's document — the frame itself executes no scripts,
 * which is the point of the sandbox.
 */
export function fitSnugLines(doc: Document): void {
  // The measuring canvas is the sheet's own document's: the faces a sheet
  // draws with belong to its document, and a host canvas would measure with
  // the host's faces or a fallback the frame never draws.
  const context = doc.createElement("canvas").getContext("2d");
  if (!context) return;
  doc.querySelectorAll<HTMLElement>("[data-snug]").forEach((node) => {
    const computed = doc.defaultView?.getComputedStyle(node);
    if (!computed) return;
    context.font = `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
    // A bullet one-liner is drawn as the sheet's fixed `.p-bullet__marker`
    // plus its body (`slidesToPrintHtml`), so that is what is measured — not
    // the marker glyph's own advance, which is narrower than the marker and
    // left the drawn line wider than the box.
    const marker = node.querySelector<HTMLElement>(".p-bullet__marker");
    const paragraph = marker
      ? { bullet: true, text: (marker.parentElement?.textContent ?? "").slice((marker.textContent ?? "").length) }
      : { bullet: false, text: node.textContent ?? "" };
    const needed = snugLineWidth(paragraph, parseFloat(computed.fontSize), (piece) => context.measureText(piece).width);
    // The box's used width, fractional: `clientWidth` rounds to whole px, and
    // a fit computed on a rounded-up width draws up to half a pixel past the box.
    const used = parseFloat(computed.width);
    const box = Number.isFinite(used) && used > 0 ? used : node.clientWidth;
    if (box > 0 && needed > box && needed <= box * SNUG_MAX_OVERFLOW) {
      node.style.whiteSpace = "nowrap";
      node.style.fontSize = `${parseFloat(computed.fontSize) * (box / needed)}px`;
    }
  });
}

/**
 * Build the sandboxed print frame for `html` and get it ready to print: the
 * frame is appended, its sheet loads, the sheet's own faces finish loading
 * (`document.fonts.ready` of the FRAME, after a forced layout so the faces
 * the sheet uses have been asked for), and the snug one-liners are fitted
 * with the frame's canvas. A fixed beat used to stand in for the font wait
 * and fitted a sheet whose face had not arrived with a fallback's advances.
 * Resolves with the frame once that is done — `printToPdf` prints it; the
 * print gate measures it. Rejects when the frame yields no window.
 */
export function preparePrintFrame(html: string, options: PrintFrameOptions = {}): Promise<HTMLIFrameElement> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  if (options.wholeBoxes) {
    // Measured boxes need the page laid out at paper width, off screen: a
    // zero-size frame wraps every card into a column of single words.
    Object.assign(iframe.style, {
      right: "auto",
      bottom: "auto",
      left: "-10000px",
      top: "0",
      width: `${PRINT_PAGE_WIDTH_PX}px`,
      height: `${PRINT_PAGE_HEIGHT_PX}px`,
    });
  }
  return new Promise((resolve, reject) => {
    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) {
        iframe.remove();
        reject(new Error("the print frame has no window"));
        return;
      }
      const sheet = win.document;
      void sheet.body?.offsetHeight; // lay the sheet out so its faces start loading
      void sheet.fonts.ready.then(() => {
        fitSnugLines(sheet);
        if (options.wholeBoxes) markWholeBoxes(sheet, PRINT_PAGE_HEIGHT_PX);
        resolve(iframe);
      });
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}

export function printToPdf(html: string, options: PrintFrameOptions = {}): void {
  void preparePrintFrame(html, options)
    .then((iframe) => {
      const win = iframe.contentWindow;
      if (!win) {
        iframe.remove();
        return;
      }
      win.addEventListener("afterprint", () => setTimeout(() => iframe.remove(), 1000));
      try {
        win.focus();
        win.print();
      } catch {
        iframe.remove();
      }
    })
    .catch(() => undefined);
}
