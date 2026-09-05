"""Artifact data shapes — the payloads a canvas renderer knows how to draw.

Mirror of `packages/canvas-react/src/protocol/artifacts.ts`. Keep the two in
lockstep: a field added here must be added there, and vice versa.

An `Artifact` is transport-agnostic: it is just `{ id, type, title, version,
status, data }`. The `type` string is a registry key that the frontend resolves
to a React component; `data` is the type-specific payload that component reads.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
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
    title: str | None = None  # chart title shown above the plot
    colors: list[str] | None = None  # per-slice colors for pie charts


class ChartData(_CamelModel):
    """A chart over tidy (long-form) rows.

    `rows` are records; `x_key` (wire: `xKey`) names the category column; each
    `series` names a numeric column to plot. This mirrors what charting
    libraries (Recharts, Visx) consume directly, so the renderer stays a thin
    adapter.
    """

    chart: Literal["line", "bar", "area", "pie"]
    rows: list[dict[str, str | int | float]] = Field(default_factory=list)
    x_key: str  # serialized as `xKey`
    series: list[ChartSeries] = Field(default_factory=list)
    options: ChartOptions | None = None
    # Raw ECharts `option`, rendered verbatim when present — an escape hatch for
    # emitters that already produce a full ECharts config (the tidy rows/series
    # model is ignored, and inline editing is disabled). Wire: `echartsOption`.
    echarts_option: dict[str, Any] | None = None


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
    rows: list[dict[str, str | int | float]] = Field(default_factory=list)
    sheet: list[dict[str, object]] | None = None


class SlideTableCell(_CamelModel):
    """One table cell's own look, where it differs from the table's.

    The cell's text lives in the table element's ``rows``; this carries only
    what that cell does differently — a header fill, a bold total, a span —
    so a table of forty plain cells stays forty strings.
    """

    r: int = Field(ge=0)
    c: int = Field(ge=0)
    fill: str | None = None
    color: str | None = None
    bold: bool | None = None
    align: Literal["left", "center", "right"] | None = None
    font_size: float | None = Field(default=None, gt=0)
    col_span: int | None = Field(default=None, ge=1)
    row_span: int | None = Field(default=None, ge=1)


class SlideElement(_CamelModel):
    id: str
    type: Literal["text", "image", "shape", "table"]
    x: float
    y: float
    w: float
    h: float
    # Clockwise rotation in degrees about the box centre, the way PowerPoint
    # stores it. Absent means 0 (unrotated); the renderer and exporter both
    # treat a missing value as no rotation.
    rotation: float | None = None
    text: str | None = None
    src: str | None = None
    font_size: float | None = None
    bold: bool | None = None
    color: str | None = None
    align: Literal["left", "center", "right"] | None = None
    shape: Literal["rect", "ellipse", "line"] | None = None  # for `type: "shape"`
    # Fill (rect/ellipse) or stroke (line) colour — "#rrggbb", or "none" for a
    # shape that is explicitly unfilled (a border-only frame). "none" and
    # absent are different words: absent means unsaid, and the canvas draws
    # nothing rather than guessing a colour.
    fill: str | None = None
    # A shape can be drawn by its outline alone — an empty box around content is
    # a common annotation, and with only `fill` it renders as nothing at all.
    stroke: str | None = None  # outline color, independent of fill
    stroke_width: float | None = Field(default=None, ge=0)  # outline weight in px
    # Text metrics the box cannot imply. Without the face, line breaks land in
    # different places than the file they came from.
    font_family: str | None = None
    line_height: float | None = Field(default=None, gt=0)  # multiple of font size
    vertical_align: Literal["top", "middle", "bottom"] | None = None
    # A highlighted heading reads as a coloured band behind the words; without
    # it the band disappears and the heading looks like ordinary text.
    highlight: str | None = None
    space_before: float | None = Field(default=None, ge=0)  # px above the text
    space_after: float | None = Field(default=None, ge=0)  # px below the text
    # What happens when the words outgrow the box, the way PowerPoint's
    # autofit settles it: `shape` grows the box to hold the text, `text`
    # shrinks the type to stay inside, `none` (the default) does neither and
    # the deck check names the overflow. Four in ten text boxes of the decks
    # people upload grow with their text; without this field every one of
    # them arrived frozen at the height of its placeholder.
    autofit: Literal["shape", "text", "none"] | None = None
    # False for a box PowerPoint never wraps (bodyPr wrap="none") — a one-line
    # label that folds on the canvas is the fastest way an import stops
    # looking like its original. Absent means the text wraps, as ever.
    wrap: bool | None = None
    # A table (`type: "table"`): the words as a grid of strings, row-major,
    # and the table's look in the fields above (`stroke` draws the grid,
    # `fill` / `color` / `fontSize` / `fontFamily` / `bold` / `align` are the
    # cells' defaults). Column widths and row heights are percent of the
    # table's own box; absent means equal shares. `cells` holds what single
    # cells do differently. Sixteen boxes stood in for a table before, and a
    # column could not be widened without moving eight of them.
    rows: list[list[str]] | None = None
    header: bool | None = None  # the first row is a header row
    col_widths: list[float] | None = None
    row_heights: list[float] | None = None
    cells: list[SlideTableCell] | None = None

    @model_validator(mode="after")
    def _table_has_a_grid(self) -> SlideElement:
        if self.type != "table":
            return self
        rows = self.rows or []
        if not rows or not rows[0]:
            raise ValueError('a "table" element needs "rows": a non-empty list of rows of strings')
        width = len(rows[0])
        if any(len(row) != width for row in rows):
            raise ValueError('every row of a "table" element needs the same number of cells')
        return self


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
    # Display-only: the original deck's master/layout rendered as this
    # slide's backdrop (an assets/ path, set by the importer) — the logo and
    # footer PowerPoint keeps out of reach on the slide itself. Drawn behind
    # the elements on the canvas; the pptx exporter ignores it because the
    # template skin already carries the real master. Leave it as it is.
    master_image: str | None = None
    # Content padding as a percent of the slide width — a safe margin around the
    # free canvas, applied in the editor, present view, thumbnails, and export.
    # Bounded below 50: at 50 the content span (1 - 2*pad) hits zero, past it
    # coordinates flip — there is no valid deck in that range.
    padding: float | None = Field(default=None, ge=0, lt=50)


class SlidePage(_CamelModel):
    """The deck's page size in inches — the coordinate space percent
    geometry refers to. Absent means the classic 16:9 canvas (10 x 5.625).
    When a template skin is attached, tools fill this with the skin's real
    page so the editor, the preview, and the exported file agree on one
    aspect ratio."""

    width_in: float = Field(gt=0)
    height_in: float = Field(gt=0)


class SlidesData(_CamelModel):
    """A slide deck; renders as an HTML deck and exports to .pptx."""

    slides: list[Slide] = Field(default_factory=list)
    page: SlidePage | None = None
    # Optional pptx skin: a canvas reference (``sources/brand.pptx``) whose
    # master and layouts the pptx export builds on, so the original's logos,
    # backgrounds, and headers survive the trip. The canvas preview does not
    # render the skin — it applies at export time only. Missing or unreadable
    # skins degrade to the blank-layout export.
    template: str | None = None


class FileData(_CamelModel):
    """A stored canvas file shown as itself — a window onto the store, not a copy.

    ``path`` is the canvas-relative reference (``sources/photo.png``); the
    renderer resolves it against the host's asset endpoint for display and
    download, so the stored file stays the single truth. ``cover`` /
    ``excerpt`` / ``detail`` are *derived* previews (never stored): a small
    page-one image, a short text sample, and a one-line content summary —
    whichever the installed converters can honestly produce.
    """

    path: str
    name: str
    media_type: str | None = None  # serialized as `mediaType`
    size: int | None = None
    cover: str | None = None  # data: URI thumbnail of page one (page-renderable sources)
    excerpt: str | None = None  # short text sample, via the source converter
    detail: str | None = None  # one-line content summary ("3 pages", "5 slides")


# The union of every known artifact data shape. `data` on the wire is one of
# these; the discriminator lives on the enclosing `Artifact.type`.
ArtifactData = HtmlData | DocumentData | ChartData | TableData | SlidesData | FileData


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


ArtifactType = Literal["html", "document", "chart", "table", "slides", "file"]
