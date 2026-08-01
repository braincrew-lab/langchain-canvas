/**
 * The transport socket contract: sse / mock are interchangeable implementations,
 * and the mock falls through to its wrapped transport when the script passes.
 */

import { describe, expect, it } from "vitest";

import type { StreamEvent } from "../protocol/events";
import { mockTransport } from "./mock";
import type { CanvasTransport, TransportRequest } from "./types";

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const request: TransportRequest = { threadId: "t1", message: "hello" };

describe("mockTransport", () => {
  it("plays the scripted events for a matching message", async () => {
    const script = (msg: string): StreamEvent[] | null =>
      msg === "hello"
        ? [{ type: "message.delta", messageId: "m1", text: "hi" }, { type: "done" }]
        : null;
    const events = await collect(mockTransport(script, undefined, { delayMs: 0 }).stream(request));
    expect(events.map((e) => e.type)).toEqual(["message.delta", "done"]);
  });

  it("falls through to the wrapped transport when the script returns null", async () => {
    const fallback: CanvasTransport = {
      // eslint-disable-next-line require-yield
      async *stream(req) {
        yield { type: "message.delta", messageId: "m1", text: `live:${req.message}` };
      },
    };
    const events = await collect(
      mockTransport(() => null, fallback, { delayMs: 0 }).stream(request),
    );
    expect(events).toEqual([{ type: "message.delta", messageId: "m1", text: "live:hello" }]);
  });

  it("yields nothing when the script misses and there is no fallback", async () => {
    const events = await collect(mockTransport(() => null, undefined, { delayMs: 0 }).stream(request));
    expect(events).toEqual([]);
  });
});
