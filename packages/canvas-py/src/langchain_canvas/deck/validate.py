"""Save-time checks for the canonical deck dialect.

:func:`validate_deck` / :func:`validate_slide_html` return findings as data
(``list[DeckIssue]``) — the caller decides whether a finding blocks a save
or is surfaced as a warning. :func:`ensure_text_equality` is the one hard
gate in the pipeline: a model-generated slide that dropped or reworded
extracted text is a defect no amount of layout polish excuses, so it raises
instead of returning a list a caller could silently ignore. This mirrors the
``validate_*`` (list) vs. ``ensure_*`` (raise) split already used by
:func:`langchain_canvas.converters.ensure_archive_within_limits`.
"""

from __future__ import annotations

import html as html_lib
import re
from dataclasses import dataclass

from .model import DECK_DIALECT_VERSION, DeckParseError, parse_deck

_DIALECT_ATTR_RE = re.compile(r'<html\b[^>]*\bdata-lcx-dialect\s*=\s*"([^"]*)"', re.IGNORECASE)
_SLIDE_ROOT_RE = re.compile(r"^\s*<section\b([^>]*)>", re.IGNORECASE)
_CLASS_ATTR_RE = re.compile(r'class\s*=\s*"([^"]*)"')
_NODE_ID_RE = re.compile(r'data-node-id\s*=\s*"([^"]*)"')
_TAG_RE = re.compile(r"<[^>]+>")

# Cap on how many findings ride a single save-time result — a deck with
# dozens of issues gets the same "fix this and try again" signal as one
# with a handful, not a wall of text that buries the fix.
_MAX_WARNINGS = 8


@dataclass(frozen=True)
class DeckIssue:
    """One finding from validating a deck or a slide's HTML."""

    code: str
    slide_id: str | None
    node_id: str | None
    message: str


class TextIntegrityError(ValueError):
    """Extracted source text did not survive, unmodified, into slide HTML."""


def _class_list(attrs_text: str) -> set[str]:
    match = _CLASS_ATTR_RE.search(attrs_text)
    return set(match.group(1).split()) if match else set()


def validate_slide_html(body_html: str, *, slide_id: str | None = None) -> list[DeckIssue]:
    """Structural issues in one slide's body markup.

    Checks the ``<section class="slide">`` root and ``data-node-id``
    presence/uniqueness within the slide. Does not know about other slides —
    cross-slide duplicate ``data-slide-id`` is :func:`validate_deck`'s job.
    """
    issues: list[DeckIssue] = []
    root_match = _SLIDE_ROOT_RE.match(body_html)
    if not root_match or "slide" not in _class_list(root_match.group(1)):
        issues.append(
            DeckIssue(
                code="missing-slide-root",
                slide_id=slide_id,
                node_id=None,
                message='slide body must be rooted at <section class="slide">',
            )
        )

    seen: set[str] = set()
    for match in _NODE_ID_RE.finditer(body_html):
        node_id = match.group(1)
        if not node_id:
            issues.append(
                DeckIssue(
                    code="missing-node-id",
                    slide_id=slide_id,
                    node_id=None,
                    message="element has an empty data-node-id",
                )
            )
            continue
        if node_id in seen:
            issues.append(
                DeckIssue(
                    code="duplicate-node-id",
                    slide_id=slide_id,
                    node_id=node_id,
                    message=f"duplicate data-node-id {node_id!r} within slide",
                )
            )
        seen.add(node_id)
    return issues


def validate_deck(deck_html: str) -> list[DeckIssue]:
    """Structural issues across a whole deck: dialect version, ids, slides."""
    issues: list[DeckIssue] = []

    dialect_match = _DIALECT_ATTR_RE.search(deck_html)
    dialect_version = dialect_match.group(1) if dialect_match else None
    if dialect_version != DECK_DIALECT_VERSION:
        issues.append(
            DeckIssue(
                code="dialect-version",
                slide_id=None,
                node_id=None,
                message=(
                    f"deck dialect version is {dialect_version!r}, "
                    f"expected {DECK_DIALECT_VERSION!r}"
                ),
            )
        )

    try:
        deck = parse_deck(deck_html)
    except DeckParseError as exc:
        issues.append(DeckIssue(code="invalid-html", slide_id=None, node_id=None, message=str(exc)))
        return issues

    if not deck.slides:
        issues.append(
            DeckIssue(code="no-slides", slide_id=None, node_id=None, message="deck has no slides")
        )

    seen_slide_ids: set[str] = set()
    for slide in deck.slides:
        if slide.slide_id in seen_slide_ids:
            issues.append(
                DeckIssue(
                    code="duplicate-slide-id",
                    slide_id=slide.slide_id,
                    node_id=None,
                    message=f"duplicate data-slide-id {slide.slide_id!r}",
                )
            )
        seen_slide_ids.add(slide.slide_id)
        issues.extend(validate_slide_html(slide.body_html, slide_id=slide.slide_id))
    return issues


def _visible_text(text: str) -> str:
    """Plain text a reader would see, tags stripped, entities decoded."""
    return " ".join(html_lib.unescape(_TAG_RE.sub(" ", text)).split())


def ensure_text_equality(extraction_texts: list[str], slide_html: str) -> None:
    """Raise :class:`TextIntegrityError` if any extracted text is missing.

    Every non-blank string in ``extraction_texts`` (the source-of-truth text
    pulled from the ``.pptx``) must appear, verbatim after whitespace/entity
    normalization, in ``slide_html``'s rendered text. A model correction
    that drops or paraphrases source text fails this gate outright.
    """
    rendered = _visible_text(slide_html)
    missing = [
        text
        for text in extraction_texts
        if _visible_text(text) and _visible_text(text) not in rendered
    ]
    if missing:
        raise TextIntegrityError(f"slide html is missing extracted text: {missing!r}")


def _capped(warnings: list[str]) -> list[str]:
    if len(warnings) <= _MAX_WARNINGS:
        return warnings
    hidden = len(warnings) - _MAX_WARNINGS
    return [*warnings[:_MAX_WARNINGS], f"... and {hidden} more like these"]


def format_layout_warnings(warnings: list[str]) -> str:
    """The warnings as one block to append to a tool result ('' when clean)."""
    warnings = _capped(warnings)
    if not warnings:
        return ""
    lines = "\n".join(f"- {warning}" for warning in warnings)
    return (
        "\nDeck check:\n"
        f"{lines}\n"
        "These are exact findings read from the file you just saved. To see a "
        'slide as an image, export it and read the pptx with pages="grid".'
    )
