"""langchain_canvas — turn a LangChain agent's tools into a live React canvas.

Public surface:

    from langchain_canvas import Canvas, create_canvas_agent, sse_from_agent

* ``Canvas``               — the API tools use to open/stream artifacts.
* ``create_canvas_agent``  — ``create_agent`` plus canvas guidance.
* ``create_canvas_tools``  — the standard persistent-canvas tools
  (``read/write/edit_canvas`` + ``list_canvas_files``) bound to a ``CanvasStore``.
* ``create_export_tool``   — the ``export_canvas`` tool (canvas files → office
  formats under ``exports/``), pluggable through ``Exporter``.
* ``create_document_tools``— editing an uploaded Word file in place (copy it out
  of ``sources/``, add / remove a paragraph, swap a picture).
* ``create_deck_tools``    — copying an uploaded .pptx into an editable deck.
* ``create_table_tools``   — writing a spreadsheet by address (put values or
  formulas in named cells of a named sheet, add a sheet).
* ``sse_from_agent``       — turn an agent run into a Canvas Wire Protocol SSE stream.
* ``hydrate_events``       — replay a stored canvas as wire events for reloads.
* ``encode_table``         — the ``.table.json`` file content for a table artifact.

The wire types live under ``langchain_canvas.protocol`` and mirror the TypeScript
definitions in ``@braincrew-lab/langchain-canvas``. Persistence backends live
under ``langchain_canvas.store``.
"""

from .agent import create_canvas_agent
from .assets import ASSET_REFERENCE_PREFIXES, inline_canvas_assets
from .converters import ConvertedSource, PageRenderable, SourceConverter, default_converters
from .emitter import Canvas, ChartHandle, DeckHandle, DocumentHandle, TableHandle
from .exporters import ExportedFile, Exporter, default_exporters
from .formulas import SUPPORTED_FORMULA_FUNCTIONS, formula_guidance
from .history_repair import repair_orphaned_tool_calls, repair_tool_history
from .replay import (
    encode_artifact,
    encode_chart,
    encode_table,
    hydrate_events,
    source_preview_events,
    workbook_working_copy,
)
from .state import canvas_now, last_change_line
from .store import CanvasStore, FileCanvasStore, InMemoryCanvasStore
from .streaming.sse import sse_from_agent
from .tools import (
    create_asset_tool,
    create_canvas_tools,
    create_check_table_tool,
    create_deck_tools,
    create_document_tools,
    create_export_tool,
    create_table_tools,
)

__all__ = [
    "repair_orphaned_tool_calls",
    "repair_tool_history",
    "canvas_now",
    "last_change_line",
    "ASSET_REFERENCE_PREFIXES",
    "Canvas",
    "SUPPORTED_FORMULA_FUNCTIONS",
    "CanvasStore",
    "ConvertedSource",
    "DeckHandle",
    "DocumentHandle",
    "ExportedFile",
    "Exporter",
    "FileCanvasStore",
    "ChartHandle",
    "InMemoryCanvasStore",
    "PageRenderable",
    "SourceConverter",
    "TableHandle",
    "create_asset_tool",
    "create_canvas_agent",
    "create_canvas_tools",
    "create_check_table_tool",
    "create_deck_tools",
    "create_document_tools",
    "create_export_tool",
    "create_table_tools",
    "default_converters",
    "default_exporters",
    "encode_artifact",
    "encode_chart",
    "encode_table",
    "formula_guidance",
    "hydrate_events",
    "inline_canvas_assets",
    "source_preview_events",
    "workbook_working_copy",
    "sse_from_agent",
]

__version__ = "0.1.0"
