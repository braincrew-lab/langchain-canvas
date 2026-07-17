"""The ergonomic API a tool author uses to drive the canvas.

A tool never touches the wire protocol. It grabs a `Canvas` from its runtime and
opens artifacts; the handles it gets back stream content in and mark completion:

    from langchain_canvas import Canvas
    from langchain.tools import tool, ToolRuntime

    @tool
    def write_report(topic: str, runtime: ToolRuntime) -> str:
        \"\"\"Write a markdown report and show it on the canvas.\"\"\"
        canvas = Canvas.from_runtime(runtime)
        doc = canvas.open_document(title=f"Report: {topic}")
        for chunk in generate_markdown(topic):   # any iterator of str
            doc.append(chunk)                     # streams into the panel live
        doc.complete()
        return f"Drafted a report on {topic} in the canvas."

All the envelope construction, the `append`-vs-`patch` decision, and version
bumping live here — so the wire protocol can evolve without changing a single
tool.
"""

from __future__ import annotations

from typing import Any, Iterable, Protocol
from uuid import uuid4

from .protocol.artifacts import Artifact, ChartSeries, Slide, TableColumn
from .protocol.events import (
    CanvasAppend,
    CanvasCreate,
    CanvasNodePatch,
    CanvasPatch,
    CanvasReplace,
    CanvasStatus,
    _Event,
)


class StreamWriter(Protocol):
    """The `Callable[[Any], None]` LangGraph injects as `runtime.stream_writer`."""

    def __call__(self, chunk: Any) -> None: ...


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


class Canvas:
    """Factory for artifact handles, bound to one agent run's stream writer.

    When constructed without a writer (e.g. a tool invoked as a plain function
    in a unit test), every emission is a silent no-op, so tools stay callable
    outside a LangGraph execution context.
    """

    def __init__(self, writer: StreamWriter | None) -> None:
        self._writer = writer

    @classmethod
    def from_runtime(cls, runtime: Any) -> "Canvas":
        """Build from an injected `ToolRuntime` (or anything with a writer)."""
        return cls(getattr(runtime, "stream_writer", None))

    def open_html(self, title: str, *, id: str | None = None) -> "HtmlHandle":
        """Open a raw-HTML artifact — the base substrate, rendered sandboxed.

        Use for self-contained pages / apps the agent authors directly. Stream
        markup in with ``append(...)`` or set it in one shot with ``set_html``.
        """
        artifact = Artifact(id=id or _new_id("page"), type="html", title=title, data={"html": ""})
        self._emit(CanvasCreate(artifact=artifact))
        return HtmlHandle(self, artifact)

    def html(self, artifact_id: str) -> "HtmlHandle":
        """Bind a handle to an *existing* html artifact for targeted edits.

        Unlike ``open_html``, this emits no ``create`` — call ``set_html`` on the
        returned handle to patch the page in place (same id → same panel).
        """
        artifact = Artifact(id=artifact_id, type="html", title="", data={"html": ""})
        return HtmlHandle(self, artifact)

    def open_slides(
        self,
        title: str,
        *,
        slides: list[Slide] | list[dict[str, Any]] | None = None,
        id: str | None = None,
    ) -> "SlidesHandle":
        """Open a slide deck — renders as an HTML deck, exports to .pptx."""
        norm = [s.model_dump(exclude_none=True) if isinstance(s, Slide) else s for s in (slides or [])]
        artifact = Artifact(id=id or _new_id("deck"), type="slides", title=title, data={"slides": norm})
        self._emit(CanvasCreate(artifact=artifact))
        return SlidesHandle(self, artifact)

    def open_document(self, title: str, *, id: str | None = None) -> "DocumentHandle":
        artifact = Artifact(
            id=id or _new_id("doc"),
            type="document",
            title=title,
            data={"format": "markdown", "content": ""},
        )
        self._emit(CanvasCreate(artifact=artifact))
        return DocumentHandle(self, artifact)

    def open_chart(
        self,
        title: str,
        *,
        chart: str,
        x_key: str,
        series: list[ChartSeries] | list[dict[str, Any]],
        rows: list[dict[str, Any]] | None = None,
        id: str | None = None,
    ) -> "ChartHandle":
        norm_series = [
            s.model_dump(exclude_none=True) if isinstance(s, ChartSeries) else s
            for s in series
        ]
        artifact = Artifact(
            id=id or _new_id("chart"),
            type="chart",
            title=title,
            data={
                "chart": chart,
                "xKey": x_key,
                "series": norm_series,
                "rows": rows or [],
            },
        )
        self._emit(CanvasCreate(artifact=artifact))
        return ChartHandle(self, artifact)

    def open_table(
        self,
        title: str,
        *,
        columns: list[TableColumn] | list[dict[str, Any]],
        rows: list[dict[str, Any]] | None = None,
        id: str | None = None,
    ) -> "TableHandle":
        norm_columns = [
            c.model_dump(exclude_none=True) if isinstance(c, TableColumn) else c
            for c in columns
        ]
        artifact = Artifact(
            id=id or _new_id("table"),
            type="table",
            title=title,
            data={"columns": norm_columns, "rows": rows or []},
        )
        self._emit(CanvasCreate(artifact=artifact))
        return TableHandle(self, artifact)

    # -- internals ---------------------------------------------------------------

    def _emit(self, event: _Event) -> None:
        if self._writer is not None:
            self._writer(event.model_dump(by_alias=True, exclude_none=True))


