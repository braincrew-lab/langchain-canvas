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
 *
 * `slideId`/`nodeId` are set for deck artifacts, where the durable edit
 * address is `(deckId, slideId, nodeId)` — `cid` stays screen-only.
 */
export interface CanvasNodePatch {
  type: "canvas.node_patch";
  id: string;
  cid: string;
  html: string;
  slideId?: string;
  nodeId?: string;
}

/**
 * Report one slide's pipeline stage during deck conversion (extract ->
 * generate -> verify), so the client can show progress and let completed
 * slides be edited without waiting on the rest of the deck.
 */
export interface SlideStatus {
  type: "canvas.slide_status";
  id: string;
  slideId: string;
  stage: "extracting" | "generating" | "verifying" | "complete" | "degraded";
  detail?: string;
}

/**
 * Replace one slide's template HTML in a deck artifact — transmits a single
 * slide over the wire instead of resending the whole deck through
 * `canvas.patch`.
 */
export interface CanvasSlidePatch {
  type: "canvas.slide_patch";
  id: string;
  slideId: string;
  templateHtml: string;
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

/**
 * Promote the artifact's current state to a described version snapshot.
 * `revision` is the opaque store revision when a CanvasStore backs the canvas.
 */
export interface CanvasCommit {
  type: "canvas.commit";
  id: string;
  description: string;
  revision?: string;
  /** Set when this commit continues the version already on the rail: the
   *  entry is replaced rather than joined, so a burst of small saves reads
   *  as one work unit. */
  amends?: string;
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
  | SlideStatus
  | CanvasSlidePatch
  | CanvasReplace
  | CanvasStatus
  | CanvasCommit;

export type StreamEvent = ChatEvent | CanvasEvent | ErrorEvent | DoneEvent;

/** Narrow a `StreamEvent` to the canvas family. */
export function isCanvasEvent(event: StreamEvent): event is CanvasEvent {
  return event.type.startsWith("canvas.");
}

/** Narrow a `StreamEvent` to the chat family. */
export function isChatEvent(event: StreamEvent): event is ChatEvent {
  return event.type.startsWith("message.") || event.type.startsWith("tool.");
}
