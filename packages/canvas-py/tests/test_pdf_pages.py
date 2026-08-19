"""PDF page rendering — the agent's eye on scans, charts and layout.

Fixture PDFs are built with Pillow (image-only pages, like scans), so these
tests cover exactly the case the text layer cannot: pages with nothing to
extract. Rendering is recomputed every call by design — persistent previews
belong to the file-artifact track.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass, field
from typing import Any

import pytest
from PIL import Image

from langchain_canvas import InMemoryCanvasStore, create_canvas_tools
from langchain_canvas.converters import MAX_IMAGES_PER_CALL, PdfSourceConverter
from langchain_canvas.tools import _parse_pages

PNG_MAGIC = b"\x89PNG"


def _pdf(pages: int, size: tuple[int, int] = (200, 280)) -> bytes:
    images = [Image.new("RGB", size, (240, 240, 240)) for _ in range(pages)]
    out = io.BytesIO()
    images[0].save(out, format="PDF", save_all=True, append_images=images[1:])
    return out.getvalue()


def _images(blocks: list[dict[str, Any]]) -> list[bytes]:
    return [
        base64.b64decode(block["data"]) for block in blocks if block.get("type") == "image"
    ]


# --- _parse_pages ----------------------------------------------------------------


def test_parse_pages_singles_ranges_lists_and_dedupe():
    assert _parse_pages("3") == [3]
    assert _parse_pages("2-5") == [2, 3, 4, 5]
    assert _parse_pages("1,4,7") == [1, 4, 7]
    assert _parse_pages("1,3-5,3") == [1, 3, 4, 5]


@pytest.mark.parametrize("bad", ["abc", "5-3", "0", "0-2", ""])
def test_parse_pages_rejects_nonsense(bad: str):
    with pytest.raises(ValueError):
        _parse_pages(bad)


# --- PdfSourceConverter.render_pages ----------------------------------------------


def test_render_pages_labels_each_image():
    converted = PdfSourceConverter().render_pages(_pdf(3), path="doc.pdf", pages=[1, 3])
    kinds = [b["type"] for b in converted.blocks]
    assert kinds == ["text", "image", "text", "image"]
    assert converted.blocks[0]["text"] == "### page 1 (image follows)"
    assert converted.blocks[2]["text"] == "### page 3 (image follows)"
    for png in _images(converted.blocks):
        assert png[:4] == PNG_MAGIC
    assert converted.metadata["pages"] == 3
    assert converted.metadata["rendered"] == "1, 3"


def test_render_pages_rejects_out_of_range():
    with pytest.raises(ValueError, match="valid range is 1-2"):
        PdfSourceConverter().render_pages(_pdf(2), path="doc.pdf", pages=[3])


def test_render_pages_degrades_to_text_note_when_no_scale_fits():
    converter = PdfSourceConverter()
    converter.max_bytes = 10  # nothing fits
    converted = converter.render_pages(_pdf(1), path="doc.pdf", pages=[1])
    assert [b["type"] for b in converted.blocks] == ["text"]
    assert "could not be inlined" in converted.blocks[0]["text"]


# --- PdfSourceConverter.render_grid -----------------------------------------------


def test_render_grid_tiles_pages_into_labeled_sheets():
    converted = PdfSourceConverter().render_grid(_pdf(25), path="doc.pdf")
    labels = [b["text"] for b in converted.blocks if b["type"] == "text"]
    assert labels[0].startswith("### pages 1-20 (grid overview")
    assert labels[1].startswith("### pages 21-25 (grid overview")
    assert len(_images(converted.blocks)) == 2
    assert converted.metadata["pages"] == 25


def test_render_grid_refuses_documents_beyond_the_sheet_cap():
    pages = MAX_IMAGES_PER_CALL * 20 + 1
    with pytest.raises(ValueError, match="Read the text layer first"):
        PdfSourceConverter().render_grid(_pdf(pages, size=(40, 56)), path="big.pdf")


# --- read_canvas(pages=...) -------------------------------------------------------


@dataclass
class _Runtime:
    context: Any = None
    config: dict[str, Any] = field(default_factory=dict)


def _tools(store: InMemoryCanvasStore) -> Any:
    return {t.name: t for t in create_canvas_tools(store)}


def _runtime() -> _Runtime:
    return _Runtime(config={"configurable": {"thread_id": "t1"}})


def test_read_canvas_pages_returns_header_labels_and_images():
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "sources/deck.pdf", _pdf(3), "Upload deck.pdf")
    result = _tools(store)["read_canvas"].func(
        path="sources/deck.pdf", runtime=_runtime(), pages="2"
    )
    assert isinstance(result, list)
    assert result[0]["type"] == "text"
    assert "revision:" in result[0]["text"] and "pages: 3" in result[0]["text"]
    assert result[1]["text"] == "### page 2 (image follows)"
    assert result[2]["type"] == "image"


def test_read_canvas_pages_grid_routes_to_the_overview():
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "sources/deck.pdf", _pdf(2), "Upload deck.pdf")
    result = _tools(store)["read_canvas"].func(
        path="sources/deck.pdf", runtime=_runtime(), pages="grid"
    )
    assert isinstance(result, list)
    assert any(b["type"] == "image" for b in result)
    assert any("grid overview" in b.get("text", "") for b in result if b["type"] == "text")


def test_read_canvas_pages_enforces_the_per_call_limit():
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "sources/deck.pdf", _pdf(12), "Upload deck.pdf")
    result = _tools(store)["read_canvas"].func(
        path="sources/deck.pdf", runtime=_runtime(), pages="1-9"
    )
    assert isinstance(result, str)
    assert "limit is 8 per call" in result


def test_read_canvas_pages_on_a_non_renderable_file_says_so():
    store = InMemoryCanvasStore()
    store.write("t1", "notes.md", "# hi", "Write notes")
    result = _tools(store)["read_canvas"].func(path="notes.md", runtime=_runtime(), pages="1")
    assert isinstance(result, str)
    assert "page-renderable sources (.pdf)" in result


def test_read_canvas_pages_relays_range_and_spec_errors():
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "sources/deck.pdf", _pdf(2), "Upload deck.pdf")
    tools = _tools(store)
    out_of_range = tools["read_canvas"].func(
        path="sources/deck.pdf", runtime=_runtime(), pages="9"
    )
    assert "valid range is 1-2" in out_of_range
    bad_spec = tools["read_canvas"].func(
        path="sources/deck.pdf", runtime=_runtime(), pages="abc"
    )
    assert "page numbers like" in bad_spec
