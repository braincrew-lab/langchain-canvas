/**
 * `sseTransport` — the default socket: the Canvas Wire Protocol over SSE.
 *
 * Speaks to a reference-style server (`POST endpoint` with
 * `{thread_id, message, selections}`, answered by an SSE stream of
 * `StreamEvent` frames). This is exactly what `useCanvasStream` always did;
 * it is now one `CanvasTransport` implementation among several.
 */

import { streamChat, type StreamOptions } from "../client/sse-client";
import type { CanvasTransport, TransportRequest } from "./types";

export interface SseTransportOptions {
  /** Chat SSE endpoint. Defaults to `/api/chat`. */
  endpoint?: string;
  /** Extra request headers (e.g. auth). */
  headers?: Record<string, string>;
}

export function sseTransport(options: SseTransportOptions = {}): CanvasTransport {
  const endpoint = options.endpoint ?? "/api/chat";
  return {
    stream(request: TransportRequest) {
      const streamOptions: StreamOptions = { signal: request.signal, headers: options.headers };
      return streamChat(
        endpoint,
        { threadId: request.threadId, message: request.message, selections: request.selections },
        streamOptions,
      );
    },
  };
}
