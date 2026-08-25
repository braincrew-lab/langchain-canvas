"""Save-time checks for documents and pages (``.md`` / ``.txt`` / ``.html``).

One check, and it is the one that keeps costing users a visible defect: an
image reference pointing at a file the canvas does not have. The reader sees
a broken image where a photo should be, and nothing said so at save time —
the deck path has caught this since the coordinate checks landed, but a
document went out unchecked.

The rule the check enforces is the reference contract in
:mod:`langchain_canvas.assets`: inside canvas content, a relative path under
``assets/`` or ``sources/`` names a file on the *same* canvas. Anything else
— an ``https://`` URL, a ``data:`` URI, a path to somewhere off the canvas —
points outside and is none of the canvas's business, so it is never checked.
That gate is what keeps this free of false positives: a warning here means
the canvas was asked for a file it does not hold, which is decidable with
certainty from the file list.

Fenced and inline code are blanked before scanning. A reference written
inside a code block is an example, not a reference, and warning about it
would be exactly the wrong kind of noise.

Nothing here blocks a save.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from langchain_canvas.assets import find_asset_references, normalize_asset_reference

# Suffixes whose content renders as a document or a page — the two artifact
# kinds that embed images by relative path (see ``replay.source_preview_events``).
DOCUMENT_SUFFIXES: tuple[str, ...] = (".md", ".markdown", ".txt", ".html", ".htm")

# Same cap as the deck check: a file with dozens of broken links needs the
# pattern named, not every instance listed.
_MAX_WARNINGS = 8

# A fenced block runs to its matching fence, or to the end of the file when
# the author never closed it.
_FENCE = re.compile(r"^(?P<fence>```+|~~~+)[^\n]*\n.*?(?:^(?P=fence)|\Z)", re.M | re.S)
_INLINE_CODE = re.compile(r"`[^`\n]*`")


def is_document_path(path: str) -> bool:
    """Whether ``path`` names a document or page this module checks."""
    return path.lower().endswith(DOCUMENT_SUFFIXES)


def lint_document_content(
    content: str,
    *,
    path: str,
    ref_exists: Callable[[str], bool] | None = None,
) -> list[str]:
    """Warnings for one saved document, or ``[]``.

    ``ref_exists`` answers whether a canvas-root-relative reference is present
    on the canvas. Without it there is nothing to decide, so the check stays
    silent rather than guessing — the same contract the deck check keeps for
    callers with no store access.
    """
    if ref_exists is None or not is_document_path(path):
        return []
    scannable = _blank_code(content) if not _is_page(path) else content
    first_seen: dict[str, tuple[int, int]] = {}
    for offset, raw in find_asset_references(scannable):
        reference = normalize_asset_reference(raw)
        if reference is None or ref_exists(reference):
            continue
        line, count = first_seen.get(raw, (_line_of(scannable, offset), 0))
        first_seen[raw] = (line, count + 1)
    warnings = [
        _broken_reference(raw, line, count)
        for raw, (line, count) in sorted(first_seen.items(), key=lambda kv: kv[1][0])
    ]
    return _capped(warnings)


def format_document_warnings(warnings: list[str]) -> str:
    """The warnings as one block to append to a tool result ('' when clean)."""
    if not warnings:
        return ""
    lines = "\n".join(f"- {warning}" for warning in warnings)
    return (
        "\nDocument check:\n"
        f"{lines}\n"
        "These are exact findings read from the file you just saved."
    )


def _broken_reference(raw: str, line: int, count: int) -> str:
    where = f"line {line}" if count == 1 else f"line {line} and {count - 1} more"
    return (
        f'{where}: "{raw}" is not on the canvas, so it renders as a broken '
        "image. Bring the file onto the canvas first, then reference it by "
        "the path list_canvas_files shows."
    )


def _is_page(path: str) -> bool:
    """An ``.html`` page is markup all the way down — no markdown code fences."""
    return path.lower().endswith((".html", ".htm"))


def _blank_code(text: str) -> str:
    """Replace code spans with blanks of the same shape (offsets survive)."""

    def _blank(match: re.Match[str]) -> str:
        return re.sub(r"[^\n]", " ", match.group(0))

    return _INLINE_CODE.sub(_blank, _FENCE.sub(_blank, text))


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _capped(warnings: list[str]) -> list[str]:
    if len(warnings) <= _MAX_WARNINGS:
        return warnings
    hidden = len(warnings) - _MAX_WARNINGS
    return [*warnings[:_MAX_WARNINGS], f"... and {hidden} more like these"]
