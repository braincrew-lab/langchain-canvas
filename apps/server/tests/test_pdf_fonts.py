"""Embedded PDF fonts reach the renderer; only matched open-source names reach export."""

import io
from types import SimpleNamespace


def stub_font(**overrides):
    from app.agent.pdf_fonts import EmbeddedFont

    fields = {
        "family": "Malgun Gothic",
        "weight": 700,
        "is_italic": False,
        "sha256": "b" * 64,
        "data": b"\x00\x01\x00\x00stub-font-bytes",
        "format": "truetype",
    }
    fields.update(overrides)
    return EmbeddedFont(**fields)


def test_match_open_source_family_maps_korean_gothic_to_noto_sans_kr():
    from app.agent.pdf_fonts import match_open_source_family

    assert (
        match_open_source_family("Malgun Gothic", 400, has_hangul=True)
        == "Noto Sans KR"
    )
    assert match_open_source_family("Batang", 400, has_hangul=True) == "Noto Serif KR"
    assert match_open_source_family("Helvetica", 400, has_hangul=False) == "Inter"
    assert match_open_source_family("Georgia", 400, has_hangul=False) == "Source Serif 4"
    assert match_open_source_family("Consolas", 400, has_hangul=False) == "JetBrains Mono"
    # No curated match, but the page is Korean: pick by script and shape.
    assert match_open_source_family("Nanum Myeongjo", 400, has_hangul=True) == "Noto Serif KR"
    assert match_open_source_family("Pretendard", 400, has_hangul=True) == "Noto Sans KR"


def test_match_open_source_family_keeps_unknown_family_unchanged():
    from app.agent.pdf_fonts import match_open_source_family

    assert (
        match_open_source_family("Acme Display", 400, has_hangul=False)
        == "Acme Display"
    )
    assert match_open_source_family("", 400, has_hangul=False) == ""


def test_build_font_face_css_embeds_data_uri_and_no_network_url():
    from app.agent.pdf_fonts import build_font_face_css

    css = build_font_face_css([stub_font()])

    assert "@font-face" in css
    assert "data:font/" in css
    assert "http" not in css
    assert 'font-family:"Malgun Gothic"' in css
    assert "font-weight:700" in css
    assert build_font_face_css([]) == ""
    # A face with no usable name or no bytes cannot produce a valid rule.
    assert build_font_face_css([stub_font(family=' <">')]) == ""
    assert build_font_face_css([stub_font(data=b"")]) == ""
    assert "font-style:italic" in build_font_face_css([stub_font(is_italic=True)])


def test_extract_embedded_fonts_returns_empty_list_when_api_unavailable(monkeypatch):
    from app.agent.pdf_fonts import extract_embedded_fonts
    from pypdfium2 import raw

    monkeypatch.delattr(raw, "FPDFFont_GetFontData", raising=False)

    def unreadable():
        raise AssertionError("the page must not be read once the raw API is absent")

    assert extract_embedded_fonts(SimpleNamespace(get_objects=unreadable)) == []


def test_extract_embedded_fonts_returns_empty_list_when_the_page_cannot_be_walked():
    from app.agent.pdf_fonts import extract_embedded_fonts

    def broken():
        raise RuntimeError("page object tree is unreadable")

    assert extract_embedded_fonts(SimpleNamespace(get_objects=broken)) == []


def test_read_embedded_font_rejects_an_unreadable_or_oversized_face():
    from app.agent import pdf_fonts

    raw = SimpleNamespace(FPDFFont_GetFlags=lambda font: 0)
    font = SimpleNamespace(
        is_embedded=lambda: True,
        get_family_name=lambda: "Malgun Gothic",
        get_weight=lambda: 400,
    )
    obj = SimpleNamespace(get_font=lambda: font)

    def refuse_length(font, buffer, buflen, out_buflen):
        return False

    def oversized(font, buffer, buflen, out_buflen):
        out_buflen._obj.value = pdf_fonts._MAX_FONT_BYTES + 1
        return True

    def refuse_body(font, buffer, buflen, out_buflen):
        out_buflen._obj.value = 8
        return buffer is None

    assert pdf_fonts._read_embedded_font(raw, refuse_length, obj) is None
    assert pdf_fonts._read_embedded_font(raw, oversized, obj) is None
    assert pdf_fonts._read_embedded_font(raw, refuse_body, obj) is None


