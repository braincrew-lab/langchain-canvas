/**
 * `mockTransport` — scripted offline playback as a socket implementation.
 *
 * Wraps the `mockStream` player in the `CanvasTransport` contract: the script
 * maps a user message to the `StreamEvent[]` to play. Returning `null` falls
 * through to the wrapped transport (a live backend), which is how the demo
 * mixes canned examples with real chat.
 */

import { mockStream, type MockStreamOptions } from "../client/mock";
import type { StreamEvent } from "../protocol/events";
import type { CanvasTransport, TransportRequest } from "./types";

export type MockScript = (message: string) => StreamEvent[] | null;

export function mockTransport(
  script: MockScript,
  fallback?: CanvasTransport,
  options: Pick<MockStreamOptions, "delayMs"> = {},
): CanvasTransport {
  return {
    stream(request: TransportRequest) {
      const events = script(request.message);
      if (events) {
        return mockStream(events, { delayMs: options.delayMs ?? 60, signal: request.signal });
      }
      if (fallback) return fallback.stream(request);
      return mockStream([], { delayMs: 0 });
    },
  };
}
