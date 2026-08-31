"""PDF reconstruction must be LLM-written editable HTML, never page captures."""

import html
import io
import json
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any, cast

import pytest
from langchain_canvas.deck import parse_deck
from langchain_canvas.store import InMemoryCanvasStore
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import PrivateAttr
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
)


class PdfModel(BaseChatModel):
    """A typed provider-boundary fake; writer, review, validation and rendering stay real."""

    responder: Callable[[list[BaseMessage]], str | list[str | dict[str, Any]]]
    _calls: list[list[BaseMessage]] = PrivateAttr(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "pdf-provider-fixture"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self._calls.append(messages)
        content = self.responder(messages)
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content=content,
                        usage_metadata={
                            "input_tokens": 120,
                            "output_tokens": 30,
                            "total_tokens": 150,
                        },
                    )
                )
            ]
        )


def inventory(messages):
    content = messages[1].content
    assert isinstance(content, list) and content[0]["type"] == "text"
    return json.loads(content[0]["text"].split("Source inventory:\n", 1)[1])


def native_html(data):
    body = []
    for index, text in enumerate(data["text_objects"]):
        body.append(
            f'<p data-node-id="text-{index}" data-text-block="true" style="position:absolute;left:{text["css_left"]}px;top:{text["css_top"]}px;width:{text["css_width"]}px;font-family:Arial;font-size:{text["size"]}px;font-weight:{text["weight"]};line-height:{text["line_height"]}px;margin:0;white-space:pre">{html.escape(text.get("display_text", text["text"]))}</p>'
        )
    for index, image in enumerate(data["original_images"]):
        body.append(
            f'<img data-node-id="image-{index}" src="{image["src"]}" style="position:absolute;left:{image["x"]}px;top:{image["y"]}px;width:{image["w"]}px;height:{image["h"]}px">'
        )
    return (
        '<section class="slide" style="position:relative;width:1280px;height:'
        + str(data["height"])
        + 'px">'
        + "".join(body)
        + "</section>"
    )


def normal_response(messages):
    return (
        '{"issues": []}'
        if messages[0].content.startswith("Compare")
        else native_html(inventory(messages))
    )


@pytest.fixture
def model_boundary(monkeypatch):
    from app.agent import pdf_deck

    configured = []

    def bind(responder=normal_response):
        model = PdfModel(responder=responder)
        initializations = []

        def initialize(name, **kwargs):
            initializations.append((name, kwargs))
            return model

        monkeypatch.setattr(pdf_deck, "init_chat_model", initialize)
        configured.append((model, initializations))
        return model, initializations

    yield bind
    for model, calls in configured:
        assert model._calls and calls, (
            "The real pipeline must reach the provider boundary"
        )
        for name, kwargs in calls:
            assert name == pdf_deck.config.writer_model
            assert kwargs["max_retries"] == 0
            assert (kwargs["max_tokens"], kwargs["timeout"]) in {
                (16000, 600),
                (2048, 120),
            }
        assert all(
            isinstance(call[0], SystemMessage) and isinstance(call[1], HumanMessage)
            for call in model._calls
        )


def _open_pdf(**kwargs):
    from app.agent.pdf_deck import open_pdf_as_slides

    function = cast(StructuredTool, open_pdf_as_slides).func
    assert function is not None
    return function(**kwargs)


