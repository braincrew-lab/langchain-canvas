"""In-memory CanvasStore — for tests, replay, and single-process demos.

Content lives in plain dicts and disappears with the process. Not safe for
concurrent writers across threads; durable use belongs to the filesystem
backend.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .base import (
    CanvasFileNotFoundError,
    Commit,
    EditConflictError,
    FileContent,
    FileInfo,
    RevisionMismatchError,
)


@dataclass
class _CanvasRecord:
    """One canvas: current files, commit log, and per-revision snapshots."""

    files: dict[str, str] = field(default_factory=dict)
    commits: list[Commit] = field(default_factory=list)
    snapshots: dict[str, dict[str, str]] = field(default_factory=dict)
    counter: int = 0


class InMemoryCanvasStore:
    """Dict-backed :class:`~langchain_canvas.store.base.CanvasStore`."""

    def __init__(self) -> None:
        self._canvases: dict[str, _CanvasRecord] = {}

    # --- reads -------------------------------------------------------------------

    def read(self, canvas_id: str, path: str, revision: str | None = None) -> FileContent:
        record = self._canvases.get(canvas_id)
        if record is None:
            raise CanvasFileNotFoundError(f"unknown canvas: {canvas_id!r}")
        if revision is None:
            files, rev = record.files, self._head(record)
        else:
            if revision not in record.snapshots:
                raise CanvasFileNotFoundError(f"unknown revision: {revision!r}")
            files, rev = record.snapshots[revision], revision
        if path not in files:
            raise CanvasFileNotFoundError(f"no file {path!r} in canvas {canvas_id!r}")
        return FileContent(path=path, content=files[path], revision=rev)

    def list_files(self, canvas_id: str) -> list[FileInfo]:
        record = self._canvases.get(canvas_id)
        if record is None:
            return []
        return [
            FileInfo(path=path, size=len(content.encode("utf-8")))
            for path, content in sorted(record.files.items())
        ]

    def history(self, canvas_id: str) -> list[Commit]:
        record = self._canvases.get(canvas_id)
        if record is None:
            return []
        return list(reversed(record.commits))

    # --- writes ------------------------------------------------------------------

    def write(
        self,
        canvas_id: str,
        path: str,
        content: str,
        description: str,
        base_revision: str | None = None,
    ) -> Commit:
        record = self._canvases.setdefault(canvas_id, _CanvasRecord())
        self._check_base(record, base_revision)
        record.files[path] = content
        return self._commit(record, description, [path])

    def edit(
        self,
        canvas_id: str,
        path: str,
        old: str,
        new: str,
        description: str,
        base_revision: str | None = None,
    ) -> Commit:
        record = self._canvases.get(canvas_id)
        if record is None or path not in record.files:
            raise CanvasFileNotFoundError(f"no file {path!r} in canvas {canvas_id!r}")
        self._check_base(record, base_revision)
        current = record.files[path]
        occurrences = current.count(old)
        if occurrences == 0:
            raise EditConflictError(f"old string not found in {path!r}")
        if occurrences > 1:
            raise EditConflictError(
                f"old string matches {occurrences} times in {path!r} — must be unique"
            )
        record.files[path] = current.replace(old, new, 1)
        return self._commit(record, description, [path])

    # --- internals ---------------------------------------------------------------

    @staticmethod
    def _head(record: _CanvasRecord) -> str:
        if not record.commits:
            raise CanvasFileNotFoundError("canvas has no commits")
        return record.commits[-1].revision

    @staticmethod
    def _check_base(record: _CanvasRecord, base_revision: str | None) -> None:
        if base_revision is None or not record.commits:
            return
        head = record.commits[-1].revision
        if base_revision != head:
            raise RevisionMismatchError(f"base revision {base_revision!r} is behind head {head!r}")

    @staticmethod
    def _commit(record: _CanvasRecord, description: str, paths: list[str]) -> Commit:
        record.counter += 1
        commit = Commit(revision=f"v{record.counter}", description=description, paths=paths)
        record.commits.append(commit)
        record.snapshots[commit.revision] = dict(record.files)
        return commit
