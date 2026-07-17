<div align="center">

# langchain-canvas

**A live canvas for LangChain agents.**

Your agent writes ordinary tools; your users get a canvas — a panel beside the
chat where documents, charts, tables, and full HTML pages render live, stream as
they're written, version themselves, and can be edited by clicking any element.

Quality bar: Genspark · ChatGPT Canvas · Claude Artifacts.

</div>

<div align="center">

**English** · 📖 [한국어](README.ko.md)

</div>

```
┌───────────────────────────┬─────────────────────────────────────┐
│  chat                     │  canvas                              │
│                           │  ┌────────────────────────────────┐  │
│  › build me a pricing page│  │  Starter   Pro   Enterprise    │  │
│                           │  │  $0        $20    Contact us    │  │
│  ✓ Built a page — click   │  │  [ hover → highlight,          │  │
│    any element to edit.   │  │    click → edit this element ] │  │
│                           │  └────────────────────────────────┘  │
└───────────────────────────┴─────────────────────────────────────┘
```

---

## Table of contents

- [See it with zero backend (schema replay)](#see-it-with-zero-backend-schema-replay)
- [Add a canvas to your own app](#add-a-canvas-to-your-own-app)
- [The three ideas](#the-three-ideas)
- [Features](#features)
- [Add your own artifact type](#add-your-own-artifact-type)
- [Docs](#docs) · [Roadmap](#roadmap) · [License](#license)

---

## See it with zero backend (schema replay)

The canvas is defined entirely by a **wire schema** — a stream of `StreamEvent`s.
So you can render it from a fixture, with no backend, no LLM, and no API key.
This is the fastest way to see it and to build renderers:

```bash
pnpm install
pnpm dev:web                  # → open http://localhost:3000/replay
```

Pick a scenario (HTML page, streaming doc, chart, table) and watch it render
exactly as a real agent would drive it. In code:

```tsx
import { Canvas, useCanvasReplay, scenarios } from "@langchain-canvas/react";

const { play } = useCanvasReplay();
play(scenarios[0].events);    // schema → screen, no network
```

> A LangChain/LangGraph backend emits these same events on LangGraph's `custom`
> stream channel; the frontend doesn't care whether they come from a fixture or a
> live agent. Develop against fixtures now, plug the real agent in when it's ready.

## Add a canvas to your own app

Two installs, two small pieces of code.

> Not yet published to PyPI/npm — for now install from this repo (see
> `apps/server/pyproject.toml` and `pnpm-workspace.yaml` for the workspace wiring).

### Backend (Python) — emit artifacts from a tool

```python
from langchain.tools import tool, ToolRuntime
from langchain_canvas import Canvas, create_canvas_agent, sse_from_agent

@tool
def build_page(brief: str, runtime: ToolRuntime) -> str:
    """Design an HTML page and show it on the canvas."""
    canvas = Canvas.from_runtime(runtime)          # 1. grab the canvas
    page = canvas.open_html(title=brief)           # 2. open an artifact
    page.set_html("<h1>Hello</h1>")                # 3. fill it (or .append(...) to stream)
    page.complete()
    return "Page is on the canvas."

agent = create_canvas_agent(model="anthropic:claude-sonnet-4-5", tools=[build_page])
```

Serve it over SSE with FastAPI:

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()

class Body(BaseModel):
    thread_id: str
    message: str

@app.post("/api/chat")
async def chat(body: Body):
    inputs = {"messages": [{"role": "user", "content": body.message}]}
    config = {"configurable": {"thread_id": body.thread_id}}
    return StreamingResponse(sse_from_agent(agent, inputs, config=config),
                             media_type="text/event-stream")
```

### Frontend (React) — render it

```tsx
"use client";
import { Canvas, useCanvasStream } from "@langchain-canvas/react";
import "@langchain-canvas/react/styles.css";

export default function Page() {
  const { sendMessage, messages, canvas, isStreaming, editSelection } =
    useCanvasStream({ endpoint: "/api/chat" });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "400px 1fr", height: "100vh" }}>
      <YourChatUI messages={messages} onSend={sendMessage} busy={isStreaming} />
      <Canvas onEditElement={editSelection} />   {/* click-to-edit wired in */}
    </div>
  );
}
```

That's it. `useCanvasStream` sends the message, parses the stream, and keeps both
the transcript (`messages`) and the canvas in sync; `<Canvas />` draws whatever
the agent emits. You bring the chat bubbles; the canvas is done.

A copy-pasteable version of both sides is in
[`docs/03-getting-started.md`](docs/03-getting-started.md).

---

## The three ideas

Every modern canvas (ChatGPT `canmore`, Claude `antArtifact`, Vercel AI SDK data
parts) converges on the same design. `langchain-canvas` is that design, minimal:

1. **Artifacts are emitted, never parsed.** The agent opens a canvas by calling a
   tool — no magic tokens in the prose.
2. **A `type` string selects a renderer.** The backend ships data (`{ type, data }`),
   never JSX. The frontend owns the `type → component` registry.
3. **A stable `id` reconciles everything.** Same `id` → mutate in place; new `id`
   → new artifact. That one rule powers streaming, patching, and versioning.

Under the hood it rides LangChain 1.x's native custom-stream channel
(`ToolRuntime.stream_writer` → `stream_mode="custom"`) — no framework fork.

## Features

- 🌐 **HTML is the base** — the agent emits a self-contained page, rendered in a
  CSP-sandboxed iframe. Documents, charts, and tables are structured conveniences
  on top.
- 🖱️ **Click-to-edit** — hover highlights, click selects, then either type an
  instruction (the agent surgically patches just that element) or use the **style
  panel** (color / size / weight / align) and **double-click to edit text inline**.
- ⚡ **O(1) element patches** — `canvas.node_patch` swaps one element by its
  `data-cid` instead of resending the page.
- 📝 **Streaming documents** — markdown rendered live, token-by-token.
- 📊 **Charts** & 📋 **tables** — line/bar/area/pie and sticky-header grids over tidy rows.
- 📦 **Export to files** — any artifact → self-contained **`.html`**, plus `.md` / `.csv` / `.json`.
- 🗂️ **Tabs + versioning** — switch between artifacts; page through every version.
- 🧩 **Pluggable renderers** & 🔌 **headless core** — register `type → component`, or use the reconciler/SSE client with your own UI.
- 🧵 **Typed on both ends** — Pydantic and TypeScript mirror one wire protocol.

## Add your own artifact type

Three steps, zero transport changes:

1. Add its data shape to both `protocol` modules (Python + TS).
2. Emit it from a tool (`canvas.open_*`, or a raw `canvas.create`).
3. Register a renderer: `<Canvas registry={{ ...builtinRenderers, kpi: KpiRenderer }} />`.

## Docs

- [Architecture](docs/01-architecture.md) — the boundaries and why they exist.
- [Wire protocol](docs/02-protocol.md) — every event and its reconciliation effect.
- [Getting started](docs/03-getting-started.md) — copy-paste, front to back.
- [Contributing](CONTRIBUTING.md).

## Roadmap

- One-click **publish → shareable URL** and `<iframe>` embed
- Multi-agent **parallel section fill** (subagents patch different regions live)
- Self-critique visual loop (agent screenshots and refines its own page)
- `code` artifacts (Monaco + diff) · HTML → React component export
- Durable, reload-surviving version history via a LangGraph checkpointer

## License

[MIT](LICENSE)
# langchain-canvas
