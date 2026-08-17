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

import asyncio
from datetime import UTC, datetime
from typing import Protocol, runtime_checkable

from pydantic import BaseModel


def utcnow() -> datetime:
    """Timezone-aware UTC timestamp for :attr:`Commit.created_at`."""
    return datetime.now(UTC)

# --- data shapes -----------------------------------------------------------------


class FileContent(BaseModel):
    """One file's content at a revision, as returned by :meth:`CanvasStore.read`."""

    path: str
    content: str
    revision: str
    """Revision the content was read at — pass back to ``edit``/``write`` as
    ``base_revision`` to detect concurrent changes (optimistic concurrency)."""


class FileBytes(BaseModel):
    """One file's raw bytes at a revision, as returned by :meth:`CanvasStore.read_bytes`."""

    path: str
    data: bytes
    revision: str


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

    created_at: datetime | None = None
    """When the commit was made (UTC). Stores stamp this on every new commit;
    ``None`` only appears on records written before the field existed."""

    actor: str | None = None
    """Who made the commit — free-form (``"agent"``, ``"human"``, a user id).
    ``None`` when the caller did not say."""


# --- shared validation -----------------------------------------------------------


def validate_canvas_id(canvas_id: str) -> str:
    """Reject empty, padded, or path-like canvas ids.

    Every implementation must apply this (the contract tests enforce it), so a
    hostile id can never escape one backend while another accepts it.
    """
    if (
        not canvas_id
        or canvas_id != canvas_id.strip()
        or "/" in canvas_id
        or "\\" in canvas_id
        or canvas_id in {".", ".."}
    ):
        raise CanvasStoreError(f"invalid canvas id: {canvas_id!r}")
    return canvas_id


def validate_relpath(path: str) -> str:
    """Reject absolute paths and ``..`` traversal; nested relative paths pass.

    Shared by every implementation for the same reason as
    :func:`validate_canvas_id` — path safety is part of the contract, not a
    backend detail.
    """
    if not path or path != path.strip() or path.startswith(("/", "\\")):
        raise CanvasStoreError(f"invalid path: {path!r}")
    if any(part in {".", "..", ""} for part in path.replace("\\", "/").split("/")):
        raise CanvasStoreError(f"invalid path: {path!r}")
    return path


# --- errors ----------------------------------------------------------------------


class CanvasStoreError(Exception):
    """Base class for store failures."""


class CanvasFileNotFoundError(CanvasStoreError):
    """The requested file path does not exist in the canvas.

    Base of the not-found family: :class:`CanvasNotFoundError` (whole canvas
    missing) and :class:`RevisionNotFoundError` (unknown revision) subclass it,
    so ``except CanvasFileNotFoundError`` keeps catching all three while
    callers that care can tell them apart.
    """


class CanvasNotFoundError(CanvasFileNotFoundError):
    """The canvas itself does not exist yet (no commit has created it)."""


class RevisionNotFoundError(CanvasFileNotFoundError):
    """The requested revision does not exist in the canvas's history."""


class BinaryContentError(CanvasStoreError):
    """The file holds binary data — read it with ``read_bytes``, not ``read``.

    Raised by ``read`` (and ``edit``, which reads first) on files written via
    ``write_bytes`` whose content is not valid UTF-8 text.
    """