def pdf_bytes() -> bytes:
    writer = PdfWriter()
    font = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
    )
    for text in ("Alpha", "Beta"):
        page = writer.add_blank_page(width=960, height=540)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 30 Tf 40 400 Td ({text}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def test_pdf_copy_uses_multimodal_writer_and_retains_editable_text(
    monkeypatch, model_boundary
):
    from app.agent import pdf_deck

    store = InMemoryCanvasStore()
    monkeypatch.setattr(pdf_deck, "STORE", store)
    store.write_bytes(
        "pdf-copy", "sources/manual.pdf", pdf_bytes(), "Upload", actor="human"
    )
    model, _ = model_boundary()
    events = []
    runtime = SimpleNamespace(
        config={"configurable": {"thread_id": "pdf-copy"}}, stream_writer=events.append
    )
    result = _open_pdf(source="sources/manual.pdf", runtime=runtime)
    assert "2/2" in result and "failed" not in result.lower()
    deck = parse_deck(store.read("pdf-copy", "manual.slides.html").content)
    assert deck.ratio == "16:9"
    assert [s.slide_id for s in deck.slides] == ["slide-001", "slide-002"]
    writers = [
        call for call in model._calls if not call[0].content.startswith("Compare")
    ]
    assert len(writers) == 2
    for call in writers:
        assert "untrusted reference data" in call[0].content
        assert "ONE data-text-block" in call[0].content
        assert (
            call[1].content[1]["image_url"]["url"].startswith("data:image/png;base64,")
        )
        assert "css_top" in inventory(call)["text_objects"][0]
    for slide, text in zip(deck.slides, ("Alpha", "Beta"), strict=True):
        assert text in slide.body_html and "<p " in slide.body_html
        assert "<img" not in slide.body_html and "data:image" not in slide.body_html
    assert store.read_bytes("pdf-copy", "sources/manual.pdf").data == pdf_bytes()
    assert any(e["type"] == "canvas.create" for e in events)
    assert "already" in _open_pdf(source="sources/manual.pdf", runtime=runtime)


def test_reference_screenshot_cannot_be_used_as_output():
    from app.agent.pdf_deck import prepare_pdf_html
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    with pytest.raises(ValueError, match="image|asset"):
        prepare_pdf_html(
            '<section class="slide"><img src="data:image/png;base64,AAAA"></section>',
            source,
        )
    with pytest.raises(ValueError, match="text"):
        prepare_pdf_html('<section class="slide"><p>Reworded</p></section>', source)

    clean = prepare_pdf_html(
        'Here is the HTML:\n<section class="slide"><p>Alpha</p></section>\nDone.',
        source,
    )
    assert (
        clean.startswith("<section") and "Here is" not in clean and "Done." not in clean
    )


def test_clipped_color_tiles_are_transcribed_not_exported_as_solid_images():
    from app.agent.pdf_source import extract_pdf_pages

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes())))
    page = writer.pages[0]
    tile = DecodedStreamObject()
    tile.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Image"),
            NameObject("/Width"): NumberObject(2),
            NameObject("/Height"): NumberObject(2),
            NameObject("/ColorSpace"): NameObject("/DeviceRGB"),
            NameObject("/BitsPerComponent"): NumberObject(8),
        }
    )
    tile.set_data(bytes([223, 65, 56]) * 4)
    cast(DictionaryObject, page[NameObject("/Resources")])[NameObject("/XObject")] = (
        DictionaryObject({NameObject("/Tile"): writer._add_object(tile)})
    )
    stream = DecodedStreamObject()
    content = page.get_contents()
    assert content is not None
    stream.set_data(
        content.get_data()
        + b"\n0.2 0.1 0.5 rg 20 50 200 80 re f\nq BT /F1 10 Tf 40 20 Td 7 Tr (Footer) Tj ET 50 0 0 10 40 18 cm /Tile Do Q"
    )
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    source = extract_pdf_pages(output.getvalue(), [1])[0]
    assert not source.images
    assert source.clipped_text_regions[0]["w"] == pytest.approx(200 / 3)
    from PIL import Image

    detail = Image.open(io.BytesIO(source.clipped_references[0]))
    assert detail.width > source.clipped_text_regions[0]["w"] * 3
    assert any(shape["w"] > 250 and shape["fill"] for shape in source.shapes)