def test_read_embedded_font_returns_face_bytes_and_skips_a_standard_font():
    """The pdfium call boundary, stubbed: no fixture PDF embeds a real face."""
    import hashlib

    from app.agent.pdf_fonts import _read_embedded_font

    payload = b"OTTO" + b"opentype-face-bytes"

    def read_font_data(font, buffer, buflen, out_buflen):
        out_buflen._obj.value = len(payload)
        if buffer is None:
            return True
        if buflen < len(payload):
            return False
        buffer[: len(payload)] = payload
        return True

    raw = SimpleNamespace(FPDFFont_GetFlags=lambda font: 1 << 6)
    font = SimpleNamespace(
        is_embedded=lambda: True,
        get_family_name=lambda: "Malgun Gothic",
        get_weight=lambda: 700,
    )

    embedded = _read_embedded_font(
        raw, read_font_data, SimpleNamespace(get_font=lambda: font)
    )

    assert embedded is not None
    assert embedded.data == payload
    assert embedded.format == "opentype"
    assert embedded.is_italic is True
    assert embedded.weight == 700
    assert embedded.sha256 == hashlib.sha256(payload).hexdigest()

    standard = SimpleNamespace(
        get_font=lambda: SimpleNamespace(is_embedded=lambda: False)
    )
    assert _read_embedded_font(raw, read_font_data, standard) is None


def test_export_family_is_matched_even_when_font_bytes_unavailable(monkeypatch):
    from app.agent.pdf_fonts import build_font_face_css, extract_embedded_fonts
    from app.agent.pdf_source import PdfPageSource
    from app.agent.style_tokens import tokens_from_pdf_page, tokens_to_css
    from pypdfium2 import raw

    monkeypatch.delattr(raw, "FPDFFont_GetFontData", raising=False)

    source = PdfPageSource(1, 960.0, 540.0, b"")
    source.texts = [
        {
            "text": "안녕하세요",
            "order": 0,
            "x": 40.0,
            "y": 60.0,
            "w": 200.0,
            "h": 36.0,
            "font": "Malgun Gothic",
            "weight": 400,
            "size": 32.0,
            "color": "#111111",
        }
    ]
    source.fonts = extract_embedded_fonts(SimpleNamespace(get_objects=list))

    tokens = tokens_from_pdf_page(source)

    assert source.fonts == []
    assert build_font_face_css(source.fonts) == ""
    assert tokens.type_scale[0].family == "Malgun Gothic"
    assert tokens.type_scale[0].export_family == "Noto Sans KR"
    assert 'font-family:"Malgun Gothic","Noto Sans KR",sans-serif' in tokens_to_css(
        tokens
    )


def test_font_styles_task_aborts_network_and_keeps_reference_path(monkeypatch):
    from app.agent import render as render_module
    from PIL import Image

    reference = io.BytesIO()
    Image.new("RGB", (200, 100), "white").save(reference, format="PNG")
    texts = [
        {
            "text": "Alpha",
            "x": 10.0,
            "y": 20.0,
            "w": 60.0,
            "h": 30.0,
            "size": 30.0,
            "weight": 400,
            "font": "Arial",
        }
    ]
    face = '@font-face{font-family:"Alpha Face";src:url(data:font/ttf;base64,AAEAAA==) format("truetype")}'

    styles = render_module.pdf_text_styles(
        texts, reference.getvalue(), font_face_css=face
    )
    assert "reference_color" in styles[0]

    calls: list[str] = []

    class StubPage:
        def route(self, pattern, handler):
            calls.append(f"route:{pattern}")

        def set_content(self, html, **kwargs):
            calls.append("set_content")
            assert "@font-face" in html

        def evaluate(self, script, argument=None):
            calls.append("evaluate")
            assert "document.fonts.ready" in script
            return []

        def close(self):
            calls.append("close")

    monkeypatch.setattr(
        render_module,
        "_get_browser",
        lambda: SimpleNamespace(new_page=lambda **kwargs: StubPage()),
    )
    assert render_module.pdf_text_styles(texts, None, font_face_css=face) == []
    assert calls[:2] == ["route:**/*", "set_content"], (
        "the network guard must be installed before the document is loaded"
    )
