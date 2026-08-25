"""In-memory CanvasStore — for tests, replay, and single-process demos.

Content lives in plain dicts and disappears with the process. Writes are
serialized behind a lock, so concurrent tool calls (LangGraph runs tools on
worker threads) commit safely; durable use belongs to the filesystem backend.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .base import (
    AsyncFromSyncMixin,
    BinaryContentError,
    CanvasFileNotFoundError,
    CanvasNotFoundError,
    Commit,
    EditConflictError,
    FileBytes,
    FileContent,
    FileInfo,
    RevisionMismatchError,
    RevisionNotFoundError,
    utcnow,
    validate_canvas_id,
    validate_relpath,
)


@dataclass
class _CanvasRecord:
    """One canvas: current files, commit log, and per-revision snapshots."""

    files: dict[str, str | bytes] = field(default_factory=dict)
    commits: list[Commit] = field(default_factory=list)
    snapshots: dict[str, dict[str, str | bytes]] = field(default_factory=dict)
    counter: int = 0


class InMemoryCanvasStore(AsyncFromSyncMixin):
    """Dict-backed :class:`~langchain_canvas.store.base.CanvasStore`."""

    def __init__(self) -> None:
        self._canvases: dict[str, _CanvasRecord] = {}
        # One writer at a time — a parallel tool-call burst must not race the
        # revision counter or interleave file mutation with its snapshot.
        self._write_lock = threading.Lock()

    # --- reads -------------------------------------------------------------------

    def read(self, canvas_id: str, path: str, revision: str | None = None) -> FileContent:
        record = self._canvases.get(canvas_id)
        if record is None:
            raise CanvasNotFoundError(f"unknown canvas: {canvas_id!r}")
        if revision is None:
            files, rev = record.files, self._head(record)
        else:
            if revision not in record.snapshots:
                raise RevisionNotFoundError(f"unknown revision: {revision!r}")
            files, rev = record.snapshots[revision], revision
        if path not in files:
            raise CanvasFileNotFoundError(f"no file {path!r} in canvas {canvas_id!r}")
        return FileContent(path=path, content=_as_text(files[path], path), revision=rev)

    def read_bytes(self, canvas_id: str, path: str, revision: str | None = None) -> FileBytes:
        record = self._canvases.get(canvas_id)
        if record is None:
            raise CanvasNotFoundError(f"unknown canvas: {canvas_id!r}")
        if revision is None:
            files, rev = record.files, self._head(record)
        else:
            if revision not in record.snapshots:
                raise RevisionNotFoundError(f"unknown revision: {revision!r}")
            files, rev = record.snapshots[revision], revision
        if path not in files:
            raise CanvasFileNotFoundError(f"no file {path!r} in canvas {canvas_id!r}")
        value = files[path]
        data = value.encode("utf-8") if isinstance(value, str) else value
        return FileBytes(path=path, data=data, revision=rev)

    def list_files(self, canvas_id: str) -> list[FileInfo]:
        record = self._canvases.get(canvas_id)
        if record is None:
            return []
        return [
            FileInfo(path=path, size=len(_as_bytes(content)))
            for path, content in sorted(record.files.items())
        ]

    def history(self, canvas_id: str, limit: int | None = None) -> list[Commit]:
        record = self._canvases.get(canvas_id)
        if record is None:
            return []
        commits = list(reversed(record.commits))
        return commits[:limit] if limit is not None else commits

    # --- writes ------------------------------------------------------------------

    def write(
        self,
        canvas_id: str,
        path: str,
        content: str,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
        amends: str | None = None,
    ) -> Commit:
        validate_canvas_id(canvas_id)
        validate_relpath(path)
        with self._write_lock:
            record = self._canvases.setdefault(canvas_id, _CanvasRecord())
            self._check_base(record, base_revision, path)
            record.files[path] = content
            return self._commit(record, description, [path], actor, amends)

    def write_bytes(
        self,
        canvas_id: str,
        path: str,
        data: bytes,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
        amends: str | None = None,
    ) -> Commit:
        validate_canvas_id(canvas_id)
        validate_relpath(path)
        with self._write_lock:
            record = self._canvases.setdefault(canvas_id, _CanvasRecord())
            self._check_base(record, base_revision, path)
            record.files[path] = data
            return self._commit(record, description, [path], actor, amends)

    def edit(
        self,
        canvas_id: str,
        path: str,
        old: str,
        new: str,
        description: str,
        base_revision: str | None = None,
        actor: str | None = None,
        amends: str | None = None,
    ) -> Commit:
        validate_canvas_id(canvas_id)
        validate_relpath(path)
        with self._write_lock:
            record = self._canvases.get(canvas_id)
            if record is None or path not in record.files:
                raise CanvasFileNotFoundError(f"no file {path!r} in canvas {canvas_id!r}")
            self._check_base(record, base_revision, path)
            current = _as_text(record.files[path], path)
            occurrences = current.count(old)
            if occurrences == 0:
                raise EditConflictError(f"old string not found in {path!r}")
            if occurrences > 1:
                raise EditConflictError(
                    f"old string matches {occurrences} times in {path!r} — must be unique"
                )
            record.files[path] = current.replace(old, new, 1)
            return self._commit(record, description, [path], actor, amends)

    # --- internals ---------------------------------------------------------------

    @staticmethod
    def _head(record: _CanvasRecord) -> str:
        if not record.commits:
            raise CanvasNotFoundError("canvas has no commits")
        return record.commits[-1].revision

    @staticmethod
    def _check_base(record: _CanvasRecord, base_revision: str | None, path: str) -> None:
        """Reject a write whose base is older than the file's own last change.

        Same per-file staleness rule as the filesystem backend: commits that
        touched other files don't invalidate a base; an unknown base is
        always stale.
        """
        if base_revision is None or not record.commits:
            return
        revisions = [commit.revision for commit in record.commits]
        if base_revision not in revisions:
            raise RevisionMismatchError(
                f"base revision {base_revision!r} is not in this canvas's history"
            )
        for commit in record.commits[revisions.index(base_revision) + 1 :]:
            if path in commit.paths:
                raise RevisionMismatchError(
                    f"base revision {base_revision!r} is behind {commit.revision!r}, "
                    f"which changed {path!r}"
                )

    @staticmethod
    def _commit(
        record: _CanvasRecord,
        description: str,
        paths: list[str],
        actor: str | None,
        amends: str | None = None,
    ) -> Commit:
        record.counter += 1
        commit = Commit(
            revision=f"v{record.counter}",
            description=description,
            paths=paths,
            created_at=utcnow(),
            actor=actor,
            amends=amends,
        )
        record.commits.append(commit)
        record.snapshots[commit.revision] = dict(record.files)
        return commit

def _as_text(value: str | bytes, path: str) -> str:
    """Text view of a stored value; binary that isn't UTF-8 must use read_bytes."""
    if isinstance(value, str):
        return value
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise BinaryContentError(f"{path!r} holds binary data — read it with read_bytes") from exc


def _as_bytes(value: str | bytes) -> bytes:
    return value.encode("utf-8") if isinstance(value, str) else value
