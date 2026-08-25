"""Exporter contract: table -> xlsx, html -> docx, slides -> pptx, the tool.

Round-trips are asserted with the real readers (openpyxl / python-docx /
python-pptx), so "exported" means a mainstream library opens the file and
finds the content.
"""

from __future__ import annotations

import base64
import io
import json
from dataclasses import dataclass, field
from typing import Any

import pytest
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.enum.text import PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches

from langchain_canvas import InMemoryCanvasStore, create_export_tool
from langchain_canvas.exporters import (
    PPTX_MIME,
    HtmlDocxExporter,
    SlidesPptxExporter,
    TableXlsxExporter,
    default_exporters,
    exporter_for,
)

# A real 1x1 red PNG — small enough to inline, real enough for pptx to embed.
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)

# --- routing ---------------------------------------------------------------------


def test_exporter_routing_matches_suffix_and_target():
    exporters = default_exporters()
    assert isinstance(exporter_for("sales.table.json", "xlsx", exporters), TableXlsxExporter)
    assert isinstance(exporter_for("report/01-a.html", "docx", exporters), HtmlDocxExporter)
    assert isinstance(exporter_for("deck.slides.json", "pptx", exporters), SlidesPptxExporter)
    assert exporter_for("sales.table.json", "docx", exporters) is None
    assert exporter_for("deck.slides.json", "docx", exporters) is None
    assert exporter_for("photo.png", "docx", exporters) is None


# --- table -> xlsx ---------------------------------------------------------------


def test_table_columns_rows_export_round_trip():
    content = json.dumps(
        {
            "type": "table",
            "title": "Sales",
            "data": {
                "columns": [
                    {"key": "region", "label": "Region"},
                    {"key": "total", "label": "Total"},
                ],
                "rows": [
                    {"region": "East", "total": 10},
                    {"region": "West", "total": 20},
                ],
            },
        }
    )
    result = TableXlsxExporter().export(content, path="sales.table.json")
    assert result.filename == "sales.xlsx"

    sheet = load_workbook(io.BytesIO(result.data)).worksheets[0]
    assert [cell.value for cell in sheet[1]] == ["Region", "Total"]
    assert sheet[1][0].font.bold
    assert sheet.cell(row=2, column=1).value == "East"
    assert sheet.cell(row=3, column=2).value == 20


def test_table_fortune_sheet_export_values_and_merges():
    content = json.dumps(
        {
            "type": "table",
            "data": {
                "sheet": [
                    {
                        "name": "Q1",
                        "celldata": [
                            {"r": 0, "c": 0, "v": {"v": "Head", "bl": 1}},
                            {"r": 1, "c": 1, "v": 42},
                        ],
                        "config": {"merge": {"0_0": {"r": 0, "c": 0, "rs": 1, "cs": 2}}},
                    }
                ]
            },
        }
    )
    result = TableXlsxExporter().export(content, path="q1.table.json")
    sheet = load_workbook(io.BytesIO(result.data))["Q1"]
    assert sheet.cell(row=1, column=1).value == "Head"
    assert sheet.cell(row=2, column=2).value == 42
    assert [str(r) for r in sheet.merged_cells.ranges] == ["A1:B1"]


def test_table_formula_rows_stay_formulas():
    # An "="-prefixed row value must land as a live formula, not a frozen string.
    content = json.dumps(
        {
            "type": "table",
            "data": {
                "columns": [{"key": "a", "label": "A"}],
                "rows": [{"a": 10}, {"a": 20}, {"a": "=SUM(A2:A3)"}],
            },
        }
    )
    result = TableXlsxExporter().export(content, path="sums.table.json")
    sheet = load_workbook(io.BytesIO(result.data)).worksheets[0]
    cell = sheet.cell(row=4, column=1)
    assert cell.value == "=SUM(A2:A3)"
    assert cell.data_type == "f"  # stored as a formula, recalculated on open


