# Canvas Wire Protocol — v1

The protocol is the contract between a LangChain agent (Python) and a React
canvas (TypeScript). Everything else in this repo is an implementation detail;
this document is the source of truth. The Python types in
`langchain_canvas.protocol` and the TypeScript types in `@braincrew-lab/langchain-canvas`
are hand-mirrored from the definitions below and must stay in lockstep.

## Design goals

1. **Artifacts are emitted, never parsed.** The agent opens a canvas by calling
   a tool, not by writing magic tokens into its prose. Every canvas mutation is
   a schema-validated event.
2. **A `type` string selects a renderer.** The backend only ever ships data
   (`{ type, data }`); it never ships JSX. The frontend owns a registry that
   maps `type → React component`.
3. **A stable `id` is the reconciliation primitive.** Streaming updates and
   explicit revisions both key off the same `id`. Same `id` → mutate in place;
   new `id` → new artifact.
4. **Two streaming layers.** Chat tokens and artifact mutations travel on the
   same wire but are distinct event families, so the transcript and the canvas
   update independently.

## Transport

A single endpoint streams **Server-Sent Events** (`text/event-stream`):

```
POST /api/chat
  body: { thread_id: string, message: string }
  ->    text/event-stream, one JSON envelope per `data:` line, terminated by a
        `done` event.
```

SSE is the right default: it is one-directional (server → client), survives
proxies, auto-reconnects, and needs no handshake. Swap in WebSocket only if you
add client → server mid-stream signals (e.g. live co-editing).

## Envelope

Every line is one JSON object discriminated by `type`.

### Chat family — drives the conversation transcript

| `type`           | payload                          | meaning                          |
| ---------------- | -------------------------------- | -------------------------------- |
| `message.delta`  | `{ messageId, text }`            | one assistant token chunk        |
| `message.end`    | `{ messageId }`                  | assistant message complete       |
| `tool.start`     | `{ toolCallId, name }`           | a tool began executing           |
| `tool.end`       | `{ toolCallId, ok }`             | a tool finished (ok / errored)   |

### Canvas family — drives the canvas panel

| `type`            | payload                         | reconciliation effect                                   |
| ----------------- | ------------------------------- | ------------------------------------------------------- |
| `canvas.create`   | `{ artifact }`                  | register artifact, open panel, focus it                 |
| `canvas.append`   | `{ id, path, text }`            | append `text` to the string at `data.<path>`            |
| `canvas.patch`    | `{ id, patch }`                 | JSON-merge-patch `patch` into `data`                    |
| `canvas.replace`  | `{ id, artifact }`              | snapshot as a new version, bump `version`               |
| `canvas.status`   | `{ id, status }`                | set `streaming` / `complete` / `error`                  |
| `canvas.close`    | `{ id }`                        | mark closed (kept in history)                           |

### Control family

| `type`    | payload            | meaning                        |
| --------- | ------------------ | ------------------------------ |
| `error`   | `{ message }`      | run-level failure              |
| `done`    | `{}`               | stream finished, close the SSE |

## Artifact shape

```ts
type Artifact<TData = unknown> = {
  id: string;          // stable identity — the reconciliation key
  type: string;        // registry key: "document" | "chart" | ...
  title: string;       // shown in the canvas header / tab
  version: number;     // 1-based; bumped on every `canvas.replace`
  status: "streaming" | "complete" | "error";
  data: TData;         // type-specific payload, rendered by the matched component
  meta?: Record<string, unknown>;
};
```

### Built-in artifact data shapes

```ts
// type: "html" — the base substrate, rendered in a sandboxed iframe
type HtmlData = { html: string };

// type: "document"
type DocumentData = { format: "markdown"; content: string };

// type: "chart"
type ChartData = {
  chart: "line" | "bar" | "area" | "pie";
  rows: Array<Record<string, string | number>>;  // tidy/long-form rows
  xKey: string;                                   // category / x-axis field
  series: Array<{ key: string; label?: string; color?: string }>;
  options?: { stacked?: boolean; yLabel?: string };
};

// type: "table"
type TableData = {
  columns: Array<{ key: string; label?: string; align?: "left" | "right" | "center" }>;
  rows: Array<Record<string, string | number>>;
};
```

New artifact types are added by (1) defining a data shape here, (2) mirroring it
in both `protocol` modules, and (3) registering a renderer on the frontend. No
change to the transport or the reconciler is needed.

## Update semantics — which event to emit

| situation                                   | event            |
| ------------------------------------------- | ---------------- |
| open a new panel                            | `canvas.create`  |
| stream a document body token-by-token       | `canvas.append`  |
| progressively fill structured data (chart)  | `canvas.patch`   |
| a targeted edit that produces a new version | `canvas.replace` |
| flip streaming → done                       | `canvas.status`  |

`append` is a fast-path for the common "grow a markdown string" case; `patch` is
the general partial update (RFC-7386 JSON Merge Patch semantics: `null` deletes
a key, objects merge recursively, everything else replaces). `replace` is the
only event that creates a version — that is what the version rail pages through.

## Client → server: selection & targeted edits

The SSE wire is server→client only. The one client→server concern is **element
selection**: the `html` renderer runs an inspector in its sandboxed iframe that
stamps every element with a `data-cid` and reports the clicked element back to
the host via `postMessage`:

```ts
type ElementSelection = {
  artifactId: string;   // which html artifact
  cid: string;          // deterministic path id, e.g. "e-0-2"
  selector: string;     // "button.cta"
  tag: string;
  text?: string;
  outerHtml?: string;   // edit context for the agent
};
```

This rides the **chat request** (not the SSE stream): a targeted edit is a normal
turn with `selection` attached. The server frames it as an instruction to change
only that element and re-emit the page under the **same** `artifactId` (so the
reconciler updates in place). Node-scoped patching — updating a single `cid`
without resending the whole page — is a planned protocol extension
(`canvas.node_patch`); today an edit is a full `canvas.patch`/`replace` of the
`html` string.

## Versioning

Version history is **client-owned** and derived from the stream; it is never
re-sent in bulk. The reconciler keeps `history[id]: Artifact[]`, pushing a
snapshot on every `canvas.replace`. For durable, reload-surviving history,
persist snapshots in the LangGraph checkpointer keyed by `thread_id` and
`artifact.id` and hydrate the store on thread load — the wire protocol stays
identical.