class _Handle:
    """Shared behaviour for artifact handles: identity + lifecycle transitions."""

    def __init__(self, canvas: Canvas, artifact: Artifact) -> None:
        self._canvas = canvas
        self._artifact = artifact

    @property
    def id(self) -> str:
        return self._artifact.id

    def complete(self) -> None:
        self._canvas._emit(CanvasStatus(id=self.id, status="complete"))

    def error(self) -> None:
        self._canvas._emit(CanvasStatus(id=self.id, status="error"))


class HtmlHandle(_Handle):
    """A raw-HTML artifact. Stream markup with ``append`` or replace it whole."""

    def append(self, html: str) -> "HtmlHandle":
        self._canvas._emit(CanvasAppend(id=self.id, path="html", text=html))
        return self

    def set_html(self, html: str) -> "HtmlHandle":
        self._canvas._emit(CanvasPatch(id=self.id, patch={"html": html}))
        return self

    def patch_node(self, cid: str, html: str) -> "HtmlHandle":
        """Surgically replace one element (by `data-cid`) — an O(1) edit."""
        self._canvas._emit(CanvasNodePatch(id=self.id, cid=cid, html=html))
        return self


class DocumentHandle(_Handle):
    """A live markdown document. Append tokens as they are produced."""

    def append(self, text: str) -> "DocumentHandle":
        self._canvas._emit(CanvasAppend(id=self.id, path="content", text=text))
        return self

    def stream(self, chunks: Iterable[str]) -> "DocumentHandle":
        for chunk in chunks:
            self.append(chunk)
        return self

    def replace(self, content: str) -> "DocumentHandle":
        """Publish a new version of the whole document (bumps `version`)."""
        self._artifact = self._artifact.model_copy(
            update={"version": self._artifact.version + 1, "data": {"format": "markdown", "content": content}}
        )
        self._canvas._emit(CanvasReplace(id=self.id, artifact=self._artifact))
        return self


class ChartHandle(_Handle):
    """A chart whose rows/series can be filled in progressively."""

    def set_rows(self, rows: list[dict[str, Any]]) -> "ChartHandle":
        self._canvas._emit(CanvasPatch(id=self.id, patch={"rows": rows}))
        return self

    def patch(self, **data: Any) -> "ChartHandle":
        self._canvas._emit(CanvasPatch(id=self.id, patch=data))
        return self


class TableHandle(_Handle):
    """A data grid whose rows can be filled in progressively."""

    def set_rows(self, rows: list[dict[str, Any]]) -> "TableHandle":
        self._canvas._emit(CanvasPatch(id=self.id, patch={"rows": rows}))
        return self


class SlidesHandle(_Handle):
    """A slide deck whose slides can be filled in progressively."""

    def set_slides(self, slides: list[Slide] | list[dict[str, Any]]) -> "SlidesHandle":
        norm = [s.model_dump(exclude_none=True) if isinstance(s, Slide) else s for s in slides]
        self._canvas._emit(CanvasPatch(id=self.id, patch={"slides": norm}))
        return self
