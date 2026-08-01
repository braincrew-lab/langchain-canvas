/**
 * `CanvasTransport` — the socket between the canvas UI and an agent backend.
 *
 * The whole contract is one promise: *given a user message, return the stream
 * of `StreamEvent`s the canvas should apply.* Everything downstream of the
 * socket (event batching, reconcile, rendering, error display) is
 * transport-agnostic, so swapping how the app talks to its backend never
 * touches a component.
 *
 * First-party implementations: `sseTransport` (the reference Canvas Wire
 * Protocol over SSE — the default), `mockTransport` (scripted offline
 * streams), and `langgraphTransport` (a LangGraph server, from the
 * `/langgraph` entry point). An app with its own backend implements this
 * interface instead of forking the hook.
 */

import type { StreamEvent } from "../protocol/events";
import type { ElementSelection } from "../protocol/selection";

/** One user turn, as handed to the transport by `useCanvasStream`. */
export interface TransportRequest {
  /** Conversation thread id (server-side memory / canvas scope). */
  threadId: string;
  /** The user's message. */
  message: string;
  /** Element context for a targeted edit (set when editing selected elements). */
  selections?: ElementSelection[];
  /** Aborted when the user hits stop or the component unmounts. */
  signal?: AbortSignal;
}

export interface CanvasTransport {
  /** Open the stream for one user turn and yield events until it ends. */
  stream(request: TransportRequest): AsyncIterable<StreamEvent>;
}
