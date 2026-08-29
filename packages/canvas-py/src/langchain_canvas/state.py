"""What the canvas holds right now — the lines a model reads before it acts.

A model starts every turn knowing nothing about the canvas: not whether one
exists, not what is on it, not whether the person changed a file since the
model last wrote it. Measured in a run, it spent two tool calls to learn
"the canvas is empty" and had no way at all to learn the second thing until
a stale write was refused. Everything it needed was already in the commit
log. These helpers turn that log into a few lines a host can put in the
system prompt (:func:`canvas_now`) and a tool can put under its header
(:func:`last_change_line`) — always short, computed from the store, never
from memory.
"""

from __future__ import annotations

from datetime import UTC, datetime

from .store import CanvasStore, CanvasStoreError, Commit

#: Files listed by name before the block folds the rest into a count.
MAX_LISTED_FILES = 12


def describe_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} B"


def describe_age(when: datetime | None, now: datetime | None = None) -> str:
    """``"3 min ago"`` / ``"2 h ago"`` / ``"4 d ago"``; ``""`` when unknown."""
    if when is None:
        return ""
    now = now or datetime.now(UTC)
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    seconds = max(0, int((now - when).total_seconds()))
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    if seconds < 86400:
        return f"{seconds // 3600} h ago"
    return f"{seconds // 86400} d ago"


def _who(commit: Commit, now: datetime | None) -> str:
    age = describe_age(commit.created_at, now)
    line = f'{commit.revision} — {commit.actor or "?"} "{commit.description}"'
    return f"{line}, {age}" if age else line


def last_change_line(
    store: CanvasStore, canvas_id: str, path: str, *, now: datetime | None = None
) -> str:
    """``last change: v4 by human "Manual edit" (3 min ago)`` for one file, or ``""``."""
    try:
        commits = store.history(canvas_id)
    except CanvasStoreError:
        return ""
    for commit in commits:
        if path in commit.paths:
            age = describe_age(commit.created_at, now)
            line = f'last change: {commit.revision} by {commit.actor or "?"} "{commit.description}"'
            return f"{line} ({age})" if age else line
    return ""


def canvas_now(
    store: CanvasStore,
    canvas_id: str,
    *,
    now: datetime | None = None,
    max_files: int = MAX_LISTED_FILES,
) -> str:
    """A few lines on the canvas as it is: its files, and what the person
    changed since the agent last wrote.

    The first part replaces the probing calls (``read_canvas`` on a file that
    may not exist, ``list_canvas_files`` to learn it is empty). The second
    part is the one fact the model cannot get anywhere else in time: a file
    it remembers writing has moved under it, so its remembered revision and
    contents are stale, and the next write must start with a read. Uploads
    under ``sources/`` are listed but never counted as "changed" — they are
    inputs the person added, not edits to the agent's work.
    """
    try:
        files = store.list_files(canvas_id)
    except CanvasStoreError:
        files = []
    if not files:
        return (
            "## Canvas now\nThe canvas is empty — nothing to read yet; write_canvas creates "
            "the first file."
        )
    try:
        commits = list(store.history(canvas_id))  # newest first
    except CanvasStoreError:
        commits = []
    last_for: dict[str, Commit] = {}
    for commit in commits:
        for touched in commit.paths:
            last_for.setdefault(touched, commit)

    lines = ["## Canvas now"]
    pictures = [info for info in files if info.path.startswith("assets/")]
    listed = [info for info in files if not info.path.startswith("assets/")]
    for info in listed[:max_files]:
        parts = [describe_size(info.size)]
        if info.path.startswith("sources/"):
            parts.append("upload, read-only")
        elif info.path.startswith("exports/"):
            parts.append("export")
        touched_by = last_for.get(info.path)
        if touched_by is not None:
            parts.append(_who(touched_by, now))
        lines.append(f"- {info.path} ({'; '.join(parts)})")
    if len(listed) > max_files:
        lines.append(f"- … and {len(listed) - max_files} more (list_canvas_files shows all)")
    if pictures:
        lines.append(f"- assets/: {len(pictures)} picture(s), referenced by path")

    last_agent = next((i for i, c in enumerate(commits) if c.actor == "agent"), None)
    since = commits[:last_agent] if last_agent is not None else commits
    changed: dict[str, list[str]] = {}
    for commit in reversed(since):  # oldest first, so revisions read in order
        if commit.actor == "agent" or not commit.actor:
            continue
        for touched in commit.paths:
            if touched.startswith("sources/"):
                continue
            changed.setdefault(touched, []).append(commit.revision)
    if changed:
        named = "; ".join(
            f"{path} ({', '.join(revisions)})" for path, revisions in changed.items()
        )
        lines.append(
            f"Changed by the person since your last write: {named} — read those again "
            "before writing; your remembered contents and revisions are stale."
        )
    return "\n".join(lines)
