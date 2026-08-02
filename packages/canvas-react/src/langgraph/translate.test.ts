/**
 * The LangGraph translation, pinned on real captured chunks.
 *
 * `__fixtures__/langgraph-run.json` is the verbatim chunk list from a real
 * `langgraph dev` run (deepagents agent + standard canvas tools, one
 * `write_canvas` call) streamed through `@langchain/langgraph-sdk`. Pinning
 * the translation to it means "the shape LangGraph actually sends", not "the
 * shape we remember it sending".
 */

import { describe, expect, it } from "vitest";

import type { StreamEvent } from "../protocol/events";
import fixture from "./__fixtures__/langgraph-run.json";
import { chunkText, translateLangGraphStream, type LangGraphStreamChunk } from "./translate";

async function collect(chunks: LangGraphStreamChunk[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of translateLangGraphStream(chunks, { messageId: "m1" })) out.push(event);
  return out;
}

describe("translateLangGraphStream on the captured run", () => {
  it("produces the full wire sequence for a one-tool run", async () => {
    const events = await collect(fixture as LangGraphStreamChunk[]);
    const kinds = events.map((e) => e.type);

    // One tool call: started exactly once, ended once, ok.
    expect(kinds.filter((k) => k === "tool.start")).toHaveLength(1);
    expect(events.find((e) => e.type === "tool.start")).toMatchObject({ name: "write_canvas" });
    expect(events.find((e) => e.type === "tool.end")).toMatchObject({ ok: true });

    // The standard tools' live broadcast passes through untouched, in order.
    const canvas = kinds.filter((k) => k.startsWith("canvas."));
    expect(canvas).toEqual(["canvas.create", "canvas.status", "canvas.commit"]);
    expect(events.find((e) => e.type === "canvas.commit")).toMatchObject({ revision: "v1" });

    // Assistant text arrives as deltas (block-array content), then the close.
    const text = events.filter((e) => e.type === "message.delta").map((e) => e.text).join("");
    expect(text).toBe("Done.");
    expect(kinds.slice(-2)).toEqual(["message.end", "done"]);
  });

  it("starts the tool before its canvas events arrive", async () => {
    const kinds = (await collect(fixture as LangGraphStreamChunk[])).map((e) => e.type);
    expect(kinds.indexOf("tool.start")).toBeLessThan(kinds.indexOf("canvas.create"));
    expect(kinds.indexOf("canvas.commit")).toBeLessThan(kinds.indexOf("tool.end"));
  });
});

describe("edge shapes", () => {
  it("relays run errors instead of swallowing them", async () => {
    const events = await collect([{ event: "error", data: { message: "boom" } }]);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain("boom");
  });

  it("ignores non-canvas custom events and unknown message shapes", async () => {
    const events = await collect([
      { event: "custom", data: { type: "app.metric", value: 1 } },
      { event: "messages", data: [{ type: "SomethingNew" }] },
      { event: "values", data: {} },
    ]);
    expect(events.map((e) => e.type)).toEqual(["message.end", "done"]);
  });

  it("chunkText reads plain strings and block arrays", () => {
    expect(chunkText("hi")).toBe("hi");
    expect(chunkText([{ type: "text", text: "a" }, { type: "tool_use", input: "x" }, { type: "text", text: "b" }])).toBe("ab");
    expect(chunkText(undefined)).toBe("");
  });
});


describe("tools-node suppression", () => {
  it("drops text from model calls running inside tools", async () => {
    const events = await collect([
      { event: "messages", data: [{ type: "AIMessageChunk", content: "Hi" }, { langgraph_node: "model" }] },
      { event: "messages", data: [{ type: "AIMessageChunk", content: "<html>leak</html>" }, { langgraph_node: "tools" }] },
      { event: "messages", data: [{ type: "tool", tool_call_id: "t1", status: "success" }, { langgraph_node: "tools" }] },
    ]);
    const deltas = events.filter((e) => e.type === "message.delta").map((e) => e.text);
    expect(deltas).toEqual(["Hi"]);
    // Tool results still close the tool lifecycle.
    expect(events.find((e) => e.type === "tool.end")).toMatchObject({ toolCallId: "t1", ok: true });
  });
});
