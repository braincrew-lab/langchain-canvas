# deepagents-canvas

A [deepagents](https://docs.langchain.com/oss/python/deepagents/overview) agent
that builds slide decks and written reports on a persistent canvas, using the
four standard canvas tools plus one verification tool (`check_document`) — and
a browser UI that talks to the LangGraph server directly.

## What runs where

| Process | Port | Role |
|---|---|---|
| `uv run langgraph dev` | 2024 | The agent (`agent.py`). Chat streams go browser → here, directly. |
| `uv run uvicorn store_server:app --port 8000` | 8000 | Store sidecar: canvas reload (hydrate) + hand-edit save. ~40 lines over the SDK. |
| the repo web app (`pnpm dev` in `apps/web`) | 3000 | UI. Set `NEXT_PUBLIC_LANGGRAPH_URL=http://127.0.0.1:2024` to use the LangGraph transport. |

There is no translation middleman: the web app uses `langgraphTransport` from
`@braincrew-lab/langchain-canvas/langgraph`, which speaks to LangGraph through
the official JS SDK and turns the run stream into canvas events in the
browser.

The sidecar stays because the canvas store lives on server disk — reloading a
page and saving a hand edit need a server that can reach it. That part is an
app concern (this is also where you would enforce auth), and it is a few
lines over the SDK's `hydrate_events` and `store.write`.

## Setup

```bash
cd examples/deepagents-canvas
uv venv && uv pip install -e .
uv run playwright install chromium   # for check_document (renders documents headlessly)
cp .env.example .env   # fill in your model credentials
uv run langgraph dev                            # terminal 1
uv run uvicorn store_server:app --port 8000     # terminal 2
# terminal 3: repo root
NEXT_PUBLIC_LANGGRAPH_URL=http://127.0.0.1:2024 pnpm --filter web dev
```

Then open http://localhost:3000/chat and ask for a deck.

## Notes

- Reports live as one HTML file per section under `report/` on the canvas.
  After every write or edit the agent runs `check_document` (headless render
  → ERROR/WARNING report) and fixes until it is clean — including checking
  that the exact change you asked for actually appears.
- Verified against `langgraph dev` (local). Hosted LangGraph Platform is
  untested — open an issue if you need it.
- Thread ids: LangGraph requires UUIDs. Non-UUID thread ids are mapped
  deterministically (uuid5), identically in the JS transport and the sidecar,
  so both see the same canvas.
