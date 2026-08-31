"""Allowlist HTML sanitizer for deck slide markup.

Model output and hand edits both flow through :func:`sanitize_slide_html`
before a slide is persisted (see ``tools.py::edit_deck_slide``). It rebuilds
the document from an allowlist rather than trying to blocklist every
dangerous construct: unknown tags/attributes are dropped, not merely the
ones this module happened to think of.
"""

from __future__ import annotations

import html as html_lib
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import unquote

ALLOWED_TAGS: frozenset[str] = frozenset(
    {
        "section",
        "div",
        "span",
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "li",
        "img",
        "svg",
        "path",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polygon",
        "polyline",
        "g",
        "defs",
        "linearGradient",
        "stop",
        "table",
        "thead",
        "tbody",
        "tr",
        "td",
        "th",
        "b",
        "strong",
        "i",
        "em",
        "u",
        "br",
        "a",
        "style",
    }
)

ALLOWED_ATTRS: frozenset[str] = frozenset(
    {
        "class",
        "id",
        "style",
        "data-node-id",
        "data-chart-type",
        "data-chart-data",
        "data-style-tokens",
        "data-text-block",
        "data-text-role",
        "data-slide-id",
        "data-slide-title",
        "data-pptx-shape-id",
        "data-lcx-fallback",
        "src",
        "href",
        "alt",
        "title",
        "width",
        "height",
        "viewBox",
        "d",
        "x",
        "y",
        "cx",
        "cy",
        "r",
        "rx",
        "ry",
        "x1",
        "y1",
        "x2",
        "y2",
        "points",
        "fill",
        "stroke",
        "stroke-width",
        "offset",
        "stop-color",
        "colspan",
        "rowspan",
    }
)

ALLOWED_CSS_PROPS: frozenset[str] = frozenset(
    {
        "font",
        "border-collapse",
        "table-layout",
        "position",
        "left",
        "top",
        "right",
        "bottom",
        "width",
        "height",
        "color",
        "background",
        "background-color",
        "background-image",
        "background-size",
        "background-position",
        "font-size",
        "font-family",
        "font-weight",
        "font-style",
        "text-align",
        "line-height",
        "letter-spacing",
        "border",
        "border-top",
        "border-right",
        "border-bottom",
        "border-left",
        "border-width",
        "border-style",
        "border-color",
        "border-top-width",
        "border-top-style",
        "border-top-color",
        "border-right-width",
        "border-right-style",
        "border-right-color",
        "border-bottom-width",
        "border-bottom-style",
        "border-bottom-color",
        "border-left-width",
        "border-left-style",
        "border-left-color",
        "border-radius",
        "box-sizing",
        "opacity",
        "transform",
        "z-index",
        "display",
        "flex-direction",
        "align-items",
        "justify-content",
        "gap",
        "padding",
        "margin",
        "overflow",
        "object-fit",
        "box-shadow",
        "white-space",
        "text-decoration",
    }
)

ALLOWED_URL_SCHEMES: tuple[str, ...] = ("data:", "blob:")

_DENIED_TAGS: frozenset[str] = frozenset(
    {"script", "form", "iframe", "embed", "object", "link", "meta", "base"}
)
_URL_ATTRS: frozenset[str] = frozenset({"src", "href"})
_DISALLOWED_SCHEMES: tuple[str, ...] = (
    "http:",
    "https:",
    "//",
    "javascript:",
    "vbscript:",
    "ftp:",
    "file:",
)

# Legacy IE CSS expressions and script-executing value forms that can hide
# behind an otherwise-allowlisted property (e.g. ``width: expression(...)``).
_DANGEROUS_CSS_VALUE_RE = re.compile(
    r"expression\s*\(|javascript:|behavior\s*:|-moz-binding", re.IGNORECASE
)
_CSS_URL_FN_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
_CSS_AT_IMPORT_RE = re.compile(r"@import[^;]*;?", re.IGNORECASE)
_CSS_RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}")


@dataclass(frozen=True)
class SanitizeResult:
    """Sanitized markup plus a human-readable list of what was removed."""

    html: str
    removed: list[str] = field(default_factory=list)


def _is_allowed_url(value: str, *, allow_data_blob: bool = True) -> bool:
    """Allowlist check shared by ``src``/``href`` attributes and CSS ``url()``.

    ``allow_data_blob`` scopes ``data:``/``blob:`` to contexts where the
    referenced content is only ever decoded as an image (``<img src>``,
    CSS ``background``/``background-image``). ``<a href>`` navigates the
    top-level document, so ``data:text/html,...`` there would be an
    open-redirect / HTML-injection vector and must not be allowed even
    though the raw scheme is otherwise on the allowlist.
    """
    stripped = value.strip()
    if not stripped:
        return True
    lowered = stripped.lower()
    if lowered.startswith(ALLOWED_URL_SCHEMES):
        return allow_data_blob
    if lowered.startswith(_DISALLOWED_SCHEMES):
        return False
    if lowered.startswith(("assets/", "sources/")):
        decoded = unquote(stripped)
        return not (
            ".." in decoded.split("/")
            or "\\" in decoded
            or any(ord(c) < 32 for c in decoded)
            or "?" in decoded
            or "#" in decoded
        )
    # Any other absolute/rooted reference (leading "/", "#", scheme-relative,
    # or a relative path outside assets/ and sources/) is not part of the deck's own
    # asset store — reject rather than guess intent.
    return False


