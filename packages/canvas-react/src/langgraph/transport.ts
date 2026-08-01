/**
 * `langgraphTransport` — speak to a LangGraph server without a translator
 * in between.
 *
 * Built on the official `@langchain/langgraph-sdk` (the server's wire format
 * belongs to LangGraph and evolves with it — we ride the official client
 * rather than hand-parse it). Verified against `langgraph dev` (local);
 * hosted LangGraph Platform is untested — open an issue if you need it.
 *
 * Per user turn it: maps the canvas thread id to the UUID LangGraph requires,
 * makes sure the thread exists, frames any element selections into the
 * message (targeted edits), then streams the run with
 * `streamMode: ["messages-tuple", "custom"]` through the translation in
 * `translate.ts`.
 */

import { Client } from "@langchain/langgraph-sdk";

import type { ElementSelection } from "../protocol/selection";
import type { CanvasTransport, TransportRequest } from "../transports/types";
import { translateLangGraphStream, type LangGraphStreamChunk } from "./translate";

export interface LangGraphTransportOptions {
  /** LangGraph server URL, e.g. `http://127.0.0.1:2024` (`langgraph dev`). */
  url: string;
  /** Graph/assistant to run, e.g. `"canvas_agent"`. */
  assistantId: string;
  /** Extra headers (e.g. auth) passed to the SDK client. */
  headers?: Record<string, string>;
}

/** Frame a targeted edit so the agent changes only the selected element(s). */
export function withSelections(message: string, selections: ElementSelection[]): string {
  if (selections.length === 0) return message;
  const listed = selections.map((s) => `- \`${s.selector}\` (data-cid=${s.cid})`).join("\n");
  const artifactId = selections[0].artifactId;
  return (
    `${message}\n\n` +
    `[Targeted edit] Apply the change to these selected element(s) in file ` +
    `\`${artifactId}\`:\n${listed}\n` +
    `First call read_canvas on the file to get its current content and revision, ` +
    `then call edit_canvas with the element's exact current outer HTML as \`old\` ` +
    `and your replacement as \`new\` (keep the data-cid attribute).`
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * LangGraph requires UUID thread ids; the canvas allows any string. Non-UUID
 * ids map deterministically (RFC 4122 v5 over `canvas-thread:<id>`), matching
 * the mapping the Python bridge example uses — same id in, same UUID out.
 */
export async function threadUuid(threadId: string): Promise<string> {
  if (UUID_RE.test(threadId)) return threadId.toLowerCase();
  const name = new TextEncoder().encode(`canvas-thread:${threadId}`);
  const namespace = NAMESPACE_URL.replace(/-/g, "");
  const namespaceBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) namespaceBytes[i] = parseInt(namespace.slice(i * 2, i * 2 + 2), 16);
  const payload = new Uint8Array(namespaceBytes.length + name.length);
  payload.set(namespaceBytes);
  payload.set(name, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", payload)).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function langgraphTransport(options: LangGraphTransportOptions): CanvasTransport {
  const client = new Client({ apiUrl: options.url, defaultHeaders: options.headers });
  const knownThreads = new Set<string>();

  return {
    async *stream(request: TransportRequest) {
      const threadId = await threadUuid(request.threadId);
      if (!knownThreads.has(threadId)) {
        await client.threads.create({ threadId, ifExists: "do_nothing" });
        knownThreads.add(threadId);
      }
      const message = withSelections(request.message, request.selections ?? []);
      const chunks = client.runs.stream(threadId, options.assistantId, {
        input: { messages: [{ role: "user", content: message }] },
        streamMode: ["messages-tuple", "custom"],
        signal: request.signal,
      }) as AsyncIterable<LangGraphStreamChunk>;
      yield* translateLangGraphStream(chunks);
    },
  };
}
