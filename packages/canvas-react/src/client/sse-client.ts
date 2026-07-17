/**
 * SSE client — POST a chat message and yield parsed `StreamEvent`s.
 *
 * We use `fetch` + `ReadableStream` rather than the browser `EventSource`
 * because the chat endpoint is a POST (EventSource is GET-only) and we want an
 * `AbortSignal` for cancellation. Frames are separated by a blank line; each
 * `data:` payload is one JSON `StreamEvent`.
 */

import type { StreamEvent } from "../protocol/events";
import type { ElementSelection } from "../protocol/selection";

export interface ChatRequest {
  threadId: string;
  message: string;
  /** Element context for a targeted edit (set when editing selected elements). */
  selections?: ElementSelection[];
}

export interface StreamOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Open the chat stream and yield events until the server sends `done`. */
export async function* streamChat(
  endpoint: string,
  request: ChatRequest,
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({
      thread_id: request.threadId,
      message: request.message,
      selections: request.selections ?? [],
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`chat stream failed: ${response.status} ${response.statusText}`);
  }

  yield* parseSSE(response.body, options.signal);
}

/** Turn a byte stream of SSE frames into a stream of typed events. */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) {
          yield event;
          if (event.type === "done") return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Extract and JSON-parse the `data:` payload from one SSE frame. */
function parseFrame(frame: string): StreamEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data) return null;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null; // ignore malformed frames rather than tearing down the stream
  }
}
