"""The canonical deck dialect — one ``*.slides.html`` file per presentation.

A deck is a single HTML document. Its ``<body>`` holds one ``<template
data-slide-id="...">`` per slide; browsers never render ``<template>``
content, so the document is inert until a client picks a slide, clones its
template, and mounts it. That keeps the store's source of truth text-native
(diffable, greppable, editable in place) instead of a JSON envelope wrapping
markup.

:func:`parse_deck` / :func:`serialize_deck` round-trip a :class:`Deck`.
:func:`read_slide` / :func:`patch_slide` / :func:`reorder_slides` operate at
slide granularity so a one-slide edit never rewrites bytes belonging to any
other slide — important once two slides share byte-identical markup (a
duplicated template), where matching has to key off ``data-slide-id``, not
content.

Parsing uses :mod:`html.parser` (the same library `exporters.py::_HtmlOutline`
already relies on) rather than a new runtime dependency. ``<template>``
content is not a special case for :class:`html.parser.HTMLParser` — unlike a
browser's ``DOMParser``, it emits the normal start/end tag events for
everything inside a ``<template>``, so this module descends into it
explicitly instead of treating it as opaque, keeping the contract accurate
even though today's stdlib behavior does not require extra code for it.
"""

from __future__ import annotations

import html as html_lib
import json
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

from .template_metadata import MAX_METADATA_BYTES

SLIDES_HTML_SUFFIX = ".slides.html"
DECK_DIALECT_VERSION = "1"

_SOURCE_META_NAME = "lcx:source"
_TEMPLATE_META_NAME = "lcx:template"


class DeckParseError(ValueError):
    """Deck HTML that does not parse into a well-formed :class:`Deck`."""


@dataclass(frozen=True)
class SlideTemplate:
    """One slide's ``<template>`` contents.

    ``body_html`` is the slide markup as written (minus its ``<style>``
    block, if any) — exact bytes, not a re-serialization, so patching one
    slide never perturbs another slide's whitespace or attribute order.
    """

    slide_id: str
    title: str | None
    style_css: str
    body_html: str


@dataclass(frozen=True)
class Deck:
    """A parsed deck: document-level metadata plus its slides in order."""

    title: str
    ratio: str
    source: str | None
    slides: list[SlideTemplate] = field(default_factory=list)
    template: dict | None = None


@dataclass(frozen=True)
class _SlideSpan:
    """Byte offsets of one top-level ``<template>`` within its deck HTML."""

    slide_id: str
    outer_start: int
    outer_end: int


def _attr_map(attrs: list[tuple[str, str | None]]) -> dict[str, str | None]:
    return dict(attrs)


class _DeckParser(HTMLParser):
    """One pass over a deck document: metadata, slides, and their spans.

    Byte offsets come from :meth:`HTMLParser.getpos` (line, column), mapped
    to an absolute index via a precomputed line-offset table — the only way
    to recover exact source spans from the stdlib event-based parser.
    """

    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=True)
        self._source = source
        self._line_offsets = self._build_line_offsets(source)
        self.ratio = "16:9"
        self.title = ""
        self.source: str | None = None
        self.template: dict | None = None
        self.slides: list[SlideTemplate] = []
        self.spans: list[_SlideSpan] = []
        self._template_depth = 0
        self._template_attrs: dict[str, str | None] = {}
        self._template_outer_start: int | None = None
        self._template_inner_start: int | None = None
        self._capture_title = False
        self._title_chars: list[str] = []

    @staticmethod
    def _build_line_offsets(text: str) -> list[int]:
        offsets = [0]
        for line in text.splitlines(keepends=True):
            offsets.append(offsets[-1] + len(line))
        return offsets

    def _offset(self) -> int:
        line, col = self.getpos()
        return self._line_offsets[line - 1] + col

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.lower()
        attr_map = _attr_map(attrs)
        if lowered == "html":
            self.ratio = attr_map.get("data-ratio") or self.ratio
        elif lowered == "meta" and (attr_map.get("name") or "").lower() == _SOURCE_META_NAME:
            self.source = attr_map.get("content")
        elif lowered == "meta" and (attr_map.get("name") or "").lower() == _TEMPLATE_META_NAME:
            if self.template is not None:
                raise DeckParseError("deck HTML has duplicate lcx:template metadata")
            content = attr_map.get("content")
            if content is None:
                raise DeckParseError("lcx:template metadata is missing its content attribute")
            if len(content.encode("utf-8")) > MAX_METADATA_BYTES:
                raise DeckParseError(f"lcx:template metadata exceeds {MAX_METADATA_BYTES} bytes")
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError as exc:
                raise DeckParseError(f"lcx:template metadata is not valid JSON: {exc}") from exc
            if not isinstance(parsed, dict):
                raise DeckParseError("lcx:template metadata must be a JSON object")
            self.template = parsed
        elif lowered == "title" and self._template_depth == 0:
            self._capture_title = True
            self._title_chars = []
        elif lowered == "template":
            if self._template_depth == 0:
                self._template_attrs = attr_map
                self._template_outer_start = self._offset()
                raw_tag = self.get_starttag_text() or ""
                self._template_inner_start = self._template_outer_start + len(raw_tag)
            self._template_depth += 1

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if lowered == "title" and self._capture_title:
            self.title = "".join(self._title_chars).strip()
            self._capture_title = False
        elif lowered == "template" and self._template_depth > 0:
            self._template_depth -= 1
            if self._template_depth == 0 and self._template_inner_start is not None:
                inner_end = self._offset()
                outer_end = self._source.index(">", inner_end) + 1
                raw_content = self._source[self._template_inner_start : inner_end]
                slide = _build_slide(self._template_attrs, raw_content)
                self.slides.append(slide)
                assert self._template_outer_start is not None
                self.spans.append(_SlideSpan(slide.slide_id, self._template_outer_start, outer_end))
                self._template_outer_start = None
                self._template_inner_start = None
                self._template_attrs = {}

    def handle_data(self, data: str) -> None:
        if self._capture_title:
            self._title_chars.append(data)


