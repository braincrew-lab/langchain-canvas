"""langchain_canvas — turn a LangChain agent's tools into a live React canvas.

Public surface:

    from langchain_canvas import Canvas, create_canvas_agent, sse_from_agent

* ``Canvas``               — the API tools use to open/stream artifacts.
* ``create_canvas_agent``  — ``create_agent`` plus canvas guidance.
* ``sse_from_agent``       — turn an agent run into a Canvas Wire Protocol SSE stream.

The wire types live under ``langchain_canvas.protocol`` and mirror the TypeScript
definitions in ``@braincrew-lab/langchain-canvas``.
"""

from .agent import create_canvas_agent
from .emitter import Canvas, ChartHandle, DocumentHandle, SlidesHandle, TableHandle
from .streaming.sse import sse_from_agent

__all__ = [
    "Canvas",
    "DocumentHandle",
    "ChartHandle",
    "TableHandle",
    "SlidesHandle",
    "create_canvas_agent",
    "sse_from_agent",
]

__version__ = "0.1.0"