def test_table_fortune_sheet_typed_formula_stays_a_formula():
    # A grid-typed formula carries `f` next to the cached `v` — export the
    # formula (openpyxl stores no cached value; apps recalculate on open).
    content = json.dumps(
        {
            "type": "table",
            "data": {
                "sheet": [
                    {
                        "name": "S",
                        "celldata": [
                            {"r": 0, "c": 0, "v": {"v": 1}},
                            {"r": 1, "c": 0, "v": {"v": 2}},
                            {"r": 2, "c": 0, "v": {"v": 3, "f": "=SUM(A1:A2)"}},
                        ],
                    }
                ]
            },
        }
    )
    result = TableXlsxExporter().export(content, path="s.table.json")
    sheet = load_workbook(io.BytesIO(result.data))["S"]
    cell = sheet.cell(row=3, column=1)
    assert cell.value == "=SUM(A1:A2)"
    assert cell.data_type == "f"


# --- html -> docx ----------------------------------------------------------------

_PNG_1PX = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

_HTML = f"""<html><head><title>t</title><style>body {{ font: 16px serif; }}</style></head>
<body>
<div class="kicker">REPORT · SECTION 02</div>
<h1>핵심 API 기능</h1>
<p>The store keeps <strong>every</strong> file and its <em>history</em>.</p>
<ul><li>read</li><li>write</li></ul>
<table><tr><th>Tool</th><th>Role</th></tr><tr><td>read_canvas</td><td>read</td></tr></table>
<img src="data:image/png;base64,{_PNG_1PX}"/>
<hr/>
<p>After the break.</p>
</body></html>"""


def test_html_docx_export_structure():
    result = HtmlDocxExporter().export(_HTML, path="report/02-features.html")
    assert result.filename == "02-features.docx"

    document = Document(io.BytesIO(result.data))
    texts = [p.text for p in document.paragraphs if p.text.strip()]
    assert "REPORT · SECTION 02" in texts  # kicker div survives as a paragraph
    assert "After the break." in texts
    assert "font: 16px" not in " ".join(texts)  # style content dropped

    heading = next(p for p in document.paragraphs if p.text == "핵심 API 기능")
    assert heading.style.name == "Heading 1"

    prose = next(p for p in document.paragraphs if "every" in p.text)
    assert any(run.bold for run in prose.runs)
    assert any(run.italic for run in prose.runs)

    bullets = [p.text for p in document.paragraphs if p.style.name == "List Bullet"]
    assert bullets == ["read", "write"]

    table = document.tables[0]
    assert table.cell(0, 0).text == "Tool"
    assert table.cell(0, 0).paragraphs[0].runs[0].bold  # th row bolded
    assert table.cell(1, 1).text == "read"

    assert len(document.inline_shapes) == 1  # the data: URI image
    assert 'type="page"' in document.element.xml  # hr became a page break


def test_html_docx_title_names_the_file():
    result = HtmlDocxExporter().export("<p>hi</p>", path="report/", title="My Report")
    assert result.filename == "My-Report.docx"


# --- slides -> pptx --------------------------------------------------------------


def _deck(slides: list[dict[str, Any]]) -> str:
    return json.dumps({"type": "slides", "title": "Deck", "data": {"slides": slides}})


def _png_uri() -> str:
    return f"data:image/png;base64,{base64.b64encode(PNG_1PX).decode()}"


