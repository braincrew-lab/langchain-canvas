/**
 * Translate a LangGraph run stream into Canvas Wire Protocol events.
 *
 * Input: the `{event, data}` chunks the LangGraph SDK yields for a run
 * streamed with `streamMode: ["messages-tuple", "custom"]`. Output: the
 * `StreamEvent`s the canvas applies. The mapping:
 *
 * - `messages` AIMessageChunk text        → `message.delta`
 * - `messages` AIMessageChunk tool chunks → `tool.start` (once per call id)
 * - `messages` tool result                → `tool.end`
 * - `custom` `canvas.*`                   → passed through untouched
 * - `error`                               → `error`
 * - stream end                            → `message.end` + `done`
 *
 * The chunk shapes are pinned by a captured fixture from a real
 * `langgraph dev` run (`__fixtures__/langgraph-run.json`) — notably, model
 * content arrives as block arrays (`{type: "text" | "tool_use"}`), not plain
 * strings.
 */

import type { StreamEvent } from "../protocol/events";

/** One chunk from `client.runs.stream(...)` — the SDK's `{event, data}` pair. */
export interface LangGraphStreamChunk {
  event: string;
  data: unknown;
}

/** Text of a message chunk — models may stream content as block lists. */
export function chunkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" && block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function* translateLangGraphStream(
  chunks: AsyncIterable<LangGraphStreamChunk> | Iterable<LangGraphStreamChunk>,
  options: { messageId?: string } = {},
): AsyncGenerator<StreamEvent> {
  const messageId = options.messageId ?? `msg_${Math.random().toString(36).slice(2, 14)}`;
  const startedTools = new Set<string>();

  for await (const chunk of chunks) {
    if (chunk.event === "error") {
      const detail = typeof chunk.data === "string" ? chunk.data : JSON.stringify(chunk.data);
      yield { type: "error", message: `agent run failed: ${detail}` };
      continue;
    }
    if (chunk.event === "custom") {
      // Tools that emit wire events (the standard canvas tools) pass through.
      if (isRecord(chunk.data) && String(chunk.data.type ?? "").startsWith("canvas.")) {
        yield chunk.data as unknown as StreamEvent;
      }
      continue;
    }
    if (chunk.event !== "messages" || !Array.isArray(chunk.data) || chunk.data.length === 0) {
      continue;
    }
    const msg = chunk.data[0];
    if (!isRecord(msg)) continue;
    const meta = chunk.data.length > 1 && isRecord(chunk.data[1]) ? chunk.data[1] : {};
    // Chunks from the tools node are tool-internal (e.g. a writer model
    // inside a tool) — their text is not the agent's chat voice.
    const fromToolsNode = meta.langgraph_node === "tools";

    if (msg.type === "AIMessageChunk") {
      const calls = Array.isArray(msg.tool_call_chunks) ? msg.tool_call_chunks : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const id = typeof call.id === "string" ? call.id : null;
        const name = typeof call.name === "string" ? call.name : null;
        if (id && name && !startedTools.has(id)) {
          startedTools.add(id);
          yield { type: "tool.start", toolCallId: id, name };
        }
      }
      const text = chunkText(msg.content);
      if (text && !fromToolsNode) yield { type: "message.delta", messageId, text };
    } else if (msg.type === "tool") {
      const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id : null;
      if (id) yield { type: "tool.end", toolCallId: id, ok: msg.status !== "error" };
    }
  }

  yield { type: "message.end", messageId };
  yield { type: "done" };
}
