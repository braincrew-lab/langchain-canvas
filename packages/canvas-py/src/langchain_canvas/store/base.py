"""CanvasStore — the persistence contract for canvas content.

A canvas is a folder of files (html/md/csv/png/...); every change is a
described commit. The store is the single source of truth that both humans
(via a save endpoint) and agents (via the standard canvas tools) write
through, so a human edit is visible to the agent on its next read.

The store never interprets file contents — adding a new artifact type
requires no storage changes. Access control and multi-tenancy are
deliberately out of scope: the protocol has no user concept, and adopters
must enforce authorization at their own boundary before calls reach a store.

Implementations are swappable behind :class:`CanvasStore` (same pattern as
LangGraph checkpointers): `InMemoryCanvasStore` for tests and replay, a
filesystem snapshot store for durable local use, or an app-specific backend
(database, internal API adapter, ...). Any implementation must pass the
contract test suite in ``tests/test_store_contract.py``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from pydantic import BaseModel

# --- data shapes -----------------------------------------------------------------


class FileContent(BaseModel):
    """One file's content at a revision, as returned by :meth:`CanvasStore.read`."""

    path: str
    content: str
    revision: str
    """Revision the content was read at — pass back to ``edit``/``write`` as
    ``base_revision`` to detect concurrent changes (optimistic concurrency)."""


class FileInfo(BaseModel):
    """Directory-listing entry for one file in a canvas."""

    path: str
    size: int


class Commit(BaseModel):
    """One described change to a canvas.

    ``revision`` is an opaque string. Implementations choose the format
    (counter, hash, ...); callers must not parse it, only compare equality
    and pass it back as ``base_revision``.
    """

    revision: str
    description: str
    paths: list[str]
    """Files touched by this commit."""


# --- errors ----------------------------------------------------------------------


class CanvasStoreError(Exception):
    """Base class for store failures."""


class CanvasFileNotFoundError(CanvasStoreError):
    """The requested path (or revision) does not exist in the canvas."""


class RevisionMismatchError(CanvasStoreError):
    """``base_revision`` no longer matches the canvas head.

    Someone (human or agent) committed after the caller's last read. The
    caller must re-read and retry — never overwrite blindly.
    """


class EditConflictError(CanvasStoreError):
    """``old`` was not found, or matched more than once.

    A targeted edit must identify exactly one occurrence; anything else means
    the caller's view of the file is stale or the match is too ambiguous to
    apply safely.
    """


# --- the contract ----------------------------------------------------------------


@runtime_checkable
class CanvasStore(Protocol):
    """Persistence contract for canvas folders.

    A canvas comes into existence on its first ``write``; reading an unknown
    canvas raises :class:`CanvasFileNotFoundError`, while ``list_files`` and
    ``history`` return empty lists.
    """

    def read(self, canvas_id: str, path: str, revision: str | None = None) -> FileContent:
        """Return one file's content.

        ``revision=None`` reads the head. A historical ``revision`` returns
        the file as of that commit. Raises :class:`CanvasFileNotFoundError`
        for unknown paths or revisions.
        """
        ...

    def write(
        self,
        canvas_id: str,
        path: str,
        content: str,
        description: str,
        base_revision: str | None = None,
    ) -> Commit:
        """Create or fully replace one file, as a new commit.

        ``base_revision`` (from a prior ``read``) enables optimistic
        concurrency: if given and the canvas head has moved past it,
        :class:`RevisionMismatchError` is raised instead of overwriting.
        """
        ...

    def edit(
        self,
        canvas_id: str,
        path: str,
        old: str,
        new: str,
        description: str,
        base_revision: str | None = None,
    ) -> Commit:
        """Replace exactly one occurrence of ``old`` with ``new`` in one file.

        Raises :class:`EditConflictError` when ``old`` is absent or matches
        more than once, and :class:`RevisionMismatchError` when
        ``base_revision`` is stale (see ``write``).
        """
        ...

    def list_files(self, canvas_id: str) -> list[FileInfo]:
        """List the canvas's files at head. Unknown canvas -> empty list."""
        ...

    def history(self, canvas_id: str) -> list[Commit]:
        """All commits, newest first. Unknown canvas -> empty list."""
        ...
