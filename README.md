<div align="center">

# langchain-canvas

**A live canvas for LangChain agents.**

Your agent writes ordinary tools; your users get a canvas — a panel beside the
chat where documents, charts, tables, slides, and full HTML pages render live,
stream as they're written, version themselves, and can be edited by clicking any
element.

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
- [Run the full reference app](#run-the-full-reference-app)
- [Add a canvas to your own app](#add-a-canvas-to-your-own-app)
- [The three ideas](#the-three-ideas)
- [Features](#features)
- [What to emit per artifact type](#what-to-emit-per-artifact-type)
- [Add your own artifact type](#add-your-own-artifact-type)
- [Docs](#docs) · [Roadmap](#roadmap) · [License](#license)

---

## See it with zero backend (schema replay)

The canvas is defined entirely by a **wire schema** — a stream of `StreamEvent`s.
So you can render it from a fixture, with no backend, no LLM, and no API key.
This is the fastest way to see it and to build renderers:

```bash
pnpm install
pnpm dev:web                  # → open http://localhost:3000
```

The home page (`/`) is a **Schema Explorer**: a Swagger-style tour of the wire
protocol where, per artifact type, you see the Python call, the artifact
envelope, the `data` schema, and a live-rendering "try it out" panel. For the raw
fixture player, open [`/replay`](http://localhost:3000/replay) and pick a scenario
(HTML page, streaming doc, chart, table, slides) to watch it render exactly as a
real agent would drive it. In code:

```tsx
import { Canvas, useCanvasReplay, scenarios } from "@braincrew-lab/langchain-canvas";

const { play } = useCanvasReplay();
play(scenarios[0].events);    // schema → screen, no network
```

> A LangChain/LangGraph backend emits these same events on LangGraph's `custom`
> stream channel; the frontend doesn't care whether they come from a fixture or a
> live agent. Develop against fixtures now, plug the real agent in when it's ready.

## Run the full reference app

A complete front-to-back demo lives in `apps/` — a Next.js frontend and a FastAPI
reference server driving a real agent.

```bash
make install                  # pnpm install + uv sync (server deps)

# 1. backend — FastAPI on :8000
cp apps/server/.env.example apps/server/.env     # then set ANTHROPIC_API_KEY
make dev-server

# 2. frontend — Next.js on :3000
cp apps/web/.env.example apps/web/.env.local     # BACKEND_URL=http://localhost:8000
make dev-web                  # → open http://localhost:3000/chat
```

**Environment variables**

| File | Var | Purpose |
| --- | --- | --- |
| `apps/server/.env` | `ANTHROPIC_API_KEY` | Model credentials for the agent (required for `/chat`). |
| `apps/server/.env` | `CORS_ORIGINS` | Comma-separated origins allowed to call the server directly (default `http://localhost:3000`). Must match the frontend's origin. |
| `apps/web/.env.local` | `BACKEND_URL` | Backend the `/api/chat` SSE proxy forwards to (default `http://localhost:8000`). |
| `apps/web/.env.local` | `NEXT_PUBLIC_CANVAS_SERVER` | Backend the browser calls directly for canvas hydration / save / upload (default `http://localhost:8000`). |
| `apps/web/.env.local` | `NEXT_PUBLIC_LANGGRAPH_URL` | *(optional)* Point `/chat` at a LangGraph server instead of the FastAPI reference server (see `examples/deepagents-canvas`). |

> The frontend must run on an origin listed in `CORS_ORIGINS` (default
> `http://localhost:3000`). The chat page calls the backend directly for canvas
> files, so an origin mismatch surfaces as a CORS error.

## Add a canvas to your own app

Two installs, two small pieces of code.

The React SDK is on npm; the Python package isn't on PyPI yet, so install it from
this repo (see `apps/server/pyproject.toml` for the workspace wiring).

```bash
# frontend
npm i @braincrew-lab/langchain-canvas          # or pnpm / yarn

# backend (from a checkout of this repo)
pip install "langchain-canvas[ingestion] @ git+https://github.com/braincrew-lab/langchain-canvas.git#subdirectory=packages/canvas-py"
```

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

Prefer a ready-made toolset? `create_canvas_tools(...)` (and the focused
`create_document_tools` / `create_deck_tools` / `create_table_tools` /
`create_export_tool` / `create_asset_tool`) give the agent canvas tools without
writing your own.

### Frontend (React) — render it

```tsx
"use client";
import { Canvas, useCanvasStream } from "@braincrew-lab/langchain-canvas";
import "@braincrew-lab/langchain-canvas/styles.css";

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
  CSP-sandboxed iframe. Documents, charts, tables, and slides are structured
  conveniences on top.
- 🖱️ **Click-to-edit** — hover highlights, click selects, then either type an
  instruction (the agent surgically patches just that element) or use the **style
  panel** (color / size / weight / align) and **double-click to edit text inline**.
- ⚡ **O(1) element patches** — `page.patch_node(cid, html)` swaps one element by
  its `data-cid` instead of resending the page.
- 📝 **Streaming documents** — markdown rendered live, token-by-token.
- 📊 **Charts** & 📋 **tables** — line/bar/area/pie (ECharts) and sticky-header
  grids over tidy rows, with spreadsheet-style formula support.
- 🗂️ **Files in, files out** — drop a source file onto the canvas (`file`
  artifacts, with cover thumbnails and excerpts); export any artifact to a
  self-contained **`.html`**, **`.docx`**, **`.pdf`**, plus `.md` / `.csv` / `.json`.
- 🧷 **Persistent & reload-safe** — per-thread canvases are stored, hydrated on
  reload, and hand edits are saved back as commits (`CanvasStore` /
  `FileCanvasStore` + `hydrate_events`).
- 🔖 **Tabs + versioning** — switch between artifacts; page through every version.
- 🧩 **Pluggable renderers** & 🔌 **headless core** — register `type → component`,
  or drive the reconciler/SSE client (and a `./langgraph` transport) from your own UI.
- 🎛️ **Host-customizable chrome** — override labels, header chrome, and export
  actions via `<Canvas labels chrome exportExtras />`.
- 🧵 **Typed on both ends** — Pydantic and TypeScript mirror one wire protocol.

## What to emit per artifact type

The `type` string selects the renderer, so **send the shape that matches the type
you want** — a table wrapped in `html` renders as a web page, not a grid. One
`canvas.create` line per artifact:

| type       | renders as         | `data` you must ship                                  |
| ---------- | ------------------ | ----------------------------------------------------- |
| `html`     | web page (iframe)  | `{ html }`                                            |
| `document` | Word-style doc     | `{ format: "markdown", content }`                     |
| `slides`   | PowerPoint deck    | `{ slides: [{ layout, title, bullets, … }] }`         |
| `table`    | Excel-style grid   | `{ columns: [{ key, label }], rows: [{ … }] }`        |
| `chart`    | line/bar/area/pie  | `{ chart, xKey, rows, series: [{ key, label }] }`     |
| `file`     | download / preview | `{ path, name, mediaType?, size?, cover?, excerpt? }` |

```json
{ "type": "canvas.create", "artifact": {
  "id": "deck-1", "type": "slides", "title": "Pitch", "version": 1, "status": "complete",
  "data": { "slides": [
    { "layout": "title",   "title": "AI for business", "subtitle": "2026 outlook" },
    { "layout": "content", "title": "Why now", "bullets": ["Cheaper models", "Real ROI"] }
  ] }
} }
```

Only have **pre-rendered HTML**? Keep `type: "html"` and label the content with
`meta` + in-HTML markers — a slide is `meta: { kind: "slide", ratio: "16:9" }` over
a `1280×720 .slide-container`; a table wraps its `<table>` in
`<div data-dataframe-table="true">`. Full copy-paste examples and gotchas (slide
scaling, web-page scrolling, why a document must use `type: "document"`) are in the
[wire protocol → *What to emit per type*](docs/02-protocol.md#what-to-emit-per-type--copy-paste-examples).

## Add your own artifact type

Three steps, zero transport changes:

1. Add its data shape to both `protocol` modules (Python + TS).
2. Emit it from a tool (`canvas.open_*`, or a raw `canvas.create`).
3. Register a renderer: `<Canvas registry={{ ...builtinRenderers, kpi: KpiRenderer }} />`.

## Docs

- [Architecture](docs/01-architecture.md) — the boundaries and why they exist.
- [Wire protocol](docs/02-protocol.md) — every event and its reconciliation effect.
- [Getting started](docs/03-getting-started.md) — copy-paste, front to back.
- [Code execution](docs/04-code-execution.md) — running code next to the canvas.
- [Contributing](CONTRIBUTING.md).

## Roadmap

- One-click **publish → shareable URL** and `<iframe>` embed
- Multi-agent **parallel section fill** (subagents patch different regions live)
- Self-critique visual loop (agent screenshots and refines its own page)
- `code` artifacts (Monaco + diff) · HTML → React component export

## License

[MIT](LICENSE)
