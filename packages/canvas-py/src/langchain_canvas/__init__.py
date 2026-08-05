"""langchain_canvas — turn a LangChain agent's tools into a live React canvas.

Public surface:

    from langchain_canvas import Canvas, create_canvas_agent, sse_from_agent

* ``Canvas``               — the API tools use to open/stream artifacts.
* ``create_canvas_agent``  — ``create_agent`` plus canvas guidance.
* ``create_canvas_tools``  — the standard persistent-canvas tools
  (``read/write/edit_canvas`` + ``list_canvas_files``) bound to a ``CanvasStore``.
* ``create_export_tool``   — the ``export_canvas`` tool (canvas files → office
  formats under ``exports/``), pluggable through ``Exporter``.
* ``sse_from_agent``       — turn an agent run into a Canvas Wire Protocol SSE stream.
* ``hydrate_events``       — replay a stored canvas as wire events for reloads.
* ``encode_table``         — the ``.table.json`` file content for a table artifact.

The wire types live under ``langchain_canvas.protocol`` and mirror the TypeScript
definitions in ``@braincrew-lab/langchain-canvas``. Persistence backends live
under ``langchain_canvas.store``.
"""

from .agent import create_canvas_agent
from .converters import ConvertedSource, SourceConverter, default_converters
from .emitter import Canvas, ChartHandle, DocumentHandle, SlidesHandle, TableHandle
from .exporters import ExportedFile, Exporter, default_exporters
from .replay import encode_table, hydrate_events
from .store import CanvasStore, FileCanvasStore, InMemoryCanvasStore
from .streaming.sse import sse_from_agent
from .tools import create_canvas_tools, create_export_tool

__all__ = [
    "Canvas",
    "CanvasStore",
    "ConvertedSource",
    "DocumentHandle",
    "ExportedFile",
    "Exporter",
    "FileCanvasStore",
    "ChartHandle",
    "InMemoryCanvasStore",
    "SourceConverter",
    "TableHandle",
    "SlidesHandle",
    "create_canvas_agent",
    "create_canvas_tools",
    "create_export_tool",
    "default_converters",
    "default_exporters",
    "encode_table",
    "hydrate_events",
    "sse_from_agent",
]

__version__ = "0.1.0"