def test_slides_pptx_elements_land_as_real_shapes():
    content = _deck(
        [
            {
                "background": "#112233",
                "notes": "speaker notes here",
                "elements": [
                    {"id": "t", "type": "text", "x": 10, "y": 10, "w": 60, "h": 12,
                     "text": "Hello deck", "fontSize": 40, "bold": True,
                     "color": "#ff0000", "align": "center"},
                    {"id": "i", "type": "image", "x": 20, "y": 30, "w": 40, "h": 40,
                     "src": _png_uri()},
                    {"id": "r", "type": "shape", "shape": "rect", "x": 5, "y": 80,
                     "w": 30, "h": 10, "fill": "#00ff00"},
                    {"id": "l", "type": "shape", "shape": "line", "x": 40, "y": 85,
                     "w": 50, "h": 0, "fill": "#0000ff"},
                ],
            }
        ]
    )
    result = SlidesPptxExporter().export(content, path="deck.slides.json")
    assert result.filename == "Deck.pptx"

    deck = Presentation(io.BytesIO(result.data))
    assert deck.slide_width == Inches(10)
    assert deck.slide_height == Inches(5.625)
    (slide,) = deck.slides

    # The slide is shapes, not one baked bitmap: text keeps its runs and
    # font, the image is its own picture with the original bytes intact.
    texts = [s for s in slide.shapes if s.has_text_frame and s.text_frame.text]
    ((run,),) = [p.runs for p in texts[0].text_frame.paragraphs]
    assert run.text == "Hello deck"
    assert run.font.size.pt == 30  # 40 px on the 1280px canvas -> 30 pt
    assert run.font.bold is True
    assert str(run.font.color.rgb) == "FF0000"
    assert texts[0].text_frame.paragraphs[0].alignment == PP_ALIGN.CENTER

    (picture,) = [s for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE]
    assert picture.image.blob == PNG_1PX

    fills = {
        str(s.fill.fore_color.rgb)
        for s in slide.shapes
        if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE
    }
    assert "00FF00" in fills
    assert any(s.shape_type == MSO_SHAPE_TYPE.LINE for s in slide.shapes)

    assert str(slide.background.fill.fore_color.rgb) == "112233"
    assert slide.notes_slide.notes_text_frame.text == "speaker notes here"


def test_slides_pptx_derives_structured_slides_like_the_canvas():
    content = _deck(
        [
            {"layout": "title", "title": "Big Title", "subtitle": "The subtitle"},
            {"title": "Agenda", "bullets": ["One", "Two"]},
        ]
    )
    deck = Presentation(io.BytesIO(SlidesPptxExporter().export(content, path="d.slides.json").data))
    first, second = deck.slides

    first_texts = [s.text_frame.text for s in first.shapes if s.has_text_frame]
    assert "Big Title" in first_texts and "The subtitle" in first_texts
    title_shape = next(s for s in first.shapes if s.text_frame.text == "Big Title")
    assert title_shape.text_frame.paragraphs[0].runs[0].font.size.pt == 36.0  # 48 px

    # The bullet glyph is a paragraph property, not part of the run — see
    # test_slides_pptx_draws_bullets_as_a_real_list.
    second_texts = [s.text_frame.text for s in second.shapes if s.has_text_frame]
    assert second_texts == ["Agenda", "One", "Two"]


def test_slides_pptx_boxes_hold_their_own_text():
    """A wrapping bullet gets a taller box, and nothing shrinks to fit.

    Shrink-to-fit is what rendered two bullets of the same size at two
    different sizes on the same slide.
    """
    from pptx.enum.text import MSO_AUTO_SIZE

    long_line = "a bullet long enough that it has to wrap onto a second line inside its box"
    content = _deck([{"title": "T", "bullets": ["short", long_line]}])
    deck = Presentation(io.BytesIO(SlidesPptxExporter().export(content, path="d.slides.json").data))
    boxes = {s.text_frame.text: s for s in next(iter(deck.slides)).shapes if s.has_text_frame}
    assert boxes[long_line].height == pytest.approx(2 * boxes["short"].height, abs=2)
    assert all(b.text_frame.auto_size == MSO_AUTO_SIZE.NONE for b in boxes.values())
    sizes = {
        box.text_frame.paragraphs[0].runs[0].font.size
        for box in (boxes[long_line], boxes["short"])
    }
    assert len(sizes) == 1


