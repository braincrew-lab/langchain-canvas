"""Contract tests every CanvasStore implementation must pass.

New backends register a factory in ``STORE_FACTORIES`` (or reuse this module
from their own test suite) and must pass unmodified — that is the acceptance
bar for the abstraction. The tests only speak the protocol: no backend
internals, no revision-format assumptions beyond opacity.
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable

import pytest

from langchain_canvas.store import (
    CanvasFileNotFoundError,
    CanvasStore,
    EditConflictError,
    FileCanvasStore,
    InMemoryCanvasStore,
    RevisionMismatchError,
)

STORE_FACTORIES: dict[str, Callable[[], CanvasStore]] = {
    "memory": InMemoryCanvasStore,
    "filesystem": lambda: FileCanvasStore(tempfile.mkdtemp(prefix="canvas-store-")),
}


@pytest.fixture(params=sorted(STORE_FACTORIES))
def store(request: pytest.FixtureRequest) -> CanvasStore:
    return STORE_FACTORIES[request.param]()


HTML_V1 = "<h1>Coffee history</h1>\n<p>From Ethiopia to Yemen.</p>\n"


# --- write / read ----------------------------------------------------------------


def test_write_creates_canvas_and_commit(store: CanvasStore) -> None:
    commit = store.write("c1", "01-origin.html", HTML_V1, "Create slide 1")
    assert commit.description == "Create slide 1"
    assert commit.paths == ["01-origin.html"]
    assert commit.revision

    got = store.read("c1", "01-origin.html")
    assert got.content == HTML_V1
    assert got.revision == commit.revision


def test_write_replaces_whole_file(store: CanvasStore) -> None:
    store.write("c1", "a.html", "old", "create")
    store.write("c1", "a.html", "new", "replace")
    assert store.read("c1", "a.html").content == "new"


def test_read_unknown_canvas_or_path_raises(store: CanvasStore) -> None:
    with pytest.raises(CanvasFileNotFoundError):
        store.read("nope", "a.html")
    store.write("c1", "a.html", "x", "create")
    with pytest.raises(CanvasFileNotFoundError):
        store.read("c1", "missing.html")


def test_read_historical_revision(store: CanvasStore) -> None:
    first = store.write("c1", "a.html", "one", "v1")
    store.write("c1", "a.html", "two", "v2")
    assert store.read("c1", "a.html", revision=first.revision).content == "one"
    assert store.read("c1", "a.html").content == "two"


def test_read_unknown_revision_raises(store: CanvasStore) -> None:
    store.write("c1", "a.html", "x", "create")
    with pytest.raises(CanvasFileNotFoundError):
        store.read("c1", "a.html", revision="not-a-revision")


# --- edit ------------------------------------------------------------------------


def test_edit_replaces_unique_occurrence(store: CanvasStore) -> None:
    store.write("c1", "a.html", "<h1>[TEST] Title</h1>", "create")
    commit = store.edit("c1", "a.html", "[TEST] ", "", "Remove test marker")
    assert store.read("c1", "a.html").content == "<h1>Title</h1>"
    assert commit.description == "Remove test marker"


def test_edit_missing_old_string_raises(store: CanvasStore) -> None:
    store.write("c1", "a.html", "hello", "create")
    with pytest.raises(EditConflictError):
        store.edit("c1", "a.html", "absent", "x", "edit")


def test_edit_ambiguous_old_string_raises(store: CanvasStore) -> None:
    store.write("c1", "a.html", "dup dup", "create")
    with pytest.raises(EditConflictError):
        store.edit("c1", "a.html", "dup", "x", "edit")


def test_edit_unknown_file_raises(store: CanvasStore) -> None:
    with pytest.raises(CanvasFileNotFoundError):
        store.edit("c1", "missing.html", "a", "b", "edit")


# --- optimistic concurrency ------------------------------------------------------


def test_stale_base_revision_rejected(store: CanvasStore) -> None:
    first = store.write("c1", "a.html", "one", "v1")
    store.write("c1", "a.html", "two", "v2")
    with pytest.raises(RevisionMismatchError):
        store.edit("c1", "a.html", "two", "three", "stale edit", base_revision=first.revision)
    with pytest.raises(RevisionMismatchError):
        store.write("c1", "a.html", "three", "stale write", base_revision=first.revision)


def test_current_base_revision_accepted(store: CanvasStore) -> None:
    head = store.write("c1", "a.html", "one", "v1")
    store.edit("c1", "a.html", "one", "two", "edit", base_revision=head.revision)
    assert store.read("c1", "a.html").content == "two"


# --- listing / history -----------------------------------------------------------


def test_list_files(store: CanvasStore) -> None:
    assert store.list_files("nope") == []
    store.write("c1", "b.html", "bb", "create b")
    store.write("c1", "a.html", "a", "create a")
    infos = store.list_files("c1")
    assert [f.path for f in infos] == ["a.html", "b.html"]
    assert [f.size for f in infos] == [1, 2]


def test_history_newest_first_including_human_style_edits(store: CanvasStore) -> None:
    assert store.history("nope") == []
    store.write("c1", "a.html", "one", "Create slide 1")
    store.write("c1", "a.html", "one edited", "Manual edit: 1 change")
    store.edit("c1", "a.html", "edited", "polished", "Polish wording")
    descriptions = [c.description for c in store.history("c1")]
    assert descriptions == ["Polish wording", "Manual edit: 1 change", "Create slide 1"]


def test_revisions_are_unique_and_advance(store: CanvasStore) -> None:
    a = store.write("c1", "a.html", "1", "c1")
    b = store.write("c1", "a.html", "2", "c2")
    assert a.revision != b.revision
    assert store.read("c1", "a.html").revision == b.revision


def test_canvases_are_isolated(store: CanvasStore) -> None:
    store.write("c1", "a.html", "one", "create")
    store.write("c2", "a.html", "two", "create")
    assert store.read("c1", "a.html").content == "one"
    assert store.read("c2", "a.html").content == "two"
    assert len(store.history("c1")) == 1


# --- contract-level safety -------------------------------------------------------


def test_parallel_writes_commit_safely(store: CanvasStore) -> None:
    """A parallel tool-call burst (threads) must not race the revision numbering."""
    from concurrent.futures import ThreadPoolExecutor

    paths = [f"{i:02d}-slide.html" for i in range(1, 9)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        commits = list(
            pool.map(lambda p: store.write("c1", p, f"<h1>{p}</h1>", f"Create {p}"), paths)
        )

    revisions = [c.revision for c in commits]
    assert len(set(revisions)) == len(paths), "every parallel write needs its own revision"
    assert len(store.history("c1")) == len(paths)
    assert len(store.list_files("c1")) == len(paths)


@pytest.mark.parametrize(
    "bad_path", ["../evil.html", "/etc/passwd", "a/../b.html", " padded.html", ""]
)
def test_traversal_and_malformed_paths_rejected(store: CanvasStore, bad_path: str) -> None:
    """Path safety is part of the contract — every backend rejects the same inputs."""
    from langchain_canvas.store import CanvasStoreError

    with pytest.raises(CanvasStoreError):
        store.write("c1", bad_path, "content", "should not land")


@pytest.mark.parametrize(
    "bad_path", ["../evil.html", "/etc/passwd", "a/../b.html", " padded.html", ""]
)
def test_traversal_rejected_on_reads_too(store: CanvasStore, bad_path: str) -> None:
    """Read paths guard the same way — file-serving endpoints (downloads, asset
    display) pass user-supplied paths straight to ``read_bytes``, so a hostile
    path must die here, not in each server."""
    from langchain_canvas.store import CanvasStoreError

    store.write("c1", "page.html", "<p>hi</p>", "create")
    with pytest.raises(CanvasStoreError):
        store.read("c1", bad_path)
    with pytest.raises(CanvasStoreError):
        store.read_bytes("c1", bad_path)


@pytest.mark.parametrize("bad_id", ["../up", "a/b", "", " padded"])
def test_malformed_canvas_ids_rejected(store: CanvasStore, bad_id: str) -> None:
    from langchain_canvas.store import CanvasStoreError

    with pytest.raises(CanvasStoreError):
        store.write(bad_id, "a.html", "content", "should not land")


def test_commit_records_when_and_who(store: CanvasStore) -> None:
    commit = store.write("c1", "page.html", "<p>hi</p>", "create", actor="human")
    assert commit.actor == "human"
    assert commit.created_at is not None
    assert commit.created_at.tzinfo is not None  # timezone-aware (UTC)
    unattributed = store.write("c1", "page.html", "<p>hi2</p>", "again")
    assert unattributed.actor is None


def test_history_limit(store: CanvasStore) -> None:
    for i in range(5):
        store.write("c1", "page.html", f"<p>{i}</p>", f"change {i}")
    top_two = store.history("c1", limit=2)
    assert [c.description for c in top_two] == ["change 4", "change 3"]
    assert len(store.history("c1")) == 5


async def test_async_twins_roundtrip(store: CanvasStore) -> None:
    commit = await store.awrite("c1", "page.html", "<p>hi</p>", "create", actor="agent")
    got = await store.aread("c1", "page.html")
    assert got.content == "<p>hi</p>"
    assert got.revision == commit.revision
    edited = await store.aedit(
        "c1", "page.html", "hi", "bye", "tweak", base_revision=commit.revision
    )
    assert (await store.aread("c1", "page.html")).content == "<p>bye</p>"
    files = await store.alist_files("c1")
    assert [f.path for f in files] == ["page.html"]
    commits = await store.ahistory("c1", limit=1)
    assert commits[0].revision == edited.revision


# --- bytes (binary sources) ------------------------------------------------------

PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\xff\xfe binary"


def test_write_bytes_roundtrip(store: CanvasStore) -> None:
    commit = store.write_bytes("c1", "sources/logo.png", PNG_BYTES, "Upload logo.png")
    got = store.read_bytes("c1", "sources/logo.png")
    assert got.data == PNG_BYTES
    assert got.revision == commit.revision
    assert commit.paths == ["sources/logo.png"]


def test_read_on_binary_raises_binary_content_error(store: CanvasStore) -> None:
    from langchain_canvas.store import BinaryContentError

    store.write_bytes("c1", "sources/logo.png", PNG_BYTES, "Upload")
    with pytest.raises(BinaryContentError):
        store.read("c1", "sources/logo.png")


def test_read_bytes_serves_text_files_too(store: CanvasStore) -> None:
    store.write("c1", "page.html", "<p>hi</p>", "create")
    assert store.read_bytes("c1", "page.html").data == b"<p>hi</p>"


def test_write_bytes_respects_base_revision(store: CanvasStore) -> None:
    first = store.write_bytes("c1", "sources/a.bin", b"\x00\x01", "v1")
    store.write_bytes("c1", "sources/a.bin", b"\x00\x02", "v2")
    with pytest.raises(RevisionMismatchError):
        store.write_bytes("c1", "sources/a.bin", b"\x00\x03", "stale", base_revision=first.revision)


def test_read_bytes_at_historic_revision(store: CanvasStore) -> None:
    first = store.write_bytes("c1", "sources/a.bin", b"\x00\x01", "v1")
    store.write_bytes("c1", "sources/a.bin", b"\x00\x02", "v2")
    assert store.read_bytes("c1", "sources/a.bin", revision=first.revision).data == b"\x00\x01"


def test_list_files_includes_binary_sizes(store: CanvasStore) -> None:
    store.write_bytes("c1", "sources/a.bin", b"\x00" * 10, "upload")
    infos = {i.path: i.size for i in store.list_files("c1")}
    assert infos["sources/a.bin"] == 10


def test_base_revision_is_per_file_not_per_canvas(store: CanvasStore) -> None:
    # A commit to another file must not invalidate a base for this one — a
    # multi-artifact canvas would otherwise reject every edit of a non-latest
    # artifact.
    chart = store.write("c", "rev.chart.json", "{}", "chart")
    store.write("c", "report.md", "# Report", "report")

    commit = store.write(
        "c", "rev.chart.json", "{'v':2}", "hand edit", base_revision=chart.revision
    )
    assert commit.revision  # accepted: rev.chart.json itself never moved


def test_base_revision_stale_when_the_same_file_moved(store: CanvasStore) -> None:
    first = store.write("c", "a.md", "one", "v1")
    store.write("c", "a.md", "two", "v2")

    with pytest.raises(RevisionMismatchError):
        store.write("c", "a.md", "three", "late", base_revision=first.revision)


def test_unknown_base_revision_is_rejected(store: CanvasStore) -> None:
    store.write("c", "a.md", "one", "v1")

    with pytest.raises(RevisionMismatchError):
        store.write("c", "a.md", "two", "late", base_revision="v999")
