"""Canvas asset wiring — the write tool, the reference contract, export survival.

The contract under test: a relative ``assets/`` / ``sources/`` path inside
canvas content points at a file on the same canvas; display resolves it live
and export inlines the bytes. These tests pin the Python half (the tool and
the inliner); the TypeScript half has its own suite, and the prefix list is
parity-pinned in ``test_protocol_parity.py``.
"""

from __future__ import annotations

import base64
import io
import zipfile
from dataclasses import dataclass, field
from typing import Any

from langchain_canvas import InMemoryCanvasStore, create_asset_tool, create_export_tool
from langchain_canvas.assets import inline_canvas_assets

# A valid 1x1 transparent PNG.
PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
PNG_BYTES = base64.b64decode(PNG_B64)


@dataclass
class _Runtime:
    context: Any = None
    config: dict[str, Any] = field(default_factory=dict)


def _runtime() -> _Runtime:
    return _Runtime(config={"configurable": {"thread_id": "t1"}})


# --- inline_canvas_assets ---------------------------------------------------------


def test_inline_replaces_assets_and_sources_references():
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "assets/logo.png", PNG_BYTES, "Add logo")
    store.write_bytes("t1", "sources/photo.jpg", b"jpegbytes", "Upload photo")
    html = '<img src="assets/logo.png"> and <img src=\'sources/photo.jpg\'>'
    out = inline_canvas_assets(html, store, "t1")
    assert f'src="data:image/png;base64,{PNG_B64}"' in out
    expected_jpg = base64.b64encode(b"jpegbytes").decode()
    assert f"src='data:image/jpeg;base64,{expected_jpg}'" in out


def test_inline_leaves_unresolvable_references_untouched():
    store = InMemoryCanvasStore()
    store.write("t1", "assets/notes.txt", "hi", "Add notes")
    html = (
        '<img src="assets/missing.png">'
        '<img src="assets/notes.txt">'
        '<img src="https://example.com/x.png">'
        '<img src="data:image/png;base64,AA==">'
    )
    assert inline_canvas_assets(html, store, "t1") == html


def test_inline_svg_gets_its_mime():
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "assets/icon.svg", b"<svg/>", "Add icon")
    out = inline_canvas_assets('<img src="assets/icon.svg">', store, "t1")
    assert "data:image/svg+xml;base64," in out


def test_inline_folds_document_relative_forms_onto_the_root():
    # A model writing report/02-site.html tends to produce ../sources/… — store
    # paths can never contain .., so folding onto the root reading is lossless.
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "sources/photo.png", PNG_BYTES, "Upload photo")
    for form in ("../sources/photo.png", "../../sources/photo.png", "./sources/photo.png"):
        out = inline_canvas_assets(f'<img src="{form}">', store, "t1")
        assert f'src="data:image/png;base64,{PNG_B64}"' in out, form
    untouched = '<img src="../report/01-intro.html">'
    assert inline_canvas_assets(untouched, store, "t1") == untouched


# --- write_canvas_asset -----------------------------------------------------------


def _asset_tool(store: InMemoryCanvasStore) -> Any:
    return create_asset_tool(store)


def test_asset_tool_stores_under_assets_and_teaches_the_reference():
    store = InMemoryCanvasStore()
    result = _asset_tool(store).func(
        path="logo.png", content_base64=PNG_B64, description="Add logo", runtime=_runtime()
    )
    assert "Wrote assets/logo.png" in result
    assert '<img src="assets/logo.png">' in result
    got = store.read_bytes("t1", "assets/logo.png")
    assert got.data == PNG_BYTES
    assert "revision " + got.revision in result


def test_asset_tool_accepts_explicit_assets_path_and_data_uri_payload():
    store = InMemoryCanvasStore()
    result = _asset_tool(store).func(
        path="assets/pic.png",
        content_base64=f"data:image/png;base64,{PNG_B64}",
        description="Add pic",
        runtime=_runtime(),
    )
    assert "Wrote assets/pic.png" in result
    assert store.read_bytes("t1", "assets/pic.png").data == PNG_BYTES