def test_slides_pptx_draws_bullets_as_a_real_list():
    """A literal '•' in the run picks up the font of whatever follows it.

    Mixed scripts on one slide then get mixed bullet glyphs and ragged left
    edges, and a wrapped line starts under the bullet instead of under the
    text. A paragraph bullet is drawn once, by the list.
    """
    content = _deck([{"title": "T", "bullets": ["매출 성장", "Revenue growth"]}])
    deck = Presentation(io.BytesIO(SlidesPptxExporter().export(content, path="d.slides.json").data))
    shapes = [s for s in next(iter(deck.slides)).shapes if s.has_text_frame]
    bullets = [s for s in shapes if s.text_frame.text != "T"]
    assert [s.text_frame.text for s in bullets] == ["매출 성장", "Revenue growth"]
    for shape in bullets:
        properties = shape.text_frame.paragraphs[0]._p.find(qn("a:pPr"))
        assert properties is not None
        assert properties.find(qn("a:buChar")).get("char") == "•"
        # A hanging indent: the marker sits left of the text it belongs to.
        assert int(properties.get("indent")) == -int(properties.get("marL"))
        assert int(properties.get("marL")) > 0

    # The heading is not a list item.
    heading = next(s for s in shapes if s.text_frame.text == "T")
    heading_properties = heading.text_frame.paragraphs[0]._p.find(qn("a:pPr"))
    assert heading_properties is None or heading_properties.find(qn("a:buChar")) is None


def test_slides_pptx_padding_insets_geometry():
    element = {"id": "t", "type": "text", "x": 0, "y": 0, "w": 100, "h": 10, "text": "x"}
    def exported(slides: list[dict[str, Any]]) -> Presentation:
        return Presentation(io.BytesIO(
            SlidesPptxExporter().export(_deck(slides), path="d.slides.json").data
        ))

    plain = exported([{"elements": [element]}])
    padded = exported([{"padding": 10, "elements": [element]}])
    plain_box = next(iter(plain.slides)).shapes[0]
    padded_box = next(iter(padded.slides)).shapes[0]
    assert plain_box.left == 0 and plain_box.width == Inches(10)
    assert padded_box.left == Inches(1.0)  # 10% of the 10in page
    assert padded_box.width == Inches(8.0)  # spans the inset content area


def test_slides_pptx_skips_what_it_cannot_embed():
    content = _deck(
        [
            {
                "elements": [
                    # Not inlined (a bare reference) — skipped, never a crash.
                    {"id": "i", "type": "image", "x": 0, "y": 0, "w": 50, "h": 50,
                     "src": "assets/logo.png"},
                    # url() background is out of contract for the pptx door.
                ],
                "background": "url(assets/bg.png)",
            }
        ]
    )
    deck = Presentation(io.BytesIO(SlidesPptxExporter().export(content, path="d.slides.json").data))
    (slide,) = deck.slides
    assert [s for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE] == []


def test_slides_pptx_rejects_non_deck_content():
    with pytest.raises(ValueError):
        SlidesPptxExporter().export("not json", path="d.slides.json")
    with pytest.raises(ValueError):
        SlidesPptxExporter().export(json.dumps({"data": {"slides": "nope"}}), path="d.slides.json")


def test_slides_pptx_names_the_envelope_when_data_is_missing():
    # A deck written without the envelope must fail with the expected shape
    # in the message — not export as one silent blank slide.
    bare = json.dumps({"slides": [{"title": "T"}], "theme": {}})
    with pytest.raises(ValueError, match='"data" envelope'):
        SlidesPptxExporter().export(bare, path="d.slides.json")


