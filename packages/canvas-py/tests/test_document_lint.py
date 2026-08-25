"""Document lint — one certain finding, silence everywhere else.

The false-positive suite is the point: a reference that resolves, a link to
the open web, an inline data URI, a path that is not a canvas reference at
all, and an example written inside a code fence must all pass in silence.
One warning among those means the check has to be narrowed or cut.
"""

from __future__ import annotations

from typing import Any

import pytest

from langchain_canvas.document_lint import (
    format_document_warnings,
    is_document_path,
    lint_document_content,
)
from langchain_canvas.store import InMemoryCanvasStore
from langchain_canvas.tools import create_canvas_tools


class _Runtime:
    """The slice of ToolRuntime the canvas tools read."""

    def __init__(self) -> None:
        self.context = None
        self.config = {"configurable": {"thread_id": "t1"}}
        self.stream_writer = None


def _tools(store: InMemoryCanvasStore) -> dict[str, Any]:
    return {t.name: t for t in create_canvas_tools(store)}


def _on_canvas(*paths: str):
    return frozenset(paths).__contains__


# --- the finding ----------------------------------------------------------


def test_a_reference_to_a_file_the_canvas_lacks_is_reported() -> None:
    warnings = lint_document_content(
        "# Report\n\n![site photo](sources/IMG_1946.jpg)\n",
        path="report.md",
        ref_exists=_on_canvas(),
    )
    assert len(warnings) == 1
    assert "sources/IMG_1946.jpg" in warnings[0]
    assert "line 3" in warnings[0]


def test_the_warning_says_how_to_fix_it() -> None:
    (warning,) = lint_document_content(
        "![x](assets/logo.png)", path="a.md", ref_exists=_on_canvas()
    )
    assert "Bring the file onto the canvas first" in warning
    assert "list_canvas_files" in warning


def test_a_page_is_checked_through_its_src_attribute() -> None:
    (warning,) = lint_document_content(
        '<img src="sources/photo.png">', path="page.html", ref_exists=_on_canvas()
    )
    assert "sources/photo.png" in warning


@pytest.mark.parametrize(
    "content",
    [
        "![x](<sources/a photo.png>)",
        '![x](sources/photo.png "a title")',
        "<img alt='x' src='assets/logo.png'/>",
    ],
)
def test_every_reference_spelling_is_seen(content: str) -> None:
    assert lint_document_content(content, path="a.md", ref_exists=_on_canvas())


def test_the_same_missing_file_is_one_finding_not_many() -> None:
    body = "\n".join(f"![x](sources/a.png) line {n}" for n in range(6))
    (warning,) = lint_document_content(body, path="a.md", ref_exists=_on_canvas())
    assert "line 1 and 5 more" in warning


def test_a_document_with_many_broken_links_names_the_pattern() -> None:
    body = "\n".join(f"![x](sources/{n}.png)" for n in range(20))
    warnings = lint_document_content(body, path="a.md", ref_exists=_on_canvas())
    assert len(warnings) == 9
    assert warnings[-1] == "... and 12 more like these"


# --- silence --------------------------------------------------------------


def test_a_reference_that_resolves_is_silent() -> None:
    assert (
        lint_document_content(
            "![x](sources/photo.png)",
            path="a.md",
            ref_exists=_on_canvas("sources/photo.png"),
        )
        == []
    )


def test_the_document_relative_form_resolves_the_same_way() -> None:
    assert (
        lint_document_content(
            "![x](../sources/photo.png)",
            path="folder/a.md",
            ref_exists=_on_canvas("sources/photo.png"),
        )
        == []
    )


@pytest.mark.parametrize(
    "content",
    [
        "![x](https://example.com/photo.png)",
        "![x](http://example.com/photo.png)",
        "![x](data:image/png;base64,iVBORw0KGgo=)",
        '<img src="https://example.com/a.png">',
        "![x](photo.png)",
        "![x](/absolute/photo.png)",
        "[a link](sources/photo.png)",
    ],
)
def test_what_is_not_a_canvas_reference_is_never_checked(content: str) -> None:
    assert lint_document_content(content, path="a.md", ref_exists=_on_canvas()) == []


