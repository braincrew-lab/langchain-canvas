# Architecture

A LangChain agent produces **artifacts** — documents, charts, and (later) code
or web views — that render live in a **canvas** beside the chat, at the
interaction quality of Genspark / ChatGPT Canvas / Claude Artifacts. This
repo is the SDK that makes that contract turnkey on both ends.

## The one idea

Modern canvas products (ChatGPT `canmore`, Claude `antArtifact`, LangGraph
`push_ui_message`, Vercel AI SDK data parts) all converge on the same shape:

> An agent **emits** a schema-validated artifact keyed by a stable `id`; a
> `type` string selects a **client-side renderer**; the same `id` reconciles
> streaming updates and explicit revisions.

This SDK takes that convergent pattern and binds it to LangChain 1.x's native
custom-stream channel (`ToolRuntime.stream_writer` → `stream_mode="custom"`),
so an agent author writes ordinary tools and gets a live canvas for free.

## System shape

```
┌───────────────────────────── apps/web (Next.js) ─────────────────────────────┐
│  <Chat/>                              <Canvas/>                                │
│  transcript, tokens                   artifact panel + version rail           │
│        │                                   │                                  │
│        └───────────── useCanvasStream() ───┘   (packages/canvas-react)        │
│                        │  parses SSE envelopes                                 │
│                        │  reconciles into a Zustand store (id → Artifact)      │
└────────────────────────┼──────────────────────────────────────────────────────┘
                         │  POST /api/chat  (SSE, Canvas Wire Protocol v1)
┌────────────────────────┼──────────────── apps/server (FastAPI) ───────────────┐
│                   routes/chat.py                                               │
│                        │  sse_from_agent(agent, inputs)                        │
│                        │                          (packages/canvas-py)         │
│         ┌──────────────┴───────────────┐                                       │
│         │  agent.astream(              │                                       │
│         │    stream_mode=[             │   "messages" → message.delta          │
│         │      "messages", "custom" ]) │   "custom"   → canvas.* (pass-through)│
│         └──────────────┬───────────────┘                                       │
│                create_canvas_agent(...)   = create_agent + canvas tools        │
│                        │                                                       │
│    tools call  canvas = Canvas.from_runtime(runtime)                           │
│                canvas.open_document(...).stream(chunks).complete()             │
│                canvas.open_chart(...).set_rows(...)                            │
│                        └── runtime.stream_writer(event)  ── emits CanvasEvent  │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Why these boundaries

- **The protocol is a package, not a convention.** `langchain_canvas.protocol`
  (Pydantic) and `@braincrew-lab/langchain-canvas` `protocol/*` (TypeScript) are
  hand-mirrored types. A wire change is a typed change on both sides, caught by
  the compiler rather than at runtime.
- **The emitter hides the wire.** Tool authors call
  `canvas.open_document(...)`, never `stream_writer({...})`. The envelope shape,
  the `append` vs `patch` decision, and version bumping live in one place
  (`langchain_canvas.emitter`), so the protocol can evolve without touching agents.
- **The reconciler is the only place that mutates artifact state.**
  `client/reconcile.ts` is a pure `(store, event) → store` function. The store,
  hooks, and components never special-case event types — they read the
  reconciled artifact. This keeps streaming, patching, and versioning in one
  auditable reducer.
- **The registry decouples data from rendering.** `registry.tsx` maps
  `type → component`. Adding "code" or "webview" artifacts is a new data shape +
  a new renderer, with zero transport or reconciler changes.

## Data flow, end to end

1. User sends a message → `POST /api/chat`.
2. `create_canvas_agent` runs the LangChain agent loop. A tool decides to show
   something and calls `canvas.open_chart(...)`.
3. The emitter serializes a `canvas.create` event and pushes it through
   `runtime.stream_writer`. LangGraph surfaces it on the `"custom"` stream.
4. `sse_from_agent` interleaves the `"messages"` channel (assistant tokens) and
   the `"custom"` channel (canvas events) into one SSE stream of wire envelopes.
5. `useCanvasStream` parses each envelope and feeds it to the reconciler, which
   updates the Zustand store.
6. `<Canvas/>` reads the store, looks up the renderer by `type`, and draws it.
   Streaming `append`/`patch` events flow straight through the same path, so the
   panel fills in live.

## Package layout

| path                       | role                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `packages/canvas-py`       | Backend SDK: protocol types, emitter, canvas tools, agent, SSE  |
| `packages/canvas-react`    | Frontend SDK: protocol types, SSE client, reconciler, store, registry, components |
| `apps/server`              | Reference FastAPI app wiring an agent with example tools        |
| `apps/web`                 | Reference Next.js app with a chat + canvas UI                   |
| `docs/`                    | Architecture (this file), the wire protocol, getting started    |

## Extension points

- **New artifact type** → data shape in both `protocol` modules + a renderer in
  the registry.
- **Richer edits** → add `canvas.replace` calls from an "edit artifact" tool;
  the version rail is already wired.
- **Sandboxed code/HTML** → render `type: "webview"` in a CSP-locked iframe
  (no network, inlined assets), following the Claude Artifacts sandbox model.
- **Durable history** → attach a LangGraph checkpointer and hydrate the store on
  thread load; the wire protocol is unchanged.
