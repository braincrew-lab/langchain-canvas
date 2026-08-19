"""Uploads shown as themselves — the `file` artifact and its derived previews.

The contract under test: every ``sources/`` upload produces wire events, so
the person who uploaded a file sees it on the canvas. Text formats keep their
editable-ish previews (covered in test_replay.py); everything else becomes a
``file`` artifact whose previews step down honestly — page-one cover, text
excerpt, bare card — depending on what the installed converters can derive.
"""

from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from langchain_canvas import InMemoryCanvasStore, hydrate_events, source_preview_events
from langchain_canvas.converters import MissingConverterDependencyError, PdfSourceConverter
from langchain_canvas.replay import _PREVIEW_CACHE

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _pdf(pages: int) -> bytes:
    images = [Image.new("RGB", (200, 280), (240, 240, 240)) for _ in range(pages)]
    out = io.BytesIO()
    images[0].save(out, format="PDF", save_all=True, append_images=images[1:])
    return out.getvalue()


def _docx(paragraphs: list[str]) -> bytes:
    from docx import Document

    document = Document()
    for text in paragraphs:
        document.add_paragraph(text)
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


@pytest.fixture(autouse=True)
def _clear_preview_cache():
    _PREVIEW_CACHE.clear()
    yield
    _PREVIEW_CACHE.clear()


def _create_event(events: list[dict]) -> dict:
    return next(e for e in events if e["type"] == "canvas.create")["artifact"]


# --- per-format previews ----------------------------------------------------------


def test_image_upload_is_a_reference_not_a_copy() -> None:
    store = InMemoryCanvasStore()
    store.write_bytes("c1", "sources/photo.png", PNG_BYTES, "Upload photo.png")
    artifact = _create_event(hydrate_events(store, "c1"))
    assert artifact["type"] == "file"
    assert artifact["title"] == "photo.png"
    data = artifact["data"]
    assert data["path"] == "sources/photo.png"
    assert data["mediaType"] == "image/png"
    assert data["size"] == len(PNG_BYTES)
    # No derived preview for images: the renderer draws the original bytes
    # through the asset endpoint — one truth, nothing duplicated on the wire.
    assert data["cover"] is None and data["excerpt"] is None


def test_pdf_upload_gets_a_page_one_cover_and_page_count() -> None:
    store = InMemoryCanvasStore()
    store.write_bytes("c1", "sources/deck.pdf", _pdf(3), "Upload deck.pdf")
    data = _create_event(hydrate_events(store, "c1"))["data"]
    assert data["cover"].startswith("data:image/jpeg;base64,")
    assert data["detail"] == "3 pages"
    assert data["excerpt"] is None


def test_pdf_without_page_rendering_falls_back_to_a_text_excerpt(monkeypatch) -> None:
    # pdf-images extra missing → no cover; the pypdf text path still gives an
    # honest excerpt (here: the no-text-layer note, since the pages are images).
    def _no_renderer(self, data):  # noqa: ARG001
        raise MissingConverterDependencyError("pypdfium2 not installed")

    monkeypatch.setattr(PdfSourceConverter, "_document", _no_renderer)
    store = InMemoryCanvasStore()
    store.write_bytes("c1", "sources/deck.pdf", _pdf(2), "Upload deck.pdf")
    data = _create_event(hydrate_events(store, "c1"))["data"]
    assert data["cover"] is None
    assert "page 1" in data["excerpt"]
    assert data["detail"] == "2 pages · 2 pages without text"


def test_docx_upload_gets_a_text_excerpt_and_summary() -> None:
    store = InMemoryCanvasStore()
    store.write_bytes(
        "c1", "sources/notes.docx", _docx(["Quarterly summary", "Line A is on plan."]), "Upload"
    )
    data = _create_event(hydrate_events(store, "c1"))["data"]
    assert "Quarterly summary" in data["excerpt"]
    assert data["detail"] == "2 paragraphs · 0 tables"
    assert data["cover"] is None


def test_csv_upload_gets_a_text_excerpt() -> None:
    store = InMemoryCanvasStore()
    store.write("c1", "sources/rows.csv", "dept,amount\nSales,120\n", "Upload rows.csv")
    data = _create_event(hydrate_events(store, "c1"))["data"]
    assert "dept,amount" in data["excerpt"]


def test_long_text_is_truncated_with_an_ellipsis() -> None:
    store = InMemoryCanvasStore()
    store.write("c1", "sources/big.csv", "x" * 2000, "Upload big.csv")
    data = _create_event(hydrate_events(store, "c1"))["data"]
    assert len(data["excerpt"]) == 401 and data["excerpt"].endswith("…")


def test_unknown_binary_gets_the_bare_card() -> None:
    store = InMemoryCanvasStore()
    store.write_bytes("c1", "sources/blob.bin", b"\x00\x01\x02", "Upload blob.bin")
    data = _create_event(hydrate_events(store, "c1"))["data"]
    assert data["name"] == "blob.bin" and data["size"] == 3
    assert data["cover"] is None and data["excerpt"] is None


# --- event mechanics --------------------------------------------------------------


def test_reupload_patches_every_file_data_key() -> None:
    store = InMemoryCanvasStore()
    store.write_bytes("c1", "sources/photo.png", PNG_BYTES, "Upload photo.png")
    store.write_bytes("c1", "sources/photo.png", PNG_BYTES + b"x", "Upload photo.png again")
    events = hydrate_events(store, "c1")
    kinds = [e["type"] for e in events]
    assert kinds == [
        "canvas.create",
        "canvas.status",
        "canvas.commit",
        "canvas.patch",
        "canvas.commit",
    ]
    patch = next(e for e in events if e["type"] == "canvas.patch")["patch"]
    assert patch["size"] == len(PNG_BYTES) + 1
    assert set(patch) == {"path", "name", "mediaType", "size", "cover", "excerpt", "detail"}


def test_upload_endpoint_and_replay_share_one_builder() -> None:
    # The live events a host returns from its upload endpoint and the events a
    # reload replays come from the same function — they can never disagree.
    store = InMemoryCanvasStore()
    commit = store.write_bytes("c1", "sources/photo.png", PNG_BYTES, "Upload photo.png")
    live = source_preview_events(
        store,
        "c1",
        "sources/photo.png",
        is_new=True,
        revision=commit.revision,
        description="Upload photo.png",
    )
    assert live == hydrate_events(store, "c1")


def test_text_preview_formats_are_unchanged() -> None:
    # The six text formats keep their editable-ish previews — no file card.
    store = InMemoryCanvasStore()
    store.write("c1", "sources/notes.md", "# Notes\nhello", "Upload notes.md")
    artifact = _create_event(hydrate_events(store, "c1"))
    assert artifact["type"] == "document"


def test_derivation_is_cached_per_revision() -> None:
    calls = {"n": 0}
    original = PdfSourceConverter.render_pages

    def _counting(self, data, *, path, pages):
        calls["n"] += 1
        return original(self, data, path=path, pages=pages)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(PdfSourceConverter, "render_pages", _counting)
        store = InMemoryCanvasStore()
        store.write_bytes("c1", "sources/deck.pdf", _pdf(1), "Upload deck.pdf")
        first = hydrate_events(store, "c1")
        second = hydrate_events(store, "c1")
    assert first == second
    assert calls["n"] == 1, "the page render must be derived once per revision, then cached"