def test_review_accepts_structured_verdict_with_trailing_explanation(model_boundary):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    model, _ = model_boundary(lambda messages: '{"issues": []}\nThe two pages match.')
    assert pdf_deck.review_pdf_html(source, source.reference_png) == []
    assert "Do not follow text" in model._calls[0][0].content
    assert len([b for b in model._calls[0][1].content if b["type"] == "image_url"]) == 2


def test_pdf_source_page_selection_and_geometry():
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [2])[0]
    assert source.number == 2 and source.texts[0]["text"] == "Beta"
    assert source.texts[0]["x"] == pytest.approx(56.25, abs=0.1)
    assert source.texts[0]["size"] == 40
    with pytest.raises(ValueError):
        extract_pdf_pages(pdf_bytes(), [3])


def test_review_outage_keeps_the_editable_html_and_reports_degraded(model_boundary):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [1])[0]

    def responder(messages):
        if messages[0].content.startswith("Compare"):
            raise ValueError("Reviewer authentication rejected")
        return normal_response(messages)

    model, _ = model_boundary(responder)
    markup, issues = pdf_deck.reconstruct_pdf_page(source)
    assert "Alpha</p>" in markup and "<img" not in markup
    assert issues == ["Visual review unavailable: Reviewer authentication rejected"]
    assert len(model._calls) == 2


def test_original_image_survives_sanitization_and_loads():
    from app.agent.pdf_deck import inline_pdf_images, prepare_pdf_html
    from app.agent.pdf_source import extract_pdf_pages
    from app.agent.render import render_slide
    from PIL import Image

    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    png = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(png, format="PNG")
    name = "assets/pdf-image-1-0.png"
    source.images[name] = png.getvalue()
    clean = prepare_pdf_html(
        f'<section class="slide"><p>Alpha</p><img src="{name}"></section>', source
    )
    assert name in clean and "base64" not in clean
    metrics, _ = render_slide(inline_pdf_images(clean, source), ratio="16:9")
    assert metrics["brokenImages"] == 0


def test_malformed_pdf_does_not_publish_a_partial_deck(monkeypatch):
    from app.agent import pdf_deck

    store = InMemoryCanvasStore()
    monkeypatch.setattr(pdf_deck, "STORE", store)
    store.write_bytes("bad-pdf", "sources/bad.pdf", b"invalid", "Upload", actor="human")
    events = []
    runtime = SimpleNamespace(
        config={"configurable": {"thread_id": "bad-pdf"}}, stream_writer=events.append
    )
    result = _open_pdf(source="sources/bad.pdf", runtime=runtime)
    assert result.startswith("Error:")
    assert [f.path for f in store.list_files("bad-pdf")] == ["sources/bad.pdf"]
    assert events == []


@pytest.mark.parametrize(
    "failure,retry",
    [
        (TimeoutError("provider timed out"), True),
        (ValueError("invalid provider request"), False),
    ],
)
def test_provider_retry_exhaustion_and_nonretryable_errors(
    model_boundary, monkeypatch, failure, retry
):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    calls = []
    monkeypatch.setattr(pdf_deck.time, "sleep", calls.append)

    def fail(messages):
        raise failure

    model, _ = model_boundary(fail)
    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    with pytest.raises(type(failure), match=str(failure)):
        pdf_deck.write_pdf_html(source)
    attempts = pdf_deck.config.model_max_retries + 1 if retry else 1
    assert len(model._calls) == attempts
    assert calls == [min(4, 0.5 * 2**i) for i in range(attempts - 1)]


def test_provider_retry_recovers_and_reads_structured_message_content(
    model_boundary, monkeypatch
):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    sleeps, attempts = [], []
    monkeypatch.setattr(pdf_deck.time, "sleep", sleeps.append)

    def respond(messages):
        attempts.append(messages)
        if len(attempts) == 1:
            raise TimeoutError("transient timeout")
        return [
            {
                "type": "text",
                "text": '```html\n<section class="slide">Alpha</section>\n```',
            }
        ]

    model, _ = model_boundary(respond)
    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    result = pdf_deck.write_pdf_html(source)
    assert result == '<section class="slide">Alpha</section>'
    assert sleeps == [0.5] and len(model._calls) == 2