def test_an_example_inside_a_code_fence_is_not_a_reference() -> None:
    body = "How to embed a photo:\n\n```markdown\n![photo](sources/photo.png)\n```\n"
    assert lint_document_content(body, path="a.md", ref_exists=_on_canvas()) == []


def test_an_example_inside_backticks_is_not_a_reference() -> None:
    body = "Write `![photo](sources/photo.png)` to embed it."
    assert lint_document_content(body, path="a.md", ref_exists=_on_canvas()) == []


def test_blanking_code_keeps_the_line_numbers_honest() -> None:
    body = "```\nnot a reference\n```\n\n![x](sources/a.png)\n"
    (warning,) = lint_document_content(body, path="a.md", ref_exists=_on_canvas())
    assert "line 5" in warning


def test_an_unclosed_fence_swallows_the_rest_of_the_file() -> None:
    body = "text\n\n```\n![x](sources/a.png)\n"
    assert lint_document_content(body, path="a.md", ref_exists=_on_canvas()) == []


def test_a_caller_without_a_file_list_stays_quiet() -> None:
    assert lint_document_content("![x](sources/a.png)", path="a.md") == []


@pytest.mark.parametrize("path", ["deck.slides.json", "data.table.json", "photo.png"])
def test_only_documents_and_pages_are_checked(path: str) -> None:
    assert not is_document_path(path)
    assert lint_document_content("![x](sources/a.png)", path=path, ref_exists=_on_canvas()) == []


def test_a_clean_document_adds_nothing_to_the_tool_result() -> None:
    assert format_document_warnings([]) == ""


# --- through the tools ----------------------------------------------------


def test_write_canvas_reports_the_broken_reference() -> None:
    store = InMemoryCanvasStore()
    tools = _tools(store)
    result = tools["write_canvas"].func(
        path="report.md",
        content="# Report\n\n![site photo](sources/IMG_1946.jpg)\n",
        description="draft",
        runtime=_Runtime(),
    )
    assert "Document check:" in result
    assert "sources/IMG_1946.jpg" in result


def test_write_canvas_is_quiet_once_the_file_is_there() -> None:
    store = InMemoryCanvasStore()
    store.write_bytes("t1", "sources/IMG_1946.jpg", b"\x89PNG", "upload", actor="human")
    tools = _tools(store)
    result = tools["write_canvas"].func(
        path="report.md",
        content="![site photo](sources/IMG_1946.jpg)\n",
        description="draft",
        runtime=_Runtime(),
    )
    assert "Document check:" not in result


def test_an_edit_that_adds_a_broken_reference_is_reported() -> None:
    store = InMemoryCanvasStore()
    tools = _tools(store)
    written = tools["write_canvas"].func(
        path="report.md", content="# Report\n\nbody\n", description="draft",
        runtime=_Runtime(),
    )
    assert "Document check:" not in written
    revision = written.split("revision ")[1].split(")")[0]
    edited = tools["edit_canvas"].func(
        path="report.md",
        old="body",
        new="![photo](sources/photo.png)",
        description="add the photo",
        revision=revision,
        runtime=_Runtime(),
    )
    assert "Document check:" in edited
    assert "sources/photo.png" in edited


def test_the_deck_check_still_speaks_for_decks() -> None:
    store = InMemoryCanvasStore()
    tools = _tools(store)
    result = tools["write_canvas"].func(
        path="deck.slides.json",
        content=(
            '{"type":"slides","title":"D","data":{"slides":[{"elements":'
            '[{"id":"i","type":"image","src":"sources/gone.png",'
            '"x":0,"y":0,"w":50,"h":50}]}]}}'
        ),
        description="draft",
        runtime=_Runtime(),
    )
    assert "Deck check:" in result
    assert "sources/gone.png" in result
