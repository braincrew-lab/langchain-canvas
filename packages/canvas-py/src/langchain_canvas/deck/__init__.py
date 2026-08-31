"""The canonical ``*.slides.html`` deck dialect: parse, validate, sanitize."""

from __future__ import annotations

from .baseline import baseline_slide_html
from .export import DeckPptxExporter, RenderSlideAdapter, percent_box_to_inches, skin_presentation
from .extract import (
    ImageAsset,
    PptxImportError,
    ShapeGeom,
    SlideExtraction,
    TextRun,
    extract_slides,
    extracted_text,
)
from .model import (
    DECK_DIALECT_VERSION,
    SLIDES_HTML_SUFFIX,
    Deck,
    DeckParseError,
    SlideTemplate,
    parse_deck,
    patch_slide,
    read_slide,
    reorder_slides,
    serialize_deck,
)
from .sanitize import (
    ALLOWED_ATTRS,
    ALLOWED_CSS_PROPS,
    ALLOWED_TAGS,
    ALLOWED_URL_SCHEMES,
    SanitizeResult,
    sanitize_slide_html,
)
from .template_metadata import TemplateMetadataError, validate_template_metadata
from .validate import (
    DeckIssue,
    TextIntegrityError,
    ensure_text_equality,
    format_layout_warnings,
    validate_deck,
    validate_slide_html,
)

__all__ = [
    "ALLOWED_ATTRS",
    "ALLOWED_CSS_PROPS",
    "ALLOWED_TAGS",
    "ALLOWED_URL_SCHEMES",
    "DECK_DIALECT_VERSION",
    "SLIDES_HTML_SUFFIX",
    "Deck",
    "DeckIssue",
    "DeckParseError",
    "DeckPptxExporter",
    "ImageAsset",
    "PptxImportError",
    "RenderSlideAdapter",
    "SanitizeResult",
    "ShapeGeom",
    "SlideExtraction",
    "SlideTemplate",
    "TemplateMetadataError",
    "TextIntegrityError",
    "TextRun",
    "baseline_slide_html",
    "ensure_text_equality",
    "extract_slides",
    "extracted_text",
    "format_layout_warnings",
    "parse_deck",
    "patch_slide",
    "percent_box_to_inches",
    "read_slide",
    "reorder_slides",
    "sanitize_slide_html",
    "serialize_deck",
    "skin_presentation",
    "validate_deck",
    "validate_slide_html",
    "validate_template_metadata",
]
