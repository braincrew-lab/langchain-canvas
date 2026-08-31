"""Embedded PDF font bytes for rendering, open-source family names for export.

Two halves that are deliberately independent:

* :func:`extract_embedded_fonts` and :func:`build_font_face_css` give the
  headless renderer the *original* font, so measured glyph widths match the
  source page instead of a silent substitute. Those bytes come from an
  uploaded file and are never registered as a deck asset.
* :func:`match_open_source_family` maps the original family name onto a
  license-safe open-source family. Only that *name* travels to an export.

A pdfium build without ``FPDFFont_GetFontData`` loses the first half only:
extraction returns an empty list, ``@font-face`` injection becomes a no-op,
and matching keeps working.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import logging
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# PDF font descriptor flag bit 7 (value 1 << 6) is "italic".
_ITALIC_FLAG = 1 << 6

# An embedded face far past this size is not a slide typeface; refuse it
# rather than base64-inlining it into every render document.
_MAX_FONT_BYTES = 4 * 1024 * 1024
_MAX_FONTS_PER_PAGE = 12

_HANGUL = re.compile(r"[가-힣ᄀ-ᇿ㄰-㆏]")

# Curated, hardcoded matches — no model call. Each key is matched
# case-insensitively as a substring of the original family name.
_FAMILY_MATCHES = (
    ("malgun gothic", "Noto Sans KR"),
    ("맑은 고딕", "Noto Sans KR"),
    ("batang", "Noto Serif KR"),
    ("바탕", "Noto Serif KR"),
    ("helvetica", "Inter"),
    ("arial", "Inter"),
    ("segoe ui", "Inter"),
    ("times", "Source Serif 4"),
    ("georgia", "Source Serif 4"),
    ("courier", "JetBrains Mono"),
    ("consolas", "JetBrains Mono"),
)

# Serif signals used only for a Hangul-bearing family with no curated match.
_SERIF_SIGNALS = ("serif", "myeongjo", "명조", "mincho", "gungsuh", "궁서")


@dataclass(frozen=True)
class EmbeddedFont:
    """One font file embedded in a source PDF page.

    ``data`` is render-time material only. It is never pinned as a store
    asset: the bytes belong to the uploaded document, not to the deck.
    """

    family: str
    weight: int
    is_italic: bool
    sha256: str
    data: bytes
    format: str  # "truetype" | "opentype"


def extract_embedded_fonts(page: Any) -> list[EmbeddedFont]:
    """Read every embedded face used by ``page``'s text objects.

    Returns an empty list — never raises — when the installed pdfium exposes
    no ``FPDFFont_GetFontData``, when the page cannot be walked, or when no
    text object carries an embedded face. Faces are deduplicated by content
    hash, since one face is normally shared by many text objects.
    """
    import pypdfium2 as pdfium
    from pypdfium2 import raw

    read_font_data = getattr(raw, "FPDFFont_GetFontData", None)
    if read_font_data is None:
        logger.debug(
            "pdf_fonts: pdfium exposes no FPDFFont_GetFontData; "
            "skipping embedded font extraction"
        )
        return []

    try:
        objects = list(page.get_objects())
    except Exception:
        logger.debug("pdf_fonts: could not walk page objects", exc_info=True)
        return []

    fonts: dict[str, EmbeddedFont] = {}
    for obj in objects:
        if not isinstance(obj, pdfium.PdfTextObj):
            continue
        font = _read_embedded_font(raw, read_font_data, obj)
        if font is None or font.sha256 in fonts:
            continue
        fonts[font.sha256] = font
        if len(fonts) >= _MAX_FONTS_PER_PAGE:
            break
    return list(fonts.values())


def _read_embedded_font(raw: Any, read_font_data: Any, obj: Any) -> EmbeddedFont | None:
    """One text object's embedded face, or ``None`` when it has none."""
    try:
        font = obj.get_font()
        if not font.is_embedded():
            return None
        length = ctypes.c_size_t()
        if not read_font_data(font, None, 0, ctypes.byref(length)):
            return None
        size = length.value
        if not 0 < size <= _MAX_FONT_BYTES:
            return None
        buffer = (ctypes.c_ubyte * size)()
        if not read_font_data(font, buffer, size, ctypes.byref(length)):
            return None
        data = bytes(buffer)[: min(length.value, size)]
        flags = ctypes.c_int(raw.FPDFFont_GetFlags(font)).value
        return EmbeddedFont(
            family=font.get_family_name() or "",
            weight=font.get_weight() or 400,
            is_italic=flags > 0 and bool(flags & _ITALIC_FLAG),
            sha256=hashlib.sha256(data).hexdigest(),
            data=data,
            format=_font_format(data),
        )
    except Exception:
        logger.debug("pdf_fonts: unreadable embedded font, skipped", exc_info=True)
        return None


def _font_format(data: bytes) -> str:
    """``"opentype"`` for a CFF-flavored face, ``"truetype"`` otherwise."""
    return "opentype" if data[:4] == b"OTTO" else "truetype"


def build_font_face_css(fonts: list[EmbeddedFont]) -> str:
    """``@font-face`` blocks that inline ``fonts`` as ``data:`` URIs.

    Emitted into the render/measure document wrapper only. It must never
    reach stored slide CSS: ``sanitize.py::_filter_css_declarations`` drops
    ``src`` outright, which would leave a rule that silently does nothing.
    """
    blocks = []
    for font in fonts:
        family = _css_family(font.family)
        if not family or not font.data:
            continue
        mime = "font/otf" if font.format == "opentype" else "font/ttf"
        payload = base64.b64encode(font.data).decode()
        blocks.append(
            f'@font-face{{font-family:"{family}";'
            f"font-weight:{max(1, min(1000, font.weight))};"
            f"font-style:{'italic' if font.is_italic else 'normal'};"
            f'src:url(data:{mime};base64,{payload}) format("{font.format}")}}'
        )
    return "".join(blocks)


def _css_family(family: str) -> str:
    """A family name safe inside a quoted CSS string.

    The name comes from an uploaded file, so characters that could close the
    quote or the ``<style>`` element are dropped rather than escaped — the
    same treatment ``style_tokens.py::_css_family`` applies.
    """
    return "".join(char for char in family if char not in '"\\<>{};').strip()


def contains_hangul(text: str) -> bool:
    """True when ``text`` contains a Hangul syllable, jamo, or compatibility jamo."""
    return bool(_HANGUL.search(text))


def match_open_source_family(family: str, weight: int, *, has_hangul: bool) -> str:
    """The license-safe open-source family that stands in for ``family``.

    Curated substring matches first, then a script-aware default for a
    Hangul-bearing page. An unrecognized family is returned unchanged:
    substituting an arbitrary typeface would silently restyle the export.

    ``weight`` is part of the call contract so callers pass the observed
    weight; the curated table itself is weight-independent, since every
    matched family ships the full weight range.
    """
    normalized = family.strip().lower()
    if not normalized:
        return family
    for pattern, matched in _FAMILY_MATCHES:
        if pattern in normalized:
            return matched
    if has_hangul:
        serif = any(signal in normalized for signal in _SERIF_SIGNALS)
        return "Noto Serif KR" if serif else "Noto Sans KR"
    return family
