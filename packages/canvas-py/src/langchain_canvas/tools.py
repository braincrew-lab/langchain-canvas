"""Standard canvas tools — the agent's hands on a persistent canvas.

Four file-level primitives over a :class:`~langchain_canvas.store.CanvasStore`:

- ``read_canvas``  — file content with line numbers + the current revision
- ``write_canvas`` — create or fully replace a file
- ``edit_canvas``  — replace one unique occurrence, **requires the revision
  returned by a prior read** (read-before-update enforced by the contract,
  not by prompt discipline)
- ``list_canvas``  — files currently on the canvas

The tools are store-only primitives: they persist content and history, and do
not emit wire events themselves (display sync arrives with the
``canvas.commit`` event). Which canvas they act on is resolved per call:
``canvas_id`` in the runtime context (or ``configurable``), falling back to
``thread_id`` — by default a thread and its canvas are the same scope.

Build them with :func:`create_canvas_tools`, which closes over your store::

    store = InMemoryCanvasStore()
    agent = create_canvas_agent(model, tools=create_canvas_tools(store))
"""

from __future__ import annotations

from typing import Any

from langchain.tools import ToolRuntime, tool

from .store import (
    CanvasFileNotFoundError,
    CanvasStore,
    EditConflictError,
    RevisionMismatchError,
)

_RETRY_HINT = "Call read_canvas again and retry with the fresh revision and exact content."


def _canvas_id(runtime: ToolRuntime) -> str:
    """Resolve the target canvas for this call.

    Precedence: explicit ``canvas_id`` in the runtime context (attribute or
    mapping key), then ``configurable.canvas_id``, then ``configurable.thread_id``.
    """
    context = runtime.context
    for source in (
        getattr(context, "canvas_id", None),
        context.get("canvas_id") if isinstance(context, dict) else None,
    ):
        if source:
            return str(source)
    configurable: dict[str, Any] = (runtime.config or {}).get("configurable", {})
    for key in ("canvas_id", "thread_id"):
        if configurable.get(key):
            return str(configurable[key])
    raise ValueError(
        "No canvas id: provide `canvas_id` in the runtime context or run with a `thread_id`."
    )


def _numbered(content: str) -> str:
    return "\n".join(f"{i:>4}\t{line}" for i, line in enumerate(content.split("\n"), start=1))


def create_canvas_tools(store: CanvasStore) -> list[Any]:
    """Return the four standard canvas tools bound to ``store``."""

    @tool
    def read_canvas(path: str, runtime: ToolRuntime) -> str:
        """Read one canvas file before viewing or editing it.

        Returns the file with line numbers plus the current `revision`. You
        need that revision to call `edit_canvas` or to safely overwrite with
        `write_canvas` — always read a file again right before editing it, so
        you see edits the user may have made by hand.
        """
        try:
            got = store.read(_canvas_id(runtime), path)
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas to see available files."
        return f"revision: {got.revision}\n{_numbered(got.content)}"

    @tool
    def write_canvas(path: str, content: str, description: str, runtime: ToolRuntime) -> str:
        """Create a new canvas file, or fully replace an existing one.

        `description` becomes the version-history entry — one short sentence
        describing the change. For small changes to an existing file prefer
        `edit_canvas`; use `write_canvas` for new files or full rewrites.
        """
        commit = store.write(_canvas_id(runtime), path, content, description)
        return f"Wrote {path} (revision {commit.revision})."

    @tool
    def edit_canvas(
        path: str,
        old: str,
        new: str,
        description: str,
        revision: str,
        runtime: ToolRuntime,
    ) -> str:
        """Replace exactly one occurrence of `old` with `new` in a canvas file.

        `revision` must be the value returned by your most recent
        `read_canvas` of this file — if the file changed since (for example
        the user edited it), the call is rejected and you must read again.
        `old` must match exactly once; include enough surrounding context to
        make it unique. `description` is the version-history entry.
        """
        try:
            commit = store.edit(
                _canvas_id(runtime), path, old, new, description, base_revision=revision
            )
        except RevisionMismatchError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except EditConflictError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas to see available files."
        return f"Edited {path} (revision {commit.revision})."

    @tool
    def list_canvas(runtime: ToolRuntime) -> str:
        """List the files currently on the canvas, with sizes in bytes."""
        infos = store.list_files(_canvas_id(runtime))
        if not infos:
            return "The canvas is empty."
        return "\n".join(f"{info.path} ({info.size} bytes)" for info in infos)

    return [read_canvas, write_canvas, edit_canvas, list_canvas]
