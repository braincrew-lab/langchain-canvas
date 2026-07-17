/**
 * Schema-driven playback — render the canvas from a scripted list of wire
 * events, with no backend, no LLM, and no API key.
 *
 * The canvas is defined entirely by the wire protocol (`StreamEvent`s). That
 * means you can develop and demo the UI purely against the schema: hand it a
 * fixture and watch it render exactly as a real LangGraph agent would drive it.
 * `mockStream` turns an event array into a timed async stream, shaped identically
 * to `streamChat`, so anything that consumes one consumes the other.
 */

import type { StreamEvent } from "../protocol/events";

export interface MockStreamOptions {
  /** Delay between events, ms. Simulates streaming cadence. Default 120. */
  delayMs?: number;
  signal?: AbortSignal;
}

/** Yield a fixed list of events over time — a drop-in for `streamChat`. */
export async function* mockStream(
  events: StreamEvent[],
  options: MockStreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const { delayMs = 120, signal } = options;
  for (const event of events) {
    if (signal?.aborted) return;
    yield event;
    if (delayMs > 0) await sleep(delayMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
