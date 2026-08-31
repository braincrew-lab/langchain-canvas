"""U1 design tokens: extraction from a PDF page and role-default CSS generation.

Every case here is a pure unit test over the original PDF fields
(``PdfPageSource.texts``) except the last, which renders the generated CSS in
the real geometry backend — that render is the gate proving the emitted CSS is
not dead code.
"""

from __future__ import annotations

import pytest
from app.agent.pdf_source import extract_pdf_pages
from app.agent.style_tokens import (
    BackgroundToken,
    ColorToken,
    StyleTokens,
    TypeToken,
    tokens_from_pdf_page,
    tokens_to_css,
)
from pydantic import ValidationError

from template_source_fixtures import text_pdf_source


def test_tokens_from_pdf_page_assigns_title_role_to_largest_size() -> None:
    data = text_pdf_source([[("Heading", 100, 700, 28.0), ("Body sentence", 100, 600, 12.0)]])
    source = extract_pdf_pages(data, [1])[0]

    tokens = tokens_from_pdf_page(source)

    by_role = {token.role: token for token in tokens.type_scale}
    assert "title" in by_role
    assert by_role["title"].size_px == max(text["size"] for text in source.texts)
    assert by_role["title"].size_px > by_role["body"].size_px


@pytest.mark.parametrize("value", ["red", "#abc", "rgb(1,2,3)", ""])
def test_color_tokens_reject_values_that_are_not_six_digit_hex(value: str) -> None:
    with pytest.raises(ValidationError):
        ColorToken(role="ink", value=value, coverage=0.1)
    with pytest.raises(ValidationError):
        BackgroundToken(kind="solid", value=value)


def test_background_token_value_stays_optional_for_a_raster() -> None:
    assert BackgroundToken(kind="raster", asset="assets/bg.png").value is None


def test_tokens_to_css_emits_role_selector_with_literal_values() -> None:
    tokens = StyleTokens(
        colors=[ColorToken(role="ink", value="#1a1a1a", coverage=0.12)],
        type_scale=[
            TypeToken(
                role="title",
                family="Noto Sans KR",
                size_px=34.0,
                weight=700,
                line_height_px=41.0,
                color="#1a1a1a",
            )
        ],
    )

    css = tokens_to_css(tokens)

    assert '[data-text-role="title"]{' in css
    assert "color:#1a1a1a" in css
    assert "font-size:34px" in css
    for forbidden in ("--", "var(", "position:", "left:"):
        assert forbidden not in css


def test_role_defaults_apply_to_node_without_inline_font() -> None:
    """A role-tagged node with no inline font resolves to the token family."""
    from app.agent.render import measure_slide

    tokens = StyleTokens(
        type_scale=[
            TypeToken(
                role="title",
                family="Courier New",
                size_px=34.0,
                weight=700,
                line_height_px=41.0,
                color="#1a1a1a",
            )
        ]
    )
    document = (
        "<html><head><style>html,body{margin:0}"
        f"{tokens_to_css(tokens)}</style></head>"
        '<body><p data-node-id="n1" data-text-role="title">Title</p></body></html>'
    )

    layout = measure_slide(document, ratio="16:9")

    run = layout["textBlocks"][0]["paragraphs"][0]["runs"][0]
    assert "Courier New" in run["font"]
    assert run["size"] == 34