_STYLE_RE = re.compile(r"^\s*<style(?:\s[^>]*)?>(.*?)</style>", re.IGNORECASE | re.DOTALL)


def _build_slide(attrs: dict[str, str | None], raw_content: str) -> SlideTemplate:
    slide_id = attrs.get("data-slide-id")
    if not slide_id:
        raise DeckParseError("<template> is missing a data-slide-id attribute")
    title = attrs.get("data-slide-title")
    match = _STYLE_RE.match(raw_content)
    if match:
        style_css = match.group(1).strip()
        body_html = raw_content[match.end() :].strip()
    else:
        style_css = ""
        body_html = raw_content.strip()
    return SlideTemplate(slide_id=slide_id, title=title, style_css=style_css, body_html=body_html)


def _run_parser(deck_html: str) -> _DeckParser:
    parser = _DeckParser(deck_html)
    parser.feed(deck_html)
    parser.close()
    if parser._template_outer_start is not None:
        raise DeckParseError("deck HTML has an unterminated <template> element")
    return parser


def parse_deck(deck_html: str) -> Deck:
    """Parse a ``*.slides.html`` document into a :class:`Deck`."""
    parser = _run_parser(deck_html)
    return Deck(
        title=parser.title,
        ratio=parser.ratio,
        source=parser.source,
        slides=list(parser.slides),
        template=parser.template,
    )


def _serialize_slide(slide: SlideTemplate) -> str:
    attrs = f' data-slide-id="{html_lib.escape(slide.slide_id, quote=True)}"'
    if slide.title:
        attrs += f' data-slide-title="{html_lib.escape(slide.title, quote=True)}"'
    parts = [f"<template{attrs}>"]
    if slide.style_css:
        parts.append(f"<style>{slide.style_css}</style>")
    parts.append(slide.body_html)
    parts.append("</template>")
    return "\n".join(parts)


def serialize_deck(deck: Deck) -> str:
    """Canonical HTML text for ``deck`` — the form :func:`parse_deck` re-reads."""
    lines = [
        "<!DOCTYPE html>",
        f'<html data-lcx-dialect="{DECK_DIALECT_VERSION}" data-ratio="'
        f'{html_lib.escape(deck.ratio, quote=True)}">',
        "<head>",
        '<meta charset="utf-8">',
        f"<title>{html_lib.escape(deck.title)}</title>",
    ]
    if deck.source:
        source_attr = html_lib.escape(deck.source, quote=True)
        lines.append(f'<meta name="{_SOURCE_META_NAME}" content="{source_attr}">')
    if deck.template is not None:
        template_json = json.dumps(deck.template, ensure_ascii=False, separators=(",", ":"))
        if len(template_json.encode("utf-8")) > MAX_METADATA_BYTES:
            raise DeckParseError(f"lcx:template metadata exceeds {MAX_METADATA_BYTES} bytes")
        template_attr = html_lib.escape(template_json, quote=True)
        lines.append(f'<meta name="{_TEMPLATE_META_NAME}" content="{template_attr}">')
    lines.append("</head>")
    lines.append("<body>")
    for slide in deck.slides:
        lines.append(_serialize_slide(slide))
    lines.append("</body>")
    lines.append("</html>")
    return "\n".join(lines) + "\n"


def read_slide(deck_html: str, slide_id: str) -> SlideTemplate:
    """The one slide with ``slide_id`` out of ``deck_html``."""
    for slide in parse_deck(deck_html).slides:
        if slide.slide_id == slide_id:
            return slide
    raise DeckParseError(f"no slide with id {slide_id!r}")


def patch_slide(deck_html: str, slide_id: str, new_template_html: str) -> str:
    """``deck_html`` with only the ``slide_id`` template replaced.

    ``new_template_html`` is a full ``<template data-slide-id="...">...
    </template>`` fragment. Every other slide's bytes are untouched — the
    replacement is a plain string slice on the matched span, not a
    parse/reserialize round trip, so a duplicated (byte-identical) sibling
    slide is never affected by matching on content instead of id.
    """
    parser = _run_parser(deck_html)
    for span in parser.spans:
        if span.slide_id == slide_id:
            return deck_html[: span.outer_start] + new_template_html + deck_html[span.outer_end :]
    raise DeckParseError(f"no slide with id {slide_id!r}")


def reorder_slides(deck_html: str, ordered_ids: list[str]) -> str:
    """``deck_html`` with its top-level ``<template>`` blocks reordered.

    ``ordered_ids`` must be exactly the deck's existing slide ids, in the
    desired order; each slide's bytes are carried over unchanged.
    """
    parser = _run_parser(deck_html)
    spans = parser.spans
    if not spans:
        return deck_html
    by_id = {span.slide_id: deck_html[span.outer_start : span.outer_end] for span in spans}
    if set(ordered_ids) != by_id.keys():
        raise DeckParseError("reorder_slides requires exactly the deck's existing slide ids")
    region_start = min(span.outer_start for span in spans)
    region_end = max(span.outer_end for span in spans)
    reordered = "\n".join(by_id[slide_id] for slide_id in ordered_ids)
    return deck_html[:region_start] + reordered + deck_html[region_end:]