def test_asset_tool_refuses_sources_and_other_directories():
    store = InMemoryCanvasStore()
    tool = _asset_tool(store)
    refused = tool.func(
        path="sources/photo.png", content_base64=PNG_B64, description="d", runtime=_runtime()
    )
    assert refused.startswith("Error:") and "sources/" in refused
    elsewhere = tool.func(
        path="exports/out.png", content_base64=PNG_B64, description="d", runtime=_runtime()
    )
    assert elsewhere.startswith("Error:") and "assets/" in elsewhere
    assert store.list_files("t1") == []


def test_asset_tool_refuses_non_image_and_bad_base64():
    store = InMemoryCanvasStore()
    tool = _asset_tool(store)
    not_image = tool.func(
        path="notes.txt", content_base64=PNG_B64, description="d", runtime=_runtime()
    )
    assert not_image.startswith("Error:") and "write_canvas" in not_image
    bad = tool.func(
        path="logo.png", content_base64="not*base64!", description="d", runtime=_runtime()
    )
    assert bad == "Error: content_base64 is not valid base64."
    empty = tool.func(path="logo.png", content_base64="", description="d", runtime=_runtime())
    assert empty.startswith("Error:")
    assert store.list_files("t1") == []


def test_asset_tool_rides_the_commit_history():
    store = InMemoryCanvasStore()
    tool = _asset_tool(store)
    tool.func(path="a.png", content_base64=PNG_B64, description="first", runtime=_runtime())
    tool.func(path="a.png", content_base64=PNG_B64, description="second", runtime=_runtime())
    descriptions = [c.description for c in store.history("t1")]
    assert descriptions == ["second", "first"]
    assert all(c.actor == "agent" for c in store.history("t1"))


# --- export survival --------------------------------------------------------------


def test_export_inlines_assets_before_the_exporter_runs():
    store = InMemoryCanvasStore()
    store.write("t1", "page.html", '<h1>Hi</h1><img src="assets/logo.png">', "Create page")
    store.write_bytes("t1", "assets/logo.png", PNG_BYTES, "Add logo")

    captured: dict[str, str] = {}

    class _CaptureExporter:
        suffixes = (".html",)
        target = "docx"

        def export(self, content: str, *, path: str, title: str | None = None) -> Any:
            from langchain_canvas.exporters import ExportedFile

            captured["content"] = content
            return ExportedFile(b"bytes", "page.docx", "application/x-test")

    result = create_export_tool(store, exporters=[_CaptureExporter()]).func(
        path="page.html", target="docx", runtime=_runtime()
    )
    assert "Exported page.html" in result
    assert f"data:image/png;base64,{PNG_B64}" in captured["content"]
    assert "assets/logo.png" not in captured["content"]


def test_exported_docx_carries_the_image():
    store = InMemoryCanvasStore()
    store.write(
        "t1",
        "report/02-overview.html",
        '<h1>Overview</h1><p>See the chart:</p><img src="assets/logo.png">',
        "Create page",
    )
    store.write_bytes("t1", "assets/logo.png", PNG_BYTES, "Add logo")

    result = create_export_tool(store).func(
        path="report/02-overview.html", target="docx", runtime=_runtime()
    )
    assert "Exported report/02-overview.html" in result
    data = store.read_bytes("t1", "exports/02-overview.docx").data
    media = [n for n in zipfile.ZipFile(io.BytesIO(data)).namelist() if n.startswith("word/media/")]
    assert media, "the docx should embed the referenced asset as a media part"


def test_directory_export_inlines_across_merged_sections():
    store = InMemoryCanvasStore()
    store.write("t1", "report/01-intro.html", "<h1>Intro</h1>", "Create intro")
    store.write("t1", "report/02-body.html", '<img src="sources/photo.png">', "Create body")
    store.write_bytes("t1", "sources/photo.png", PNG_BYTES, "Upload photo")

    captured: dict[str, str] = {}

    class _CaptureExporter:
        suffixes = (".html",)
        target = "docx"

        def export(self, content: str, *, path: str, title: str | None = None) -> Any:
            from langchain_canvas.exporters import ExportedFile

            captured["content"] = content
            return ExportedFile(b"bytes", "report.docx", "application/x-test")

    create_export_tool(store, exporters=[_CaptureExporter()]).func(
        path="report/", target="docx", runtime=_runtime()
    )
    assert f"data:image/png;base64,{PNG_B64}" in captured["content"]