def test_geometry_correction_sends_previous_html_feedback_and_rendered_image(
    model_boundary,
):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    writes = []

    def respond(messages):
        if messages[0].content.startswith("Compare"):
            return '{"issues": []}'
        writes.append(messages)
        data = inventory(messages)
        if len(writes) == 1:
            data["text_objects"][0]["css_left"] += 50
        return native_html(data)

    model, _ = model_boundary(respond)
    markup, issues = pdf_deck.reconstruct_pdf_page(source)
    assert not issues and "Alpha" in markup and len(writes) == 2
    correction = writes[1][1].content
    assert len([b for b in correction if b["type"] == "image_url"]) == 2
    assert (
        "Required fixes" in correction[-1]["text"]
        and "rendered glyph bounds" in correction[-1]["text"]
    )
    assert len(model._calls) == 4


def test_three_valid_but_misaligned_attempts_return_explicit_degraded_html(
    model_boundary,
):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [1])[0]

    def respond(messages):
        if messages[0].content.startswith("Compare"):
            return '{"issues": ["Shift the heading back to the reference position"]}'
        data = inventory(messages)
        data["text_objects"][0]["css_left"] += 20
        return native_html(data)

    model, _ = model_boundary(respond)
    markup, issues = pdf_deck.reconstruct_pdf_page(source)
    assert "Alpha" in markup and "data:image" not in markup
    assert any("Shift the heading" in issue for issue in issues)
    assert len(model._calls) == 6


@pytest.mark.parametrize(
    "response", ["not JSON", '{"issues": "all fine"}', '{"issues": [7]}']
)
def test_invalid_reviewer_output_is_not_accepted(model_boundary, response):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    model, _ = model_boundary(lambda messages: response)
    with pytest.raises(ValueError):
        pdf_deck.review_pdf_html(source, source.reference_png)
    assert len(model._calls) == 1


def test_reference_crops_are_model_inputs_only_and_both_reviewer_images_are_cropped(
    model_boundary,
):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages
    from PIL import Image

    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    source.clipped_text_regions = [{"x": 1, "y": 2, "w": 10, "h": 5}]
    crops = pdf_deck.source_reference_crops(source)
    assert len(crops) == 1
    assert Image.open(io.BytesIO(crops[0][1])).size == (52, 36)
    source.clipped_references = [crops[0][1]]
    model, _ = model_boundary()
    written = pdf_deck.write_pdf_html(
        source, previous="<section>Old</section>", feedback=["Fix footer"]
    )
    assert "Alpha" in written and "data:image" not in written
    assert pdf_deck.review_pdf_html(source, source.reference_png) == []
    writer_images = [b for b in model._calls[0][1].content if b["type"] == "image_url"]
    reviewer_images = [
        b for b in model._calls[1][1].content if b["type"] == "image_url"
    ]
    assert len(writer_images) == 2 and len(reviewer_images) == 4
    assert "never use the crop as output" in str(model._calls[0][1].content)