def _css_value_urls_allowed(value: str) -> bool:
    """Reject a declaration value if any ``url(...)`` inside it fails the allowlist."""
    for match in _CSS_URL_FN_RE.finditer(value):
        if not _is_allowed_url(match.group(2)):
            return False
    return True


def _filter_css_declarations(value: str, removed: list[str] | None = None) -> str:
    kept: list[str] = []
    for declaration in value.split(";"):
        if ":" not in declaration:
            continue
        prop, _, val = declaration.partition(":")
        prop = prop.strip().lower()
        val = val.strip()
        if prop not in ALLOWED_CSS_PROPS or not val:
            if removed is not None:
                removed.append(f"css[{prop}]")
            continue
        if _DANGEROUS_CSS_VALUE_RE.search(val):
            if removed is not None:
                removed.append(f"css[{prop}: unsafe value]")
            continue
        if not _css_value_urls_allowed(val):
            if removed is not None:
                removed.append(f"css[{prop}: external URL]")
            continue
        kept.append(f"{prop}: {val}")
    return "; ".join(kept)


def _filter_style_block(css_text: str, removed: list[str] | None = None) -> str:
    """Apply the same declaration allowlist to ``<style>`` block content.

    ``<style>`` text is never HTML-escaped by the sanitizer (it is raw CSS,
    not markup), so it must be filtered here rather than left verbatim —
    otherwise a full-frame overlay, an external ``@import``, or a raw
    ``url()`` fetch survives untouched inside the tag despite the tag
    itself being allowlisted.
    """
    without_imports = _CSS_AT_IMPORT_RE.sub("", css_text)
    if without_imports != css_text and removed is not None:
        removed.append("css[@import]")
    kept_rules: list[str] = []
    for match in _CSS_RULE_RE.finditer(without_imports):
        selector = match.group(1).strip()
        declarations = _filter_css_declarations(match.group(2), removed)
        if selector and declarations:
            kept_rules.append(f"{selector} {{ {declarations}; }}")
    return " ".join(kept_rules)


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.output: list[str] = []
        self.removed: list[str] = []
        self._skip_depth = 0
        self._in_style = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._open(tag, attrs, self_closing=False)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._open(tag, attrs, self_closing=True)

    def _open(self, tag: str, attrs: list[tuple[str, str | None]], *, self_closing: bool) -> None:
        lowered = tag.lower()
        if self._skip_depth:
            if not self_closing:
                self._skip_depth += 1
            return
        if lowered in _DENIED_TAGS or lowered not in ALLOWED_TAGS:
            self.removed.append(f"<{lowered}>")
            if not self_closing:
                self._skip_depth = 1
            return
        kept = self._sanitize_attrs(lowered, attrs)
        self.output.append(self._render_tag(lowered, kept, self_closing=self_closing))
        if lowered == "style" and not self_closing:
            self._in_style = True

    def handle_endtag(self, tag: str) -> None:
        if self._skip_depth:
            self._skip_depth -= 1
            return
        lowered = tag.lower()
        if lowered == "style":
            self._in_style = False
        if lowered in ALLOWED_TAGS and lowered not in _DENIED_TAGS:
            self.output.append(f"</{lowered}>")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._in_style:
            self.output.append(_filter_style_block(data, self.removed))
        else:
            self.output.append(html_lib.escape(data))

    def _sanitize_attrs(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> list[tuple[str, str]]:
        kept: list[tuple[str, str]] = []
        for name, raw_value in attrs:
            lowered_name = name.lower()
            value = raw_value or ""
            if lowered_name.startswith("on"):
                self.removed.append(f"{tag}[{lowered_name}]")
                continue
            if lowered_name not in ALLOWED_ATTRS:
                self.removed.append(f"{tag}[{lowered_name}]")
                continue
            if lowered_name in _URL_ATTRS:
                # data:/blob: is only safe where the value is decoded strictly
                # as an image (src); href navigates the document, so
                # data:text/html,... there is an open-redirect / HTML-
                # injection vector (WP-P2) and must be rejected.
                allow_data_blob = lowered_name == "src"
                if not _is_allowed_url(value, allow_data_blob=allow_data_blob):
                    self.removed.append(f"{tag}[{lowered_name}={value!r}]")
                    continue
            if lowered_name == "style":
                value = _filter_css_declarations(value, self.removed)
            kept.append((lowered_name, value))
        return kept

    @staticmethod
    def _render_tag(tag: str, attrs: list[tuple[str, str]], *, self_closing: bool) -> str:
        parts = [f"<{tag}"]
        for name, value in attrs:
            parts.append(f' {name}="{html_lib.escape(value, quote=True)}"')
        parts.append("/>" if self_closing else ">")
        return "".join(parts)


def sanitize_slide_html(html_text: str) -> SanitizeResult:
    """Rebuild ``html_text`` from the allowlist, reporting what was dropped."""
    sanitizer = _Sanitizer()
    sanitizer.feed(html_text)
    sanitizer.close()
    return SanitizeResult(html="".join(sanitizer.output), removed=sanitizer.removed)
