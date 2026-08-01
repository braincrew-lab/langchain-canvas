"""Filesystem CanvasStore — durable snapshots on local disk, zero dependencies.

Layout under ``root``::

    <root>/<canvas_id>/
        head/                      # current files
        history/
            commits.jsonl          # one Commit per line, oldest first
            snapshots/<revision>/  # full file set as of that commit

Every commit snapshots the whole canvas (files are small documents, not
repositories), which keeps reads at any revision trivial and the format
inspectable with nothing but a file browser. Canvas ids and file paths are
sanitized against traversal; nested file paths like ``notes/summary.md`` are
allowed, absolute paths and ``..`` are not. Content is text (UTF-8) — binary
assets are not supported by the store contract yet.

Writes are serialized behind a per-store lock, so concurrent tool calls in
one process (LangGraph runs tools on worker threads) commit safely.
Concurrent writers across *processes* still need an app-level lock (out of
scope, same as the in-memory backend).
"""

from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path

from .base import (
    CanvasFileNotFoundError,
    CanvasNotFoundError,
    CanvasStoreError,
    Commit,
    EditConflictError,
    FileContent,
    FileInfo,
    RevisionMismatchError,
    RevisionNotFoundError,
    validate_canvas_id,
    validate_relpath,
)

_HEAD = "head"
_HISTORY = "history"
_SNAPSHOTS = "snapshots"
_COMMITS_LOG = "commits.jsonl"


def _safe_segment(name: str, *, what: str) -> str:
    if not name or name != name.strip() or "/" in name or "\\" in name or name in {".", ".."}:
        raise CanvasStoreError(f"invalid {what}: {name!r}")
    return name


def _safe_relpath(path: str) -> Path:
    """Validate a canvas-relative file path (shared contract rules)."""
    return Path(validate_relpath(path))


class FileCanvasStore:
    """Directory-backed :class:`~langchain_canvas.store.base.CanvasStore`."""

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root)
        self._root.mkdir(parents=True, exist_ok=True)
        # One writer at a time — a parallel tool-call burst must not race the
        # revision numbering or the head-mutation/snapshot sequence.
        self._write_lock = threading.Lock()

    # --- reads -------------------------------------------------------------------

    def read(self, canvas_id: str, path: str, revision: str | None = None) -> FileContent:
        canvas_dir = self._canvas_dir(canvas_id)
        rel = _safe_relpath(path)
        if revision is None:
            commits = self._commits(canvas_dir)
            if not commits or not canvas_dir.exists():
                raise CanvasNotFoundError(f"unknown canvas: {canvas_id!r}")
            base, rev = canvas_dir / _HEAD, commits[-1].revision
        else:
            base = canvas_dir / _HISTORY / _SNAPSHOTS / _safe_segment(revision, what="revision")
            if not base.is_dir():
                raise RevisionNotFoundError(f"unknown revision: {revision!r}")
            rev = revision
        target = base / rel
        if not target.is_file():
            raise CanvasFileNotFoundError(f"no file {path!r} in canvas {canvas_id!r}")
        return FileContent(path=path, content=target.read_text("utf-8"), revision=rev)

    def list_files(self, canvas_id: str) -> list[FileInfo]:
        head = self._canvas_dir(canvas_id) / _HEAD
        if not head.is_dir():
            return []
        infos = [
            FileInfo(path=file.relative_to(head).as_posix(), size=file.stat().st_size)
            for file in sorted(head.rglob("*"))
            if file.is_file()
        ]
        return infos

    def history(self, canvas_id: str) -> list[Commit]:
        return list(reversed(self._commits(self._canvas_dir(canvas_id))))

    # --- writes ------------------------------------------------------------------

    def write(
        self,
        canvas_id: str,
        path: str,
        content: str,
        description: str,
        base_revision: str | None = None,
    ) -> Commit:
        canvas_dir = self._canvas_dir(canvas_id)
        rel = _safe_relpath(path)
        with self._write_lock:
            self._check_base(canvas_dir, base_revision)
            target = canvas_dir / _HEAD / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, "utf-8")
            return self._commit(canvas_dir, description, [path])

    def edit(
        self,
        canvas_id: str,
        path: str,
        old: str,
        new: str,
        description: str,
        base_revision: str | None = None,
    ) -> Commit:
        canvas_dir = self._canvas_dir(canvas_id)
        target = canvas_dir / _HEAD / _safe_relpath(path)
        with self._write_lock:
            if not target.is_file():
                raise CanvasFileNotFoundError(f"no file {path!r} in canvas {canvas_id!r}")
            self._check_base(canvas_dir, base_revision)
            current = target.read_text("utf-8")
            occurrences = current.count(old)
            if occurrences == 0:
                raise EditConflictError(f"old string not found in {path!r}")
            if occurrences > 1:
                raise EditConflictError(
                    f"old string matches {occurrences} times in {path!r} — must be unique"
                )
            target.write_text(current.replace(old, new, 1), "utf-8")
            return self._commit(canvas_dir, description, [path])

    # --- internals ---------------------------------------------------------------

    def _canvas_dir(self, canvas_id: str) -> Path:
        return self._root / validate_canvas_id(canvas_id)

    def _commits(self, canvas_dir: Path) -> list[Commit]:
        log = canvas_dir / _HISTORY / _COMMITS_LOG
        if not log.is_file():
            return []
        return [
            Commit.model_validate(json.loads(line))
            for line in log.read_text("utf-8").splitlines()
            if line.strip()
        ]

    def _check_base(self, canvas_dir: Path, base_revision: str | None) -> None:
        if base_revision is None:
            return
        commits = self._commits(canvas_dir)
        if not commits:
            return
        head = commits[-1].revision
        if base_revision != head:
            raise RevisionMismatchError(f"base revision {base_revision!r} is behind head {head!r}")

    def _commit(self, canvas_dir: Path, description: str, paths: list[str]) -> Commit:
        commits = self._commits(canvas_dir)
        commit = Commit(revision=f"v{len(commits) + 1}", description=description, paths=paths)
        snapshot_dir = canvas_dir / _HISTORY / _SNAPSHOTS / commit.revision
        shutil.copytree(canvas_dir / _HEAD, snapshot_dir)
        log = canvas_dir / _HISTORY / _COMMITS_LOG
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as fh:
            fh.write(commit.model_dump_json() + "\n")
        return commit
