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
function fitSnugLines(doc: Document): void {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  doc.querySelectorAll<HTMLElement>("[data-snug]").forEach((node) => {
    const computed = doc.defaultView?.getComputedStyle(node);
    if (!computed) return;
    context.font = `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
    const needed = context.measureText(node.textContent ?? "").width;
    const box = node.clientWidth;
    if (box > 0 && needed > box && needed <= box * SNUG_MAX_OVERFLOW) {
      node.style.whiteSpace = "nowrap";
      node.style.fontSize = `${parseFloat(computed.fontSize) * (box / needed)}px`;
    }
  });
}

export function printToPdf(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });

  const cleanup = () => setTimeout(() => iframe.remove(), 1000);
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      iframe.remove();
      return;
    }
    win.addEventListener("afterprint", cleanup);
    // A beat to lay out fonts/images before printing.
    setTimeout(() => {
      try {
        fitSnugLines(win.document);
        win.focus();
        win.print();
      } catch {
        iframe.remove();
      }
    }, 200);
  };
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
}
