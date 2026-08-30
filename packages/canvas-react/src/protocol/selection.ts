/**
 * Element selection — a client→server concern (it rides the chat request, not
 * the SSE wire). When the user clicks an element inside an `html` artifact, the
 * inspector reports which element was chosen; an edit instruction then carries
 * this context so the agent can make a targeted change.
 */

export interface ElementSelection {
  /** The `html` artifact the element belongs to. */
  artifactId: string;
  /** Deterministic path id assigned by the inspector (e.g. "e-0-2"). */
  cid: string;
  /** Human/agent-readable selector, e.g. "button.cta". */
  selector: string;
  /** Lowercased tag name. */
  tag: string;
  /** Short text preview of the element. */
  text?: string;
  /** The element's current outer HTML (truncated) — edit context for the agent. */
  outerHtml?: string;
  /** Snapshot of the element's key computed styles (for the style panel). */
  styles?: Record<string, string>;
  /** True when the element is a group wrapper (offers "Ungroup"). */
  isGroup?: boolean;
  /** The element's `data-node-id`, when addressable independently of `cid`
   *  (deck artifacts, or content authored with node ids). */
  nodeId?: string;
  /** The deck slide the element belongs to, when the artifact is a deck. */
  slideId?: string;
}

/**
 * File suffixes whose selections address a document, not a DOM element.
 *
 * The twin of `DOCUMENT_OP_SUFFIXES` in `langchain_canvas.document_ops`; the
 * protocol parity test compares the two, so a format the tools learn to edit
 * cannot quietly keep the wrong framing here.
 */
export const DOCUMENT_FILE_SUFFIXES = [".docx"] as const;

/** True when this selection points into a document file rather than a page. */
export function isDocumentSelection(selection: ElementSelection): boolean {
  const id = selection.artifactId.toLowerCase();
  return DOCUMENT_FILE_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

/**
 * Frame a targeted edit so the agent changes only what the user pointed at.
 *
 * The two kinds of canvas artifact are addressed in different languages and
 * have different tools, so one framing cannot serve both. A document is
 * addressed by position for *reading* only — `[p12]` moves the moment a
 * paragraph is inserted — so the instruction hands over the words at that place
 * and says to use them as the anchor. A page is edited by matching its markup,
 * so the instruction hands over the element's markup as the *file* has it.
 *
 * Both halves are about naming something the agent can actually find. The
 * screen's own pointing attributes (`data-cid` and friends) are stripped before
 * the source is stored, so an instruction that names one sends the agent
 * looking through the file for something that was never written there — and a
 * careful agent then refuses the edit rather than guessing.
 */
export function withSelections(message: string, selections: ElementSelection[]): string {
  if (selections.length === 0) return message;
  const artifactId = selections[0].artifactId;
  if (selections.every(isDocumentSelection)) {
    const listed = selections
      .map((s) => `- [${s.cid}]${s.text ? `: “${s.text}”` : ""}`)
      .join("\n");
    return (
      `${message}\n\n` +
      `[Targeted edit] The user pointed at this place in \`${artifactId}\`:\n${listed}\n` +
      `First call read_canvas on the file for its current revision and the same ` +
      `addresses, then change that place with edit_canvas (or ` +
      `insert_document_paragraph / remove_document_paragraph / ` +
      `replace_document_image). Those take a text anchor, not the address — ` +
      `copy it from the read_canvas output, because the numbers move as soon as ` +
      `a paragraph is added or removed.`
    );
  }
  const listed = selections
    .map((s) => {
      const shown = s.text ? ` — “${s.text}”` : "";
      return s.outerHtml
        ? `- \`${s.selector}\`${shown}\n  ${s.outerHtml}`
        : `- \`${s.selector}\`${shown}`;
    })
    .join("\n");
  return (
    `${message}\n\n` +
    `[Targeted edit] Apply the change to these selected element(s) in file ` +
    `\`${artifactId}\`:\n${listed}\n` +
    `First call read_canvas on the file for its current content and revision, ` +
    `then call edit_canvas with that element's exact markup from the file as ` +
    `\`old\` and your replacement as \`new\`. The markup listed above is the ` +
    `file's own; the screen adds attributes of its own for pointing, which are ` +
    `never stored, so do not look for them and do not add them.`
  );
}
