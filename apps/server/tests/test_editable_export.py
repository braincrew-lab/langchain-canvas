"""Native objects and source templates must survive export without rasterization."""

import base64
import io

import pytest
from app.agent.exports import EditableDeckPptxExporter, _add_item, _fill
from langchain_canvas.deck import Deck, SlideTemplate, serialize_deck
from langchain_canvas.exporters import PPTX_MIME
from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE, MSO_SHAPE_TYPE
from pptx.util import Inches


def _export(body, source=None):
    content = serialize_deck(
        Deck("Test", "16:9", source, [SlideTemplate("s1", None, "", body)])
    )
    return Presentation(
        io.BytesIO(
            EditableDeckPptxExporter().export(content, path="test.slides.html").data
        )
    )


def _png(size, color):
    data = io.BytesIO()
    Image.new("RGB", size, color).save(data, format="PNG")
    return data.getvalue()


def _url(data, mime="image/png"):
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def test_native_gradients_rounded_shapes_ovals_and_border_alpha():
    deck = _export(
        '<section><div style="position:absolute;left:20px;top:20px;width:240px;height:100px;border-radius:12px;background:linear-gradient(45deg,rgba(255,0,0,.5) 20%,blue 90%);border-bottom:2px solid rgba(0,0,0,.4)"></div><div style="position:absolute;left:300px;top:20px;width:100px;height:100px;border-radius:50%;background:radial-gradient(red,rgba(0,0,255,.7))"></div></section>'
    )
    shapes = list(deck.slides[0].shapes)
    rounded = next(
        s
        for s in shapes
        if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE
        and s.auto_shape_type == MSO_SHAPE.ROUNDED_RECTANGLE
    )
    oval = next(
        s
        for s in shapes
        if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE
        and s.auto_shape_type == MSO_SHAPE.OVAL
    )
    assert rounded.fill.gradient_angle == 45
    assert rounded._element.xpath(".//a:gs/@pos") == ["20000", "90000"]
    assert rounded._element.xpath(".//a:gs/a:srgbClr/a:alpha/@val") == [
        "50000",
        "100000",
    ]
    assert oval._element.xpath(".//a:path/@path") == ["circle"]
    line = next(s for s in shapes if s.shape_type == MSO_SHAPE_TYPE.LINE)
    assert line._element.xpath(".//a:alpha/@val") == ["40000"]
    assert not any(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in shapes)


@pytest.mark.parametrize(
    ("size", "fit", "cropped"),
    [
        ((200, 100), "contain", None),
        ((200, 100), "cover", "horizontal"),
        ((100, 200), "cover", "vertical"),
        ((200, 100), "fill", None),
    ],
)
def test_original_images_keep_bytes_and_expected_fit(size, fit, cropped):
    original = _png(size, "green")
    deck = _export(
        f'<img src="{_url(original)}" style="position:absolute;left:100px;top:100px;width:100px;height:100px;object-fit:{fit}">'
    )
    picture = deck.slides[0].shapes[0]
    assert picture.image.blob == original
    if fit == "contain":
        assert picture.width == 2 * picture.height
    else:
        assert picture.width == picture.height
    assert (picture.crop_left > 0) == (cropped == "horizontal")
    assert (picture.crop_top > 0) == (cropped == "vertical")


def test_source_template_patches_shape_image_and_keeps_native_table():
    source = Presentation()
    slide = source.slides.add_slide(source.slide_layouts[6])
    slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(2), Inches(1)
    )
    slide.shapes.add_picture(io.BytesIO(_png((20, 20), "red")), Inches(4), Inches(1))
    slide.shapes.add_table(1, 1, Inches(1), Inches(4), Inches(2), Inches(1)).table.cell(
        0, 0
    ).text = "Keep table"
    buffer = io.BytesIO()
    source.save(buffer)
    replacement = _png((40, 20), "blue")
    deck = _export(
        '<div data-node-id="box" data-pptx-shape-id="e0" style="position:absolute;left:40px;top:40px;width:200px;height:100px;background:green"></div>'
        + f'<img data-node-id="picture" data-pptx-shape-id="e1" src="{_url(replacement)}" style="position:absolute;left:300px;top:40px;width:200px;height:100px">',
        _url(buffer.getvalue(), PPTX_MIME),
    )
    result = deck.slides[0]
    assert len(result.shapes) == 3
    assert str(result.shapes[0].fill.fore_color.rgb) == "008000"
    assert result.shapes[1].image.blob == replacement
    assert result.shapes[2].table.cell(0, 0).text == "Keep table"


def test_source_decks_fail_closed_for_unresolved_invalid_count_and_provenance():
    for source, message in [
        ("source.pptx", "must be loaded"),
        (_url(b"bad", PPTX_MIME), "Invalid source"),
    ]:
        with pytest.raises(ValueError, match=message):
            _export("<p>Body</p>", source)
    original = Presentation()
    original.slides.add_slide(original.slide_layouts[6])
    buf = io.BytesIO()
    original.save(buf)
    source = _url(buf.getvalue(), PPTX_MIME)
    with pytest.raises(ValueError, match="Unknown native"):
        _export('<p data-node-id="bad" data-pptx-shape-id="e99">Body</p>', source)
    original.slides.add_slide(original.slide_layouts[6])
    buf = io.BytesIO()
    original.save(buf)
    with pytest.raises(ValueError, match="order and count"):
        _export("<p>Body</p>", _url(buf.getvalue(), PPTX_MIME))
    content = serialize_deck(Deck("Empty", "16:9", None, []))
    with pytest.raises(ValueError, match="empty deck"):
        EditableDeckPptxExporter().export(content, path="empty.slides.html")


def test_unsupported_gradient_and_fragment_contract_fail_clearly():
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, 100, 100)
    with pytest.raises(ValueError, match="Unsupported CSS gradient"):
        _fill(shape, {"gradient": "linear-gradient(red,blue)"})
    with pytest.raises(ValueError, match="semantic editing block"):
        _add_item(slide, {"kind": "text", "x": 0, "y": 0, "w": 100, "h": 20}, 1)
