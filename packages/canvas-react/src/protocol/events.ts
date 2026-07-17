/**
 * Canvas Wire Protocol v1 — event envelopes. Mirror of
 * `langchain_canvas/protocol/events.py`. Every SSE frame is one `StreamEvent`,
 * discriminated by `type`. See `docs/02-protocol.md` for the specification.
 */

import type { Artifact, ArtifactStatus } from "./artifacts";

// --- chat family (drives the transcript) ---------------------------------------

export interface MessageDelta {
  type: "message.delta";
  messageId: string;
  text: string;
}

export interface MessageEnd {
  type: "message.end";
  messageId: string;
}

export interface ToolStart {
  type: "tool.start";
  toolCallId: string;
  name: string;
}

export interface ToolEnd {
  type: "tool.end";
  toolCallId: string;
  ok: boolean;
}

// --- canvas family (drives the panel) ------------------------------------------

export interface CanvasCreate {
  type: "canvas.create";
  artifact: Artifact;
}

/** Append `text` to the string at `data.<path>` (e.g. a document body). */
export interface CanvasAppend {
  type: "canvas.append";
  id: string;
  path: string;
  text: string;
}

/** JSON-merge-patch (RFC 7386) `patch` into the artifact's `data`. */
export interface CanvasPatch {
  type: "canvas.patch";
  id: string;
  patch: Record<string, unknown>;
}

/**
 * Replace a single element (by its `data-cid` tree path) inside an `html`
 * artifact with new outer HTML — an O(1) surgical edit that avoids resending the
 * whole page. The reconciler resolves the `cid` path against the source HTML.
 */
export interface CanvasNodePatch {
  type: "canvas.node_patch";
  id: string;
  cid: string;
  html: string;
}

/** Replace wholesale — the reconciler snapshots a new version. */
export interface CanvasReplace {
  type: "canvas.replace";
  id: string;
  artifact: Artifact;
}

export interface CanvasStatus {
  type: "canvas.status";
  id: string;
  status: ArtifactStatus;
}

export interface CanvasClose {
  type: "canvas.close";
  id: string;
}

// --- control family ------------------------------------------------------------

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface DoneEvent {
  type: "done";
}

// --- unions --------------------------------------------------------------------

export type ChatEvent = MessageDelta | MessageEnd | ToolStart | ToolEnd;

export type CanvasEvent =
  | CanvasCreate
  | CanvasAppend
  | CanvasPatch
  | CanvasNodePatch
  | CanvasReplace
  | CanvasStatus
  | CanvasClose;

export type StreamEvent = ChatEvent | CanvasEvent | ErrorEvent | DoneEvent;

/** Narrow a `StreamEvent` to the canvas family. */
export function isCanvasEvent(event: StreamEvent): event is CanvasEvent {
  return event.type.startsWith("canvas.");
}

/** Narrow a `StreamEvent` to the chat family. */
export function isChatEvent(event: StreamEvent): event is ChatEvent {
  return event.type.startsWith("message.") || event.type.startsWith("tool.");
}