def pdf_with_original_image():
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes())))
    page = writer.pages[0]
    image = DecodedStreamObject()
    image.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Image"),
            NameObject("/Width"): NumberObject(10),
            NameObject("/Height"): NumberObject(10),
            NameObject("/ColorSpace"): NameObject("/DeviceRGB"),
            NameObject("/BitsPerComponent"): NumberObject(8),
        }
    )
    image.set_data(bytes([30, 170, 80]) * 100)
    cast(DictionaryObject, page[NameObject("/Resources")])[NameObject("/XObject")] = (
        DictionaryObject({NameObject("/Figure"): writer._add_object(image)})
    )
    stream = DecodedStreamObject()
    content = page.get_contents()
    assert content is not None
    stream.set_data(content.get_data() + b"\nq 100 0 0 70 300 200 cm /Figure Do Q")
    page[NameObject("/Contents")] = writer._add_object(stream)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def test_public_import_persists_only_original_images_and_keeps_source_immutable(
    monkeypatch, model_boundary
):
    from app.agent import pdf_deck

    store = InMemoryCanvasStore()
    monkeypatch.setattr(pdf_deck, "STORE", store)
    original = pdf_with_original_image()
    store.write_bytes("images", "sources/figures.pdf", original, "Upload")
    model, _ = model_boundary()
    runtime = SimpleNamespace(
        config={"configurable": {"thread_id": "images"}}, stream_writer=None
    )
    result = _open_pdf(
        source="sources/figures.pdf",
        destination="editable.slides.html",
        pages=[1],
        runtime=runtime,
    )
    assert "1/1" in result and "Not fully" not in result
    deck = parse_deck(store.read("images", "editable.slides.html").content)
    assert (
        "<img" in deck.slides[0].body_html
        and "data:image" not in deck.slides[0].body_html
    )
    asset = inventory(model._calls[0])["original_images"][0]["src"]
    assert asset in deck.slides[0].body_html
    assert store.read_bytes("images", asset).data.startswith(b"\x89PNG")
    assert store.read_bytes("images", "sources/figures.pdf").data == original


def test_one_failed_page_does_not_discard_successful_html(monkeypatch, model_boundary):
    from app.agent import pdf_deck

    store = InMemoryCanvasStore()
    monkeypatch.setattr(pdf_deck, "STORE", store)
    store.write_bytes("partial", "sources/manual.pdf", pdf_bytes(), "Upload")

    def respond(messages):
        if (
            not messages[0].content.startswith("Compare")
            and inventory(messages)["page"] == 2
        ):
            raise ValueError("Second page request rejected")
        return normal_response(messages)

    model, _ = model_boundary(respond)
    events = []
    runtime = SimpleNamespace(
        config={"configurable": {"thread_id": "partial"}}, stream_writer=events.append
    )
    result = _open_pdf(source="sources/manual.pdf", runtime=runtime)
    assert "1/2" in result and "Second page request rejected" in result
    slides = parse_deck(store.read("partial", "manual.slides.html").content).slides
    assert "Alpha" in slides[0].body_html and "Reconstructing" in slides[1].body_html
    assert len(model._calls) == 3
    assert any(e.get("stage") == "degraded" for e in events)
    assert any(e.get("stage") == "complete" for e in events)


@pytest.mark.parametrize(
    "source,destination",
    [
        ("manual.pdf", None),
        ("sources/manual.txt", None),
        ("sources/manual.pdf", "sources/result.slides.html"),
        ("sources/manual.pdf", "exports/result.slides.html"),
        ("sources/manual.pdf", "result.pptx"),
    ],
)
def test_public_import_rejects_invalid_paths_without_publishing(
    monkeypatch, source, destination
):
    from app.agent import pdf_deck

    store = InMemoryCanvasStore()
    monkeypatch.setattr(pdf_deck, "STORE", store)
    runtime = SimpleNamespace(
        config={"configurable": {"thread_id": "paths"}}, stream_writer=None
    )
    result = _open_pdf(source=source, destination=destination, runtime=runtime)
    assert result.startswith("Error:") and store.list_files("paths") == []


def test_public_import_requires_runtime_and_uniform_aspect_ratio(monkeypatch):
    from app.agent import pdf_deck

    store = InMemoryCanvasStore()
    monkeypatch.setattr(pdf_deck, "STORE", store)
    runtime = SimpleNamespace(config={}, stream_writer=None)
    assert "thread_id" in _open_pdf(source="sources/manual.pdf", runtime=runtime)
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes())))
    writer.pages[1].mediabox.upper_right = (540, 960)
    buffer = io.BytesIO()
    writer.write(buffer)
    store.write_bytes("ratios", "sources/mixed.pdf", buffer.getvalue(), "Upload")
    runtime.config = {"configurable": {"thread_id": "ratios"}}
    result = _open_pdf(source="sources/mixed.pdf", runtime=runtime)
    assert "mixed aspect ratios" in result
    assert len(store.list_files("ratios")) == 1