def _skin_pptx_bytes() -> bytes:
    """A 4:3 template with a branded master shape and one slide of its own."""
    from pptx import Presentation as _P
    from pptx.enum.shapes import MSO_SHAPE

    skin = _P()
    skin.slide_width = Inches(10)
    skin.slide_height = Inches(7.5)
    slide = skin.slides.add_slide(skin.slide_layouts[6])
    logo = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, Inches(0.2), Inches(0.2), Inches(1), Inches(0.4)
    )
    logo.name = "BrandLogo"
    # python-pptx has no master add_shape; moving the element is the test's
    # stand-in for a real branded master.
    skin.slide_masters[0].shapes._spTree.append(logo._element)
    buf = io.BytesIO()
    skin.save(buf)
    return buf.getvalue()


def _skin_uri() -> str:
    return f"data:{PPTX_MIME};base64,{base64.b64encode(_skin_pptx_bytes()).decode()}"


def test_slides_pptx_template_skin_keeps_master_and_page_size():
    content = json.dumps({
        "type": "slides",
        "title": "Skinned",
        "data": {
            "template": _skin_uri(),
            "slides": [
                {"elements": [{"id": "t", "type": "text", "x": 10, "y": 10,
                               "w": 80, "h": 20, "text": "Hello", "fontSize": 54}]},
                {"title": "Second", "bullets": ["One"]},
            ],
        },
    })
    result = SlidesPptxExporter().export(content, path="deck.slides.json")
    deck = Presentation(io.BytesIO(result.data))

    # The skin's page (4:3) survives; its own slide is dropped — only the
    # canvas content ships.
    assert deck.slide_width == Inches(10)
    assert deck.slide_height == Inches(7.5)
    assert len(list(deck.slides)) == 2

    # The branded master styles the new slides: its shape is reachable from
    # the exported slide's own layout chain.
    first = list(deck.slides)[0]
    master_names = [shape.name for shape in first.slide_layout.slide_master.shapes]
    assert "BrandLogo" in master_names
    assert first.slide_layout.name == "Blank"

    # Content still lands as real shapes with percent geometry projected
    # onto the skin's page.
    texts = [s for s in first.shapes if s.has_text_frame and s.text_frame.text]
    ((run,),) = [p.runs for p in texts[0].text_frame.paragraphs]
    assert run.text == "Hello"
    assert run.font.size.pt == 40.5


def test_slides_pptx_unusable_skin_degrades_to_blank_export():
    for template in ("sources/missing.pptx",  # never inlined — reference miss
                     f"data:{PPTX_MIME};base64,{base64.b64encode(b'junk').decode()}"):
        content = json.dumps({
            "type": "slides",
            "data": {"template": template, "slides": [{"title": "T"}]},
        })
        result = SlidesPptxExporter().export(content, path="d.slides.json")
        deck = Presentation(io.BytesIO(result.data))
        assert deck.slide_width == Inches(10)
        assert deck.slide_height == Inches(5.625)  # blank 16:9 default
        assert len(list(deck.slides)) == 1


def _bare_skin_uri(width_in: float, height_in: float) -> str:
    from pptx import Presentation as _P

    skin = _P()
    skin.slide_width = Inches(width_in)
    skin.slide_height = Inches(height_in)
    buf = io.BytesIO()
    skin.save(buf)
    return f"data:{PPTX_MIME};base64,{base64.b64encode(buf.getvalue()).decode()}"


_CIRCLE_DECK_SLIDES = [{
    "elements": [
        # A perfect circle on the 16:9 canvas: 10% of 10in == 17.7778% of 5.625in.
        {"id": "c", "type": "shape", "shape": "ellipse", "x": 10, "y": 10,
         "w": 10, "h": 17.7778, "fill": "#ff0000"},
        {"id": "t", "type": "text", "x": 30, "y": 60, "w": 40, "h": 20,
         "text": "Hi", "fontSize": 40},
    ],
}]


