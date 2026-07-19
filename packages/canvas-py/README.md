# langchain-canvas (Python)

The backend half of [`langchain-canvas`](../../README.md): turn a LangChain
agent's tools into a live React canvas.

```python
from langchain_canvas import Canvas, create_canvas_agent, sse_from_agent
```

- **`Canvas`** — the API your tools use. `Canvas.from_runtime(runtime)` then
  `open_document(...)` / `open_chart(...)`; the returned handles stream content
  in (`append`, `set_rows`) and mark completion (`complete`).
- **`create_canvas_agent(model, tools, ...)`** — `langchain.agents.create_agent`
  plus guidance that teaches the model when to reach for a canvas tool. All
  `create_agent` kwargs pass through.
- **`sse_from_agent(agent, inputs, config=...)`** — an async generator of SSE
  frames implementing the [Canvas Wire Protocol](../../docs/02-protocol.md). Hand
  it to a FastAPI `StreamingResponse`.

The wire types live in `langchain_canvas.protocol` and mirror
`@braincrew-lab/langchain-canvas`.

See the [getting-started guide](../../docs/03-getting-started.md).
