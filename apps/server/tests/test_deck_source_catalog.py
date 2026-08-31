"""``inspect_patterns`` resolves the runtime's own canvas and pins its cursor.

The census/grouping math itself is covered by ``packages/canvas-py``'s
``test_source_inventory.py`` and ``test_source_patterns.py``; these tests
cover the app-layer contract this module owns: canvas scoping, path
restriction, page_limit bounds, and hash-pinned cursor pagination.
"""

from __future__ import annotations

import ctypes
import io
from types import SimpleNamespace

import pytest

from app.agent.deck_source_catalog import inspect_patterns
from langchain_canvas.store import InMemoryCanvasStore

pdfium = pytest.importorskip("pypdfium2")
from pypdfium2 import raw  # noqa: E402


def _text_object(document, text: str, x: float, y: float) -> object:
    obj = raw.FPDFPageObj_NewTextObj(document.raw, b"Helvetica", 18.0)
    encoded = (text + "\x00").encode("utf-16-le")
    buffer = (ctypes.c_ushort * (len(encoded) // 2)).from_buffer_copy(encoded)
    raw.FPDFText_SetText(obj, buffer)
    raw.FPDFPageObj_Transform(obj, 1, 0, 0, 1, x, y)
    return obj


def _pdf(pages: int) -> bytes:
    document = pdfium.PdfDocument.new()
    for n in range(pages):
        page = document.new_page(612.0, 792.0)
        raw.FPDFPage_InsertObject(page.raw, _text_object(document, f"Title {n}", 100, 700))
        page.gen_content()
    out = io.BytesIO()
    document.save(out)
    document.close()
    return out.getvalue()


def _setup():
    store = InMemoryCanvasStore()
    store.write_bytes("thread", "sources/deck.pdf", _pdf(3), "Upload")
    runtime = SimpleNamespace(config={"configurable": {"thread_id": "thread"}}, context=None)
    return store, runtime


# --- canvas/path scoping -----------------------------------------------------------


def test_reads_only_the_runtimes_own_canvas():
    store, runtime = _setup()
    other = SimpleNamespace(config={"configurable": {"thread_id": "other-thread"}}, context=None)

    result = inspect_patterns(store, other, source="sources/deck.pdf")

    assert result["error"]


def test_rejects_paths_outside_sources():
    store, runtime = _setup()

    result = inspect_patterns(store, runtime, source="deck.pdf")

    assert result["error"]


def test_rejects_unsupported_extensions():
    store, runtime = _setup()
    store.write_bytes("thread", "sources/notes.txt", b"hello", "Upload")

    result = inspect_patterns(store, runtime, source="sources/notes.txt")

    assert result["error"]


# --- page_limit bounds ---------------------------------------------------------------


@pytest.mark.parametrize("page_limit", [0, 51])
def test_rejects_page_limit_out_of_bounds(page_limit):
    store, runtime = _setup()

    result = inspect_patterns(store, runtime, source="sources/deck.pdf", page_limit=page_limit)

    assert result["error"]


# --- success shape + hash-pinned cursor ---------------------------------------------


def test_success_shape_and_cursor_round_trip():
    store, runtime = _setup()

    result = inspect_patterns(store, runtime, source="sources/deck.pdf", page_limit=2)

    assert result["source"] == "sources/deck.pdf"
    assert result["page_count"] == 3
    assert result["inspected_pages"] == [1, 2]
    assert result["scope_complete"] is False
    assert result["next_cursor"]
    assert len(result["groups"]) <= 12

    followup = inspect_patterns(
        store, runtime, source="sources/deck.pdf", cursor=result["next_cursor"], page_limit=2
    )
    assert "error" not in followup
    assert followup["inspected_pages"] == [3]
    assert followup["scope_complete"] is True
    assert followup["next_cursor"] is None


def test_stale_cursor_after_source_overwrite():
    store, runtime = _setup()
    result = inspect_patterns(store, runtime, source="sources/deck.pdf", page_limit=2)

    store.write_bytes("thread", "sources/deck.pdf", _pdf(5), "Re-upload")
    followup = inspect_patterns(
        store, runtime, source="sources/deck.pdf", cursor=result["next_cursor"], page_limit=2
    )

    assert followup["error"] == "stale_source"


def test_rejects_malformed_cursor():
    store, runtime = _setup()

    result = inspect_patterns(store, runtime, source="sources/deck.pdf", cursor="not-a-cursor")

    assert result["error"] == "invalid_cursor"
