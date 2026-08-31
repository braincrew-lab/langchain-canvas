"""Strict, bounded arguments for source-style deck operations."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .deck_editing_models import StylePatch

Identifier = Annotated[str, Field(min_length=1, max_length=200)]
Text = Annotated[str, Field(max_length=100000)]
SlideIds = Annotated[list[Identifier], Field(min_length=1, max_length=200)]
Role = Literal["title", "body", "bullet", "table", "chart", "image", "text"]


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class DeckRead(StrictInput):
    path: Annotated[str, Field(min_length=1, max_length=1000)]
    slide_ids: SlideIds | None = None

    @field_validator("slide_ids")
    @classmethod
    def unique_slides(cls, value):
        if value is not None and len(value) != len(set(value)):
            raise ValueError("Slide IDs must be distinct.")
        return value


class SlotRequest(StrictInput):
    key: Identifier
    role: Role
    slide_id: Identifier | None = None
    node_id: Identifier | None = None
    text: Text | None = None


class MapInput(DeckRead):
    requests: Annotated[list[SlotRequest], Field(max_length=200)] | None = None


class CellReplacement(StrictInput):
    text: Text | None = None
    slots: Annotated[list[Text], Field(max_length=1000)] | None = None

    @model_validator(mode="after")
    def exactly_one(self):
        if (self.text is None) == (self.slots is None):
            raise ValueError("Each cell needs exactly one of text or rich slots.")
        return self


class SlideWrite(StrictInput):
    path: Annotated[str, Field(min_length=1, max_length=1000)]
    slide_id: Identifier
    revision: Identifier
    node_id: Identifier
    dry_run: bool = False


class TableInput(SlideWrite):
    rows: Annotated[
        list[Annotated[list[CellReplacement], Field(min_length=1, max_length=50)]],
        Field(min_length=1, max_length=200),
    ]

    @model_validator(mode="after")
    def total_budget(self):
        cells = [cell for row in self.rows for cell in row]
        if (
            len(cells) > 2000
            or sum(
                len(cell.text or "") + sum(map(len, cell.slots or [])) for cell in cells
            )
            > 100000
        ):
            raise ValueError("Table input exceeds 2,000 cells or 100,000 characters.")
        return self


class ChartSeries(StrictInput):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    values: Annotated[
        list[Annotated[float, Field(strict=True, ge=-1e12, le=1e12)]],
        Field(min_length=1, max_length=50),
    ]


class ChartInput(SlideWrite):
    categories: Annotated[
        list[Annotated[str, Field(max_length=200)]], Field(min_length=1, max_length=50)
    ]
    series: Annotated[list[ChartSeries], Field(min_length=1, max_length=8)]

    @model_validator(mode="after")
    def matching_values(self):
        if any(len(series.values) != len(self.categories) for series in self.series):
            raise ValueError("Every series must have one value per category.")
        return self


class ThemeMapping(StrictInput):
    property: Literal["color", "background-color", "border-color", "font-family"]
    source: Annotated[str, Field(min_length=1, max_length=200)]
    target: Annotated[str, Field(min_length=1, max_length=200)]

    @model_validator(mode="after")
    def safe_values(self):
        field = self.property.replace("-", "_")
        StylePatch.model_validate({field: self.source})
        StylePatch.model_validate({field: self.target})
        return self


class ThemeInput(DeckRead):
    revision: Identifier
    mappings: Annotated[list[ThemeMapping], Field(min_length=1, max_length=30)]
    dry_run: bool = False


class ExpectedText(StrictInput):
    slide_id: Identifier
    node_id: Identifier
    text: Text


class ExpectedChart(StrictInput):
    slide_id: Identifier
    node_id: Identifier
    categories: Annotated[
        list[Annotated[str, Field(max_length=200)]], Field(min_length=1, max_length=50)
    ]
    series: Annotated[list[ChartSeries], Field(min_length=1, max_length=8)]


class VerifyInput(DeckRead):
    expected_charts: Annotated[list[ExpectedChart], Field(max_length=200)] | None = None
    baseline_revision: Identifier | None = None
    expected_text: Annotated[list[ExpectedText], Field(max_length=2000)] | None = None
    allowed_style_properties: (
        Annotated[list[Identifier], Field(max_length=30)] | None
    ) = None


class RepairTarget(StrictInput):
    slide_id: Identifier
    node_id: Identifier


class RepairInput(StrictInput):
    path: Annotated[str, Field(min_length=1, max_length=1000)]
    revision: Identifier
    targets: (
        Annotated[list[RepairTarget], Field(min_length=1, max_length=20)] | None
    ) = None
    min_font_size: Annotated[float, Field(ge=6, le=300)] = 12
    max_shrink: Annotated[float, Field(ge=0, le=0.5)] = 0.25
    dry_run: bool = False
