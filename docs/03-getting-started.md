# Getting started

This walks through wiring `langchain-canvas` into your own app, front to back.
For the reference implementation, see `apps/server` and `apps/web`.

## 1. Emit artifacts from a tool (backend)

Install the SDK and write a tool that opens a canvas artifact. The tool receives
a `ToolRuntime` (injected by LangChain, hidden from the model) and hands it to
`Canvas`:

```python
from langchain.tools import tool, ToolRuntime
from langchain_canvas import Canvas
from langchain_canvas.protocol import ChartSeries

@tool
def revenue_chart(quarters: list[str], amounts: list[float], runtime: ToolRuntime) -> str:
    """Chart quarterly revenue."""
    canvas = Canvas.from_runtime(runtime)
    chart = canvas.open_chart(
        title="Quarterly revenue",
        chart="bar",
        x_key="quarter",
        series=[ChartSeries(key="amount", label="Revenue ($M)")],
    )
    chart.set_rows([{"quarter": q, "amount": a} for q, a in zip(quarters, amounts)])
    chart.complete()
    return "Charted quarterly revenue on the canvas."
```

## 2. Build the agent and stream it (backend)

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from langchain_canvas import create_canvas_agent, sse_from_agent

agent = create_canvas_agent(
    model="anthropic:claude-sonnet-4-5-20250929",
    tools=[revenue_chart],
)

app = FastAPI()

class ChatRequest(BaseModel):
    thread_id: str
    message: str

@app.post("/api/chat")
async def chat(req: ChatRequest):
    inputs = {"messages": [{"role": "user", "content": req.message}]}
    config = {"configurable": {"thread_id": req.thread_id}}
    return StreamingResponse(
        sse_from_agent(agent, inputs, config=config),
        media_type="text/event-stream",
    )
```

## 3. Render the canvas (frontend)

```tsx
"use client";
import { Canvas, useCanvasStream } from "@langchain-canvas/react";
import "@langchain-canvas/react/styles.css";

export default function Page() {
  const { sendMessage, messages, isStreaming } = useCanvasStream({ endpoint: "/api/chat" });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "400px 1fr", height: "100vh" }}>
      <ChatUI messages={messages} onSend={sendMessage} busy={isStreaming} />
      <Canvas />
    </div>
  );
}
```

`useCanvasStream` owns the thread: it POSTs your message, parses the SSE stream,
and reconciles both the transcript (`messages`) and the canvas (`canvas`) into a
store. `<Canvas />` reads that store and renders. You supply the chat UI; the
canvas is done.

## 4. Register a custom renderer (optional)

```tsx
import { Canvas, builtinRenderers, type RendererProps } from "@langchain-canvas/react";

function KpiRenderer({ artifact }: RendererProps<{ label: string; value: number }>) {
  return <div className="kpi"><span>{artifact.data.label}</span><b>{artifact.data.value}</b></div>;
}

<Canvas registry={{ ...builtinRenderers, kpi: KpiRenderer }} />;
```

Emit it from a tool with a raw `canvas.create` (or add an `open_kpi` helper to
your own `Canvas` subclass). The `type` string `"kpi"` is the only thing that
ties the two ends together.

## Next steps

- [Architecture](01-architecture.md) — the boundaries and why they exist.
- [Wire protocol](02-protocol.md) — every event and its reconciliation effect.
