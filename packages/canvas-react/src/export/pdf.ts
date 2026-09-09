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

/** How much wider than its box a one-line text may run before fitting gives
 *  up and lets it wrap — the print twin of the renderer's snug fit. */
const SNUG_MAX_OVERFLOW = 1.22;

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
export function preparePrintFrame(html: string): Promise<HTMLIFrameElement> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
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
        resolve(iframe);
      });
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}

export function printToPdf(html: string): void {
  void preparePrintFrame(html)
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
