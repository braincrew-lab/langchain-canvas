"""Artifact data shapes — the payloads a canvas renderer knows how to draw.

Mirror of `packages/canvas-react/src/protocol/artifacts.ts`. Keep the two in
lockstep: a field added here must be added there, and vice versa.

An `Artifact` is transport-agnostic: it is just `{ id, type, title, version,
status, data }`. The `type` string is a registry key that the frontend resolves
to a React component; `data` is the type-specific payload that component reads.
"""

from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

ArtifactStatus = Literal["streaming", "complete", "error"]


class _CamelModel(BaseModel):
    """Base: declare fields in snake_case, serialize to camelCase on the wire."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# --- type-specific data payloads -------------------------------------------------


class HtmlData(_CamelModel):
    """The base substrate: raw HTML rendered in a sandboxed iframe.

    Everything a canvas shows is ultimately HTML; `document` / `chart` / `table`
    are structured conveniences, while `html` lets an agent emit an arbitrary
    self-contained page (the Claude-Artifacts / Genspark model).
    """

    html: str = ""


class DocumentData(_CamelModel):
    """A long-form markdown document (reports, drafts, explanations)."""

    format: Literal["markdown"] = "markdown"
    content: str = ""


class ChartSeries(_CamelModel):
    """One plotted series, keyed to a column in `ChartData.rows`."""

    key: str
    label: str | None = None
    color: str | None = None


class ChartOptions(_CamelModel):
    stacked: bool = False
    y_label: str | None = None  # serialized as `yLabel`
    colors: list[str] | None = None  # per-slice colors for pie charts


class ChartData(_CamelModel):
    """A chart over tidy (long-form) rows.

    `rows` are records; `x_key` (wire: `xKey`) names the category column; each
    `series` names a numeric column to plot. This mirrors what charting
    libraries (Recharts, Visx) consume directly, so the renderer stays a thin
    adapter.
    """

    chart: Literal["line", "bar", "area", "pie"]
    rows: list[dict[str, Union[str, int, float]]] = Field(default_factory=list)
    x_key: str  # serialized as `xKey`
    series: list[ChartSeries] = Field(default_factory=list)
    options: ChartOptions | None = None


class TableColumn(_CamelModel):
    key: str
    label: str | None = None
    align: Literal["left", "right", "center"] | None = None


class TableData(_CamelModel):
    """A data grid over tidy rows, keyed by column.

    Agents emit ``columns`` + ``rows``. ``sheet`` is an opaque spreadsheet state
    (Fortune-sheet) written back by the frontend after interactive edits (merges,
    fonts, formats, formulas); agents normally leave it unset.
    """

    columns: list[TableColumn] = Field(default_factory=list)
    rows: list[dict[str, Union[str, int, float]]] = Field(default_factory=list)
    sheet: list[dict[str, object]] | None = None


class SlideElement(_CamelModel):
    id: str
    type: Literal["text", "image"]
    x: float
    y: float
    w: float
    h: float
    text: str | None = None
    src: str | None = None
    font_size: float | None = None
    bold: bool | None = None
    color: str | None = None
    align: Literal["left", "center", "right"] | None = None


class Slide(_CamelModel):
    layout: Literal["title", "content", "section", "image", "two-column", "blank"] | None = None
    elements: list[SlideElement] = Field(default_factory=list)
    title: str | None = None
    subtitle: str | None = None
    bullets: list[str] = Field(default_factory=list)
    bullets2: list[str] = Field(default_factory=list)
    image: str | None = None
    background: str | None = None
    text_color: str | None = None
    notes: str | None = None


class SlidesData(_CamelModel):
    """A slide deck; renders as an HTML deck and exports to .pptx."""

    slides: list[Slide] = Field(default_factory=list)


# The union of every known artifact data shape. `data` on the wire is one of
# these; the discriminator lives on the enclosing `Artifact.type`.
ArtifactData = Union[HtmlData, DocumentData, ChartData, TableData, SlidesData]


# --- the envelope every artifact shares -----------------------------------------


class Artifact(_CamelModel):
    """A unit of canvas content, identified by a stable `id`.

    `id` is the reconciliation key: re-emitting the same `id` mutates the
    existing artifact rather than creating a new one. `version` starts at 1 and
    is bumped by the emitter on every full replace.
    """

    id: str
    type: str
    title: str
    version: int = 1
    status: ArtifactStatus = "streaming"
    data: dict[str, Any]
    meta: dict[str, Any] | None = None


ArtifactType = Literal["html", "document", "chart", "table", "slides"]
