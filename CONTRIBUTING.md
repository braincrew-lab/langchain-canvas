# Contributing

Thanks for helping build `langchain-canvas`. This is a small, layered codebase —
the fastest way to be productive is to understand the [architecture](docs/01-architecture.md)
and the [wire protocol](docs/02-protocol.md) first, since almost every change
touches one of those two seams.

## Repo layout

```
packages/canvas-py      # langchain-canvas (Python backend SDK)
packages/canvas-react   # @langchain-canvas/react (frontend SDK)
apps/server             # reference FastAPI server
apps/web                # reference Next.js app
docs/                   # architecture, protocol, getting started
```

## Local setup

```bash
# Frontend workspace
pnpm install
pnpm --filter @langchain-canvas/react build

# Python SDK + server
cd apps/server && uv sync
```

## The golden rule: the protocol is mirrored

`langchain_canvas.protocol` (Pydantic) and `@langchain-canvas/react` `protocol/*`
(TypeScript) are hand-mirrored. **Any change to one must be made to the other in
the same PR.** A field added to `ChartData` in Python that is missing in
TypeScript is a bug, even if nothing breaks at runtime yet.

## Where changes go

| you want to…                     | change…                                             |
| -------------------------------- | --------------------------------------------------- |
| add an artifact type             | both `protocol/artifacts.*` + a renderer + a tool   |
| change how updates reconcile     | `packages/canvas-react/src/client/reconcile.ts`     |
| change the emitter ergonomics    | `packages/canvas-py/src/langchain_canvas/emitter.py`|
| change the wire (new event)      | both `protocol/events.*` + `docs/02-protocol.md`    |

## Checks before opening a PR

```bash
pnpm -r typecheck                          # TypeScript
cd packages/canvas-py && ruff check . && mypy src
```

Keep the reconciler pure, keep tool authors away from the wire, and keep the two
protocol modules in lockstep. If a change makes any of those harder, it probably
belongs somewhere else.