def _circle_and_font(template: str | None) -> tuple[float, float, float]:
    data: dict[str, Any] = {"slides": _CIRCLE_DECK_SLIDES}
    if template:
        data["template"] = template
    content = json.dumps({"type": "slides", "data": data})
    result = SlidesPptxExporter().export(content, path="d.slides.json")
    deck = Presentation(io.BytesIO(result.data))
    (slide,) = deck.slides
    (circle,) = [s for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE]
    (text,) = [s for s in slide.shapes if s.has_text_frame and s.text_frame.text]
    font_pt = text.text_frame.paragraphs[0].runs[0].font.size.pt
    return circle.width / circle.height, circle.top / 914400, font_pt


def test_slides_pptx_uniform_scale_never_distorts_shapes():
    # A circle approved on the 16:9 preview stays a circle on every page.
    # Width and height once scaled separately: on a 4:3 skin the same deck
    # measured ratio 0.750 (an ellipse).
    for template in (None, _bare_skin_uri(10, 7.5), _bare_skin_uri(13.333, 7.5)):
        ratio, _, _ = _circle_and_font(template)
        assert abs(ratio - 1.0) < 0.01


def test_slides_pptx_content_centers_on_a_taller_page():
    # 16:9 content on a 4:3 page: scale stays 1, the leftover 1.875in of
    # height splits evenly — the circle drops by 0.9375in and the margins
    # show the skin's own background.
    _, top_unskinned, _ = _circle_and_font(None)
    _, top_43, _ = _circle_and_font(_bare_skin_uri(10, 7.5))
    assert abs(top_unskinned - 0.5625) < 0.01
    assert abs(top_43 - (0.5625 + 0.9375)) < 0.01


def test_slides_pptx_font_rides_the_page_scale():
    # Shapes and images grow with the page (percent geometry); type must
    # grow with them or it shrinks relative to everything else.
    _, _, base_pt = _circle_and_font(None)
    _, _, wide_pt = _circle_and_font(_bare_skin_uri(13.333, 7.5))
    assert base_pt == 30  # 40px * 0.75, the slice-8 value — regression pin
    assert abs(wide_pt - 30 * 13.333 / 10) < 0.1  # ~39.99pt


def test_slides_pptx_deck_page_sets_the_unskinned_page_size():
    content = json.dumps({"type": "slides", "data": {
        "page": {"widthIn": 10.0, "heightIn": 7.5},
        "slides": [{"title": "T"}],
    }})
    result = SlidesPptxExporter().export(content, path="d.slides.json")
    deck = Presentation(io.BytesIO(result.data))
    assert deck.slide_width == Inches(10)
    assert deck.slide_height == Inches(7.5)


def test_slides_pptx_refuses_a_zip_bomb_skin():
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("ppt/presentation.xml", b"\x00" * (201 * 1024 * 1024))
    bomb_uri = f"data:{PPTX_MIME};base64,{base64.b64encode(buf.getvalue()).decode()}"
    content = json.dumps({"type": "slides", "data": {
        "template": bomb_uri, "slides": [{"title": "T"}],
    }})
    # An attack is refused loudly — never absorbed into a blank-layout degrade.
    with pytest.raises(ValueError, match="unpacks to"):
        SlidesPptxExporter().export(content, path="d.slides.json")


def test_slides_pptx_text_after_an_image_keeps_its_font_size():
    # The picture contain factor once rebound the projection `scale`, so any
    # text AFTER an image inherited a factor in the millions and the export
    # died on pptx's font-size limit. A 1x1 image maximizes the corruption.
    content = _deck([{
        "elements": [
            {"id": "i", "type": "image", "x": 10, "y": 10, "w": 30, "h": 30,
             "src": _png_uri()},
            {"id": "t", "type": "text", "x": 10, "y": 60, "w": 60, "h": 20,
             "text": "After the image", "fontSize": 36},
        ],
    }])
    result = SlidesPptxExporter().export(content, path="d.slides.json")
    deck = Presentation(io.BytesIO(result.data))
    (slide,) = deck.slides
    (text,) = [s for s in slide.shapes if s.has_text_frame and s.text_frame.text]
    assert text.text_frame.paragraphs[0].runs[0].font.size.pt == 27  # 36px * 0.75


