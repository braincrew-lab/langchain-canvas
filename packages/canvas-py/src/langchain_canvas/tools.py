"""Standard canvas tools — the agent's hands on a persistent canvas.

Four file-level primitives over a :class:`~langchain_canvas.store.CanvasStore`:

- ``read_canvas``  — file content with line numbers + the current revision
- ``write_canvas`` — create or fully replace a file
- ``edit_canvas``  — replace one unique occurrence, **requires the revision
  returned by a prior read** (read-before-update enforced by the contract,
  not by prompt discipline)
- ``list_canvas_files`` — files currently on the canvas

The tools persist through the store **and** broadcast each committed
artifact-file change (``.html`` pages, ``.table.json`` tables) as wire events
(``canvas.create``/``patch``/``commit``) through the run's stream writer, so a
connected client redraws live. Without a stream
writer (unit tests, plain scripts) the broadcast is a silent no-op — same
contract as :class:`~langchain_canvas.emitter.Canvas`. Which canvas they act
on is resolved per call: ``canvas_id`` in the runtime context (or
``configurable``), falling back to ``thread_id`` — by default a thread and
its canvas are the same scope.

Build them with :func:`create_canvas_tools`, which closes over your store::

    store = InMemoryCanvasStore()
    agent = create_canvas_agent(model, tools=create_canvas_tools(store))
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from langchain.tools import ToolRuntime, tool

from .converters import (
    MissingConverterDependencyError,
    SourceConverter,
    converter_for,
    default_converters,
)
from .exporters import (
    Exporter,
    MissingExporterDependencyError,
    default_exporters,
    exporter_for,
)
from .replay import ARTIFACT_SUFFIXES, events_for_commit
from .store import (
    BinaryContentError,
    CanvasFileNotFoundError,
    CanvasStore,
    CanvasStoreError,
    Commit,
    EditConflictError,
    RevisionMismatchError,
)

_RETRY_HINT = "Call read_canvas again and retry with the fresh revision and exact content."
_SOURCES_PREFIX = "sources/"
_SOURCES_READONLY = (
    "Error: files under sources/ are the user's original uploads and are "
    "read-only for the agent. Create a new canvas file instead (for example "
    "an .html page or a .table.json table)."
)
_DEFAULT_READ_LIMIT = 400


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


def _sliced(content: str, offset: int, limit: int) -> tuple[str, str]:
    """A line window of ``content`` plus a continuation note ("" when complete)."""
    lines = content.split("\n")
    total = len(lines)
    window = lines[offset : offset + limit]
    numbered = "\n".join(
        f"{i:>4}\t{line}" for i, line in enumerate(window, start=offset + 1)
    )
    end = offset + len(window)
    if offset == 0 and end >= total:
        return numbered, ""
    note = f"[lines {offset + 1}-{end} of {total}"
    if end < total:
        note += f" — call read_canvas again with offset={end} for more"
    return numbered, note + "]"


def create_canvas_tools(
    store: CanvasStore,
    *,
    converters: list[SourceConverter] | None = None,
    title_for: Callable[[str], str] | None = None,
    meta_for: Callable[[str], dict[str, Any] | None] | None = None,
) -> list[Any]:
    """Return the four standard canvas tools bound to ``store``.

    ``converters`` render binary source files (uploads under ``sources/``)
    into model-usable content when the agent reads them; defaults to the
    built-in set (see :mod:`langchain_canvas.converters`) and is fully
    replaceable with your own pipeline. ``title_for`` / ``meta_for``
    customize the live broadcast the same way they customize
    :func:`~langchain_canvas.replay.hydrate_events`: map a file path to a
    display title / renderer hints (for example titling slide files from a
    deck manifest). Defaults: the path as title, no hints.
    """
    active_converters = default_converters() if converters is None else converters

    def _broadcast(
        runtime: ToolRuntime, canvas_id: str, path: str, is_new: bool, commit: Commit
    ) -> None:
        # Same silent no-op contract as the Canvas emitter: no writer, no wire.
        writer = getattr(runtime, "stream_writer", None)
        if writer is None or not path.endswith(ARTIFACT_SUFFIXES):
            return
        content = store.read(canvas_id, path, revision=commit.revision).content
        for event in events_for_commit(
            path,
            content,
            is_new=is_new,
            revision=commit.revision,
            description=commit.description,
            title=title_for(path) if title_for else None,
            meta=meta_for(path) if meta_for else None,
        ):
            writer(event)

    def _has_file(canvas_id: str, path: str) -> bool:
        return any(info.path == path for info in store.list_files(canvas_id))

    def _read_source(canvas_id: str, path: str, offset: int, limit: int) -> str | list[dict]:
        """A binary file rendered through its converter (or an honest refusal)."""
        converter = converter_for(path, active_converters)
        if converter is None:
            suffixes = sorted({s for c in active_converters for s in c.suffixes})
            return (
                f"Error: {path} is a binary file and no converter handles it. "
                f"Converters are installed for: {', '.join(suffixes)}."
            )
        got = store.read_bytes(canvas_id, path)
        try:
            converted = converter.convert(got.data, path=path)
        except MissingConverterDependencyError as exc:
            return f"Error: {exc}"
        text = "\n".join(
            str(block.get("text", "")) for block in converted.blocks if block.get("type") == "text"
        )
        sliced, note = _sliced(text, offset, limit)
        meta = ", ".join(f"{k}: {v}" for k, v in converted.metadata.items())
        header = f"revision: {got.revision}\nconverted view of {path}" + (
            f" ({meta})" if meta else ""
        )
        body = f"{header}\n{sliced}" + (f"\n{note}" if note else "")
        images = [block for block in converted.blocks if block.get("type") == "image"]
        if images:
            return [{"type": "text", "text": body}, *images]
        return body

    @tool
    def read_canvas(
        path: str, runtime: ToolRuntime, offset: int = 0, limit: int = _DEFAULT_READ_LIMIT
    ) -> str | list[dict]:
        """Read one canvas file before viewing or editing it.

        Returns the file with line numbers plus the current `revision`. You
        need that revision to call `edit_canvas` or to safely overwrite with
        `write_canvas` — always read a file again right before editing it, so
        you see edits the user may have made by hand.

        Long files are windowed: `offset`/`limit` select a line range and the
        output says how to read the rest. Binary uploads under `sources/` are
        rendered through a format converter instead of raw bytes.
        """
        canvas_id = _canvas_id(runtime)
        offset = max(0, offset)
        limit = max(1, limit)
        try:
            got = store.read(canvas_id, path)
        except BinaryContentError:
            try:
                return _read_source(canvas_id, path, offset, limit)
            except CanvasStoreError as exc:
                return f"Error: {exc}."
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        sliced, note = _sliced(got.content, offset, limit)
        return f"revision: {got.revision}\n{sliced}" + (f"\n{note}" if note else "")

    @tool
    def write_canvas(
        path: str,
        content: str,
        description: str,
        runtime: ToolRuntime,
        revision: str | None = None,
    ) -> str:
        """Create a new canvas file, or fully replace an existing one.

        `description` becomes the version-history entry — one short sentence
        describing the change. For small changes to an existing file prefer
        `edit_canvas`; use `write_canvas` for new files or full rewrites.
        When replacing an existing file, pass the `revision` from your most
        recent `read_canvas` — if the canvas changed since (for example the
        user edited it by hand), the call is rejected instead of silently
        overwriting their work. Omit `revision` only for brand-new files.
        Files under `sources/` (the user's uploads) are read-only.
        """
        if path.startswith(_SOURCES_PREFIX):
            return _SOURCES_READONLY
        canvas_id = _canvas_id(runtime)
        is_new = not _has_file(canvas_id, path)
        try:
            commit = store.write(
                canvas_id,
                path,
                content,
                description,
                base_revision=revision,
                actor="agent",
            )
        except RevisionMismatchError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        _broadcast(runtime, canvas_id, path, is_new, commit)
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
        make it unique. `description` is the version-history entry. Files
        under `sources/` (the user's uploads) are read-only.
        """
        if path.startswith(_SOURCES_PREFIX):
            return _SOURCES_READONLY
        canvas_id = _canvas_id(runtime)
        try:
            commit = store.edit(
                canvas_id,
                path,
                old,
                new,
                description,
                base_revision=revision,
                actor="agent",
            )
        except RevisionMismatchError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except EditConflictError as exc:
            return f"Error: {exc}. {_RETRY_HINT}"
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        _broadcast(runtime, canvas_id, path, is_new=False, commit=commit)
        return f"Edited {path} (revision {commit.revision})."

    @tool
    def list_canvas_files(runtime: ToolRuntime) -> str:
        """List the files currently on the canvas, with sizes in bytes."""
        try:
            infos = store.list_files(_canvas_id(runtime))
        except CanvasStoreError as exc:
            return f"Error: {exc}."
        if not infos:
            return "The canvas is empty."
        return "\n".join(f"{info.path} ({info.size} bytes)" for info in infos)

    return [read_canvas, write_canvas, edit_canvas, list_canvas_files]


def create_export_tool(store: CanvasStore, *, exporters: list[Exporter] | None = None) -> Any:
    """Build an ``export_canvas`` tool bound to ``store``.

    Kept separate from :func:`create_canvas_tools` so the four standard tools
    stay a stable contract — add this tool when your agent should hand users
    office files. ``exporters`` defaults to the built-in set (see
    :mod:`langchain_canvas.exporters`) and is fully replaceable with your own
    pipeline. Exported files land on the canvas under ``exports/``.
    """
    active_exporters = default_exporters() if exporters is None else exporters

    @tool
    def export_canvas(path: str, target: str, runtime: ToolRuntime) -> str:
        """Export canvas work into a downloadable office file.

        ``path`` is one canvas file (``report/02-overview.html``,
        ``sales.table.json``) or a directory prefix ending in ``/``
        (``report/``), which merges every .html file under it, in name
        order, into one document with a page break between sections.
        ``target`` is the output format: ``docx`` for .html files,
        ``xlsx`` for .table.json tables. The result is saved under
        ``exports/`` on the canvas, where the user can download it.
        """
        canvas_id = _canvas_id(runtime)
        try:
            if path.endswith("/"):
                section_paths = sorted(
                    info.path
                    for info in store.list_files(canvas_id)
                    if info.path.startswith(path) and info.path.lower().endswith((".html", ".htm"))
                )
                if not section_paths:
                    return f"Error: no .html files under {path} to export."
                content = "\n<hr/>\n".join(
                    store.read(canvas_id, section).content for section in section_paths
                )
                sample = section_paths[0]
            else:
                content = store.read(canvas_id, path).content
                sample = path
        except CanvasFileNotFoundError as exc:
            return f"Error: {exc}. Use list_canvas_files to see available files."
        except BinaryContentError:
            return f"Error: {path} is binary; export reads text canvas files (.html, .table.json)."

        exporter = exporter_for(sample, target, active_exporters)
        if exporter is None:
            available = sorted(
                {e.target for e in active_exporters if sample.lower().endswith(e.suffixes)}
            )
            hint = f" Formats available for this file: {', '.join(available)}." if available else ""
            return f"Error: no exporter turns {sample} into {target!r}.{hint}"
        try:
            exported = exporter.export(content, path=path)
        except MissingExporterDependencyError as exc:
            return f"Error: {exc}"
        except ValueError as exc:
            return f"Error: {exc}"

        out_path = f"exports/{exported.filename}"
        commit = store.write_bytes(
            canvas_id,
            out_path,
            exported.data,
            f"Export {path} -> {exported.filename}",
            actor="agent",
        )
        return (
            f"Exported {path} to {out_path} ({len(exported.data)} bytes, revision "
            f"{commit.revision}). The user can download it from the canvas file list."
        )

    return export_canvas
