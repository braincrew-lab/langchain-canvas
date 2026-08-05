# Code execution next to the canvas

The canvas core ships no code execution, on purpose. The four standard tools
(read / write / edit / list) cover the create-and-edit loop, and fixed
conversions (sources in, exports out) run server-side. That keeps the core
safe to embed anywhere.

But some agents legitimately need to *run things*: crunch an uploaded CSV,
try a script, compute numbers before writing the report. With
[deepagents](https://docs.langchain.com/oss/python/deepagents/overview),
that is an **assembly choice, not a canvas feature** — the two plug into
different slots of the same agent:

```python
from deepagents import create_deep_agent
from deepagents.backends import LocalShellBackend   # or your own sandbox
from langchain_canvas import FileCanvasStore, create_canvas_tools

STORE = FileCanvasStore("canvas-data")

graph = create_deep_agent(
    model=model,
    tools=create_canvas_tools(STORE),           # the shared canvas
    backend=LocalShellBackend(root_dir=...),    # a private workspace + shell
    system_prompt=SYSTEM_PROMPT,
)
```

`tools=` and `backend=` are orthogonal: the canvas tools talk to the store,
the backend gives the agent a filesystem (and, here, a shell). Neither knows
about the other.

## Two file spaces, one rule

The agent now has two places files can live, and it must never confuse them:

- **The canvas** (`read_canvas` / `write_canvas` / ...) — shared with the
  user, persistent, versioned, rendered in the UI. User uploads live here
  under `sources/`.
- **The workspace** (`ls` / `read_file` / `write_file` / `execute`) — the
  agent's private scratch space. Nothing here is visible to the user.

Say it in the system prompt, plainly:

```
The canvas is NOT your scratch filesystem: ls / read_file / write_file /
execute see only your private workspace, never the canvas. Work happens in
the workspace; results the user should keep go to the canvas.
```

## The bridge (~10 lines)

Results produced in the workspace reach the user by being written to the
canvas. One small custom tool closes the loop:

```python
from pathlib import Path
from langchain.tools import ToolRuntime, tool

@tool
def publish_to_canvas(workspace_path: str, canvas_path: str, runtime: ToolRuntime) -> str:
    """Copy a file produced in the workspace onto the shared canvas."""
    data = Path(workspace_path).read_bytes()
    scope = str((runtime.config or {}).get("configurable", {})["thread_id"])
    commit = STORE.write_bytes(scope, canvas_path, data, f"Publish {canvas_path}", actor="agent")
    return f"Published {canvas_path} (revision {commit.revision})."
```

That is the whole assembly: one backend line, one boundary paragraph, one
bridge tool.

## A word on safety

`LocalShellBackend` runs with the process's own permissions — fine for a
local demo, not for anything multi-user. For real deployments, put your own
sandboxed execution behind the same `backend=` slot; isolation is the
adopter's responsibility, and the canvas contract does not change either way.

## See it in context

The [deepagents example](../examples/deepagents-canvas/) runs the canvas
tools alone (no backend line). Add the two pieces above to give it a
workspace — the canvas side needs no changes.