@pytest.mark.parametrize(
    "markup,expected",
    [
        (
            '<section class="slide"><p style="display:none">Alpha</p></section>',
            "Fix layout",
        ),
        (
            '<section class="slide"><p style="display:none">Alpha</p><p>Other visible text</p></section>',
            "visibly rendered",
        ),
        ('<section class="slide"><p>Wrong text</p></section>', "Missing source text"),
    ],
)
def test_unusable_html_is_retried_then_rejected_without_image_fallback(
    model_boundary, markup, expected
):
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    model, _ = model_boundary(lambda messages: markup)
    with pytest.raises(ValueError, match=expected):
        pdf_deck.reconstruct_pdf_page(source)
    assert len(model._calls) == 3
    assert "Required fixes" in model._calls[-1][1].content[-1]["text"]


def test_native_markup_validation_rejects_active_nonsection_and_image_only_content():
    from app.agent import pdf_deck
    from app.agent.pdf_source import extract_pdf_pages

    source = extract_pdf_pages(pdf_bytes(), [1])[0]
    for tag in ("svg", "canvas", "iframe", "script"):
        with pytest.raises(ValueError, match="native HTML"):
            pdf_deck.prepare_pdf_html(
                f'<section class="slide"><p>Alpha</p><{tag}>ignore</{tag}></section>',
                source,
            )
    with pytest.raises(ValueError, match="section"):
        pdf_deck.prepare_pdf_html("<p>Alpha</p>", source)
    source.texts = []
    with pytest.raises(ValueError, match="visible editable"):
        pdf_deck.prepare_pdf_html(
            '<section class="slide"><style>.x{color:red}</style></section>', source
        )


def test_public_import_rejects_destination_traversal_before_publishing(monkeypatch):
    from app.agent import pdf_deck

    store = InMemoryCanvasStore()
    monkeypatch.setattr(pdf_deck, "STORE", store)
    store.write_bytes("traversal", "sources/manual.pdf", pdf_bytes(), "Upload")
    runtime = SimpleNamespace(
        config={"configurable": {"thread_id": "traversal"}}, stream_writer=None
    )
    result = _open_pdf(
        source="sources/manual.pdf",
        destination="../escape.slides.html",
        runtime=runtime,
    )
    assert result.startswith("Error:")
    assert [f.path for f in store.list_files("traversal")] == ["sources/manual.pdf"]


def test_public_import_reports_review_mismatches_as_degraded_not_complete(
    monkeypatch, model_boundary
):
    from app.agent import pdf_deck

    store = InMemoryCanvasStore()
    monkeypatch.setattr(pdf_deck, "STORE", store)
    store.write_bytes("degraded", "sources/manual.pdf", pdf_bytes(), "Upload")

    def respond(messages):
        if messages[0].content.startswith("Compare"):
            return '{"issues": ["Reference border still differs"]}'
        return normal_response(messages)

    model, _ = model_boundary(respond)
    events = []
    runtime = SimpleNamespace(
        config={"configurable": {"thread_id": "degraded"}}, stream_writer=events.append
    )
    result = _open_pdf(source="sources/manual.pdf", pages=[1], runtime=runtime)
    assert "0/1" in result and "Reference border still differs" in result
    assert "Not fully reproduced" in result
    assert (
        "Alpha"
        in parse_deck(store.read("degraded", "manual.slides.html").content)
        .slides[0]
        .body_html
    )
    assert len(model._calls) == 6
    assert any(event.get("stage") == "degraded" for event in events)
