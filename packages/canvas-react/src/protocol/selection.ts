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
}