def test_pptx_page_size_inches_reads_the_declared_size():
    from pptx import Presentation as _P

    from langchain_canvas.exporters import pptx_page_size_inches

    skin = _P()
    skin.slide_width = Inches(13.333)
    skin.slide_height = Inches(7.5)
    buf = io.BytesIO()
    skin.save(buf)
    size = pptx_page_size_inches(buf.getvalue())
    assert size is not None
    assert abs(size[0] - 13.333) < 0.01
    assert abs(size[1] - 7.5) < 0.01
    assert pptx_page_size_inches(b"not a zip") is None


# --- the export tool -------------------------------------------------------------


@dataclass
class _Runtime:
    context: Any = None
    config: dict[str, Any] = field(default_factory=dict)


def _runtime(thread_id: str = "t1") -> _Runtime:
    return _Runtime(config={"configurable": {"thread_id": thread_id}})


def test_export_tool_writes_under_exports():
    store = InMemoryCanvasStore()
    store.write("t1", "page.html", "<h1>One</h1><p>Body</p>", "seed", actor="agent")
    tool_obj = create_export_tool(store)

    message = tool_obj.func(path="page.html", target="docx", runtime=_runtime())
    assert "exports/page.docx" in message

    exported = store.read_bytes("t1", "exports/page.docx")
    document = Document(io.BytesIO(exported.data))
    assert any(p.text == "One" for p in document.paragraphs)


def test_export_tool_merges_a_directory_in_name_order():
    store = InMemoryCanvasStore()
    store.write("t1", "report/02-b.html", "<h1>Second</h1>", "seed", actor="agent")
    store.write("t1", "report/01-a.html", "<h1>First</h1>", "seed", actor="agent")
    store.write("t1", "report/notes.txt", "not html", "seed", actor="agent")
    tool_obj = create_export_tool(store)

    message = tool_obj.func(path="report/", target="docx", runtime=_runtime())
    assert "exports/report.docx" in message

    document = Document(io.BytesIO(store.read_bytes("t1", "exports/report.docx").data))
    texts = [p.text for p in document.paragraphs if p.text.strip()]
    assert texts.index("First") < texts.index("Second")
    assert 'type="page"' in document.element.xml  # sections split by page break


def test_export_tool_is_honest_about_misses():
    store = InMemoryCanvasStore()
    store.write("t1", "sales.table.json", json.dumps({"data": {}}), "seed", actor="agent")
    tool_obj = create_export_tool(store)

    missing = tool_obj.func(path="nope.html", target="docx", runtime=_runtime())
    assert missing.startswith("Error:")

    wrong_target = tool_obj.func(path="sales.table.json", target="docx", runtime=_runtime())
    assert wrong_target.startswith("Error:")
    assert "xlsx" in wrong_target  # names the formats that would work

    empty_dir = tool_obj.func(path="deck/", target="docx", runtime=_runtime())
    assert empty_dir.startswith("Error:")


def test_export_tool_inlines_slide_assets_before_pptx():
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "assets/logo.png", PNG_1PX, "logo", actor="agent")
    store.write(
        "t1",
        "deck.slides.json",
        _deck([
            {"elements": [
                {"id": "i", "type": "image", "x": 10, "y": 10, "w": 50, "h": 50,
                 "src": "assets/logo.png"},
            ]},
        ]),
        "seed",
        actor="agent",
    )
    tool_obj = create_export_tool(store)

    message = tool_obj.func(path="deck.slides.json", target="pptx", runtime=_runtime())
    assert "exports/Deck.pptx" in message  # the deck's own title names the file

    deck = Presentation(io.BytesIO(store.read_bytes("t1", "exports/Deck.pptx").data))
    (picture,) = [
        s for s in next(iter(deck.slides)).shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE
    ]
    # The stored reference became the stored bytes — the deck is self-contained.
    assert picture.image.blob == PNG_1PX
