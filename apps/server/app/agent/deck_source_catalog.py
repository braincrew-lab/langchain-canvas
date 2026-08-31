"""Pattern census over an uploaded source — read-only, hash-pinned pagination.

``inspect_patterns`` is the app-side wrapper the plan's ``inspect_deck_patterns``
tool (wired in a later task) calls: it resolves the runtime's own canvas,
reads one of its ``sources/`` uploads, and delegates the actual census and
grouping to :mod:`langchain_canvas.deck.source_inventory` and
:mod:`langchain_canvas.deck.patterns`. This module owns only the
application-layer contract — canvas/path resolution, cursor encoding, and
result-shape bounds (``page_limit``, max 12 groups, example truncation) — not
the parsing itself.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

from langchain.tools import ToolRuntime
from langchain_canvas.deck.patterns import select_representatives
from langchain_canvas.deck.source_inventory import (
    OversizedPageError,
    SourceInventoryError,
    inspect_source_pages,
)
from langchain_canvas.store import (
    CanvasFileNotFoundError,
    CanvasStore,
    CanvasStoreError,
    validate_relpath,
)

from .deck_editing import _tid

logger = logging.getLogger(__name__)

_SCHEMA_VERSION = 1
_MIN_PAGE_LIMIT = 1
_MAX_PAGE_LIMIT = 50
_MAX_SOURCE_PAGES = 500
_MAX_GROUPS = 12
_MAX_EXAMPLE_CHARS = 160
_MAX_EXAMPLES_PER_ROLE = 2


def _encode_cursor(source_sha256: str, next_page: int) -> str:
    """An opaque, self-describing cursor pinned to the exact source bytes."""
    payload = {
        "schema_version": _SCHEMA_VERSION,
        "source_sha256": source_sha256,
        "next_page": next_page,
    }
    encoded = json.dumps(payload, sort_keys=True).encode()
    return base64.urlsafe_b64encode(encoded).decode()


def _decode_cursor(cursor: str) -> dict[str, Any]:
    """Strictly validate a cursor's shape; any deviation is ``invalid_cursor``."""
    try:
        raw = base64.urlsafe_b64decode(cursor.encode())
        payload = json.loads(raw.decode())
    except Exception as exc:  # noqa: BLE001 — any malformed cursor is one failure
        raise ValueError("invalid_cursor") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != _SCHEMA_VERSION:
        raise ValueError("invalid_cursor")
    source_sha256 = payload.get("source_sha256")
    next_page = payload.get("next_page")
    if not isinstance(source_sha256, str) or not isinstance(next_page, int):
        raise ValueError("invalid_cursor")
    return {"source_sha256": source_sha256, "next_page": next_page}


def inspect_patterns(
    store: CanvasStore,
    runtime: ToolRuntime,
    source: str,
    cursor: str | None = None,
    page_limit: int = 50,
) -> dict[str, Any]:
    """Census a ``sources/*.pdf``/``*.pptx`` upload and group repeated layouts.

    Reads only the runtime's own canvas — the caller cannot name a different
    canvas or supply raw bytes. ``source`` must be a ``sources/`` upload
    ending in ``.pdf`` or ``.pptx``. Returns at most 12 groups drawn from the
    pages this call actually inspected (never a global-coverage claim); pass
    the returned ``next_cursor`` to continue. A cursor is valid only against
    the exact source bytes it was issued for — re-inspecting an overwritten
    upload with a stale cursor returns ``{"error": "stale_source"}`` instead
    of silently mixing pages from two different files.
    """
    try:
        validate_relpath(source)
    except CanvasStoreError as exc:
        return {"error": str(exc)}
    if not source.startswith("sources/") or not source.lower().endswith((".pdf", ".pptx")):
        return {"error": "source must be a sources/*.pdf or sources/*.pptx upload"}
    if not _MIN_PAGE_LIMIT <= page_limit <= _MAX_PAGE_LIMIT:
        return {
            "error": f"page_limit must be between {_MIN_PAGE_LIMIT} and {_MAX_PAGE_LIMIT}"
        }

    start_page = 1
    expected_sha256: str | None = None
    if cursor is not None:
        try:
            payload = _decode_cursor(cursor)
        except ValueError:
            return {"error": "invalid_cursor"}
        start_page = payload["next_page"]
        expected_sha256 = payload["source_sha256"]

    canvas_id = _tid(runtime)
    try:
        got = store.read_bytes(canvas_id, source)
    except CanvasFileNotFoundError as exc:
        return {"error": str(exc)}
    except CanvasStoreError as exc:
        return {"error": str(exc)}

    try:
        result = inspect_source_pages(
            got.data, path=source, start_page=start_page, limit=page_limit
        )
    except (OversizedPageError, SourceInventoryError) as exc:
        return {"error": str(exc)}

    if expected_sha256 is not None and expected_sha256 != result.fingerprint.sha256:
        return {"error": "stale_source"}
    if result.fingerprint.page_count > _MAX_SOURCE_PAGES:
        return {
            "error": (
                f"{source} has {result.fingerprint.page_count} pages — over the "
                f"{_MAX_SOURCE_PAGES}-page limit"
            )
        }

    groups = select_representatives(list(result.pages))[:_MAX_GROUPS]
    unknown_pages = [page.page_number for page in result.pages if page.needs_visual_inspection]
    next_cursor = (
        _encode_cursor(result.fingerprint.sha256, result.next_start_page)
        if result.next_start_page is not None
        else None
    )

    return {
        "source": source,
        "source_revision": got.revision,
        "source_sha256": result.fingerprint.sha256,
        "page_count": result.fingerprint.page_count,
        "inspected_pages": [page.page_number for page in result.pages],
        "scope_complete": result.scope_complete,
        "groups": [
            {
                "pattern_id": group.pattern_id,
                "member_pages": list(group.member_pages),
                "representative_page": group.representative_page,
                "support_count": group.support_count,
                "roles": list(group.roles),
                "capability_issues": list(group.capability_issues),
                "examples": {
                    role: [text[:_MAX_EXAMPLE_CHARS] for text in texts[:_MAX_EXAMPLES_PER_ROLE]]
                    for role, texts in group.examples.items()
                },
                "confidence_basis": group.confidence_basis,
            }
            for group in groups
        ],
        "unknown_pages": unknown_pages,
        "next_cursor": next_cursor,
    }