class RevisionMismatchError(CanvasStoreError):
    """``base_revision`` is stale for the file being written.

    Someone (human or agent) changed *this file* after the caller's last
    read (commits that touched other files don't count), or the base
    revision is unknown to the canvas. The caller must re-read and retry —
    never overwrite blindly.
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
        actor: str | None = None,
    ) -> Commit:
        """Create or fully replace one file, as a new commit.

        ``base_revision`` (from a prior ``read``) enables optimistic
        concurrency: if given and ``path`` itself changed after that
        revision, :class:`RevisionMismatchError` is raised instead of
        overwriting. Commits that touched other files don't invalidate it.
        ``actor`` is recorded on the commit (see :attr:`Commit.actor`).
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
        actor: str | None = None,
    ) -> Commit:
        """Replace exactly one occurrence of ``old`` with ``new`` in one file.

        Raises :class:`EditConflictError` when ``old`` is absent or matches
        more than once, and :class:`RevisionMismatchError` when
        ``base_revision`` is stale (see ``write``).
        """
        ...

    def read_bytes(self, canvas_id: str, path: str, revision: str | None = None) -> FileBytes:
        """Return one file's raw bytes (text files return their UTF-8 bytes).

        Same revision semantics and errors as :meth:`read`.
        """
        ...

    def write_bytes(
        self,
        canvas_id: str,
        path: str,
        data: bytes,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
    ) -> Commit:
        """Create or fully replace one file with raw bytes, as a new commit.

        The binary companion to :meth:`write` — same concurrency and actor
        semantics. Reading a non-UTF-8 file back through :meth:`read` raises
        :class:`BinaryContentError`; use :meth:`read_bytes`.
        """
        ...

    def list_files(self, canvas_id: str) -> list[FileInfo]:
        """List the canvas's files at head. Unknown canvas -> empty list."""
        ...

    def history(self, canvas_id: str, limit: int | None = None) -> list[Commit]:
        """Commits, newest first; at most ``limit`` when given.

        Unknown canvas -> empty list.
        """
        ...

    # --- async twins (a-prefixed, same contracts as above) -----------------------

    async def aread(self, canvas_id: str, path: str, revision: str | None = None) -> FileContent:
        """Async :meth:`read`."""
        ...

    async def awrite(
        self,
        canvas_id: str,
        path: str,
        content: str,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
    ) -> Commit:
        """Async :meth:`write`."""
        ...

    async def aedit(
        self,
        canvas_id: str,
        path: str,
        old: str,
        new: str,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
    ) -> Commit:
        """Async :meth:`edit`."""
        ...

    async def aread_bytes(
        self, canvas_id: str, path: str, revision: str | None = None
    ) -> FileBytes:
        """Async :meth:`read_bytes`."""
        ...

    async def awrite_bytes(
        self,
        canvas_id: str,
        path: str,
        data: bytes,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
    ) -> Commit:
        """Async :meth:`write_bytes`."""
        ...

    async def alist_files(self, canvas_id: str) -> list[FileInfo]:
        """Async :meth:`list_files`."""
        ...

    async def ahistory(self, canvas_id: str, limit: int | None = None) -> list[Commit]:
        """Async :meth:`history`."""
        ...


class AsyncFromSyncMixin:
    """Async ``a*`` methods that run the store's sync methods on a worker thread.

    A sync store (like the built-in in-memory and filesystem backends) inherits
    this to satisfy the async half of :class:`CanvasStore` without blocking the
    event loop. Natively-async backends implement the ``a*`` methods directly
    instead.
    """

    async def aread(self, canvas_id: str, path: str, revision: str | None = None) -> FileContent:
        return await asyncio.to_thread(self.read, canvas_id, path, revision)  # type: ignore[attr-defined]

    async def awrite(
        self,
        canvas_id: str,
        path: str,
        content: str,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
    ) -> Commit:
        return await asyncio.to_thread(
            self.write,  # type: ignore[attr-defined]
            canvas_id,
            path,
            content,
            description,
            base_revision,
            actor,
        )

    async def aedit(
        self,
        canvas_id: str,
        path: str,
        old: str,
        new: str,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
    ) -> Commit:
        return await asyncio.to_thread(
            self.edit,  # type: ignore[attr-defined]
            canvas_id,
            path,
            old,
            new,
            description,
            base_revision,
            actor,
        )

    async def aread_bytes(
        self, canvas_id: str, path: str, revision: str | None = None
    ) -> FileBytes:
        return await asyncio.to_thread(self.read_bytes, canvas_id, path, revision)  # type: ignore[attr-defined]

    async def awrite_bytes(
        self,
        canvas_id: str,
        path: str,
        data: bytes,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
    ) -> Commit:
        return await asyncio.to_thread(
            self.write_bytes,  # type: ignore[attr-defined]
            canvas_id,
            path,
            data,
            description,
            base_revision,
            actor,
        )

    async def alist_files(self, canvas_id: str) -> list[FileInfo]:
        return await asyncio.to_thread(self.list_files, canvas_id)  # type: ignore[attr-defined]

    async def ahistory(self, canvas_id: str, limit: int | None = None) -> list[Commit]:
        return await asyncio.to_thread(self.history, canvas_id, limit)  # type: ignore[attr-defined]
