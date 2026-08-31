"""Bounded schemas for deterministic slide editing inputs."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StylePatch(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    color: str | None = None
    background_color: str | None = None
    font_family: str | None = None
    font_size: Annotated[float, Field(ge=6, le=300)] | None = None
    font_weight: Annotated[int, Field(ge=100, le=900)] | None = None
    text_align: Literal["left", "center", "right", "justify"] | None = None
    border_color: str | None = None
    border_width: Annotated[float, Field(ge=0, le=50)] | None = None
    border_radius: Annotated[float, Field(ge=0, le=1000)] | None = None
    opacity: Annotated[float, Field(ge=0, le=1)] | None = None

    @field_validator("color", "background_color", "font_family", "border_color")
    @classmethod
    def safe_css_value(cls, value):
        if value is not None and (
            len(value) > 200
            or any(c in value for c in ";{}<>\\@")
            or any(
                s in value.lower() for s in ("url(", "expression(", "/*", "!important")
            )
        ):
            raise ValueError("Use a single safe CSS value, never declarations or URLs.")
        return value

    @field_validator("color", "background_color", "border_color")
    @classmethod
    def valid_color(cls, value):
        if value is not None and value.lower() != "transparent":
            from PIL import ImageColor

            try:
                ImageColor.getrgb(value)
            except ValueError as exc:
                raise ValueError(
                    "Use a valid named, hex, rgb() or hsl() color."
                ) from exc
        return value


class ElementBox(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    node_id: Annotated[str, Field(min_length=1, max_length=200)]
    x: Annotated[float, Field(ge=0, le=20000)] | None = None
    y: Annotated[float, Field(ge=0, le=20000)] | None = None
    width: Annotated[float, Field(gt=0, le=20000)] | None = None
    height: Annotated[float, Field(gt=0, le=20000)] | None = None
