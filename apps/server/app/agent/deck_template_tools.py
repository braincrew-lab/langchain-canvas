"""Public tool bindings for source-grounded slide templates (plan U5, task 6).

Bundles the four public tools the plan names: ``inspect_deck_patterns`` (a
thin re-export of :func:`deck_source_catalog.inspect_patterns`, which already
owns the app-layer contract), ``define_deck_template`` (dispatches to
:func:`deck_templates.prepare_template`/``finalize_template`` by ``mode``),
``write_deck_from_template`` (wraps :func:`deck_template_writer.write_deck_from_template`),
and ``verify_template_deck`` (wraps
:func:`deck_template_verification.verify_template_deck_snapshot`).

Every tool validates its own input into the typed request models from
``deck_template_models`` before calling the underlying function, and returns
that function's own ``{status: 'error', code, message, details, retryable}``
shape on failure (see ``deck_templates._error``) — a request-shape validation
failure surfaces through the same closed code set, never a raw traceback.
Every store access is scoped to the calling runtime's own canvas
(``deck_editing._tid``), so an ``ArtifactRef``/``SourceRef`` can never name a
different canvas; ``require_trusted_artifact`` (used by ``finalize`` and
``write``/``verify`` internally) is the sole boundary that accepts a
candidate/ready/template reference, so a forged JSON body at a matching path
is never accepted as compiler or writer output.
"""

from __future__ import annotations

import hashlib
from typing import Literal

from langchain.tools import ToolRuntime, tool
from langchain_canvas.store import CanvasStore, CanvasStoreError
from pydantic import ValidationError

from .configuration import config
from .deck_editing import _tid
from .deck_source_catalog import inspect_patterns
from .deck_template_models import (
    ArtifactRef,
    FinalizeRequest,
    PrepareRequest,
    SlideContentRequest,
)
from .deck_template_verification import verify_template_deck_snapshot
from .deck_template_writer import write_deck_from_template as _write_deck_from_template
from .deck_templates import (
    TrustError,
    _error,
    finalize_template,
    prepare_template,
    require_trusted_artifact,
)


def create_deck_template_tools(store: CanvasStore) -> list:
    """Bind the four source-grounded-template tools to ``store``."""

    @tool
    def inspect_deck_patterns(
        source: str,
        runtime: ToolRuntime,
        cursor: str | None = None,
        page_limit: int = 50,
    ) -> dict:
        """Census a ``sources/*.pdf``/``*.pptx`` upload and group its repeated page layouts.

        Read-only — never renders or converts a page. Returns at most 12
        groups drawn only from the pages this call actually inspected (never
        a global-coverage claim); pass the returned ``next_cursor`` to
        continue. Call this first when the user wants to reuse a specific
        document's page layout and writing style for a new topic, before
        ``define_deck_template``.
        """
        return inspect_patterns(
            store, runtime, source, cursor=cursor, page_limit=page_limit
        )

    @tool
    def define_deck_template(
        mode: Literal["prepare", "finalize"],
        runtime: ToolRuntime,
        source: str | None = None,
        source_sha256: str | None = None,
        pages: list[int] | None = None,
        candidate_ref: dict | None = None,
        bindings: list[dict] | None = None,
    ) -> dict:
        """Compile selected source pages into a reusable template — two-call protocol.

        ``mode='prepare'`` (needs ``source``, ``source_sha256``, ``pages``)
        converts only those pages into an unresolved, non-writable
        ``candidate`` and returns its node/slot proposal plus a
        ``candidate_ref`` — read the selected pages with
        ``inspect_deck_patterns`` first. ``mode='finalize'`` (needs
        ``candidate_ref`` and explicit ``bindings`` — one
        variable/retain/omit disposition per candidate node) validates every
        node is classified and every native/reconstruction capability check
        passed, then writes a ``ready`` template usable by
        ``write_deck_from_template``. Never call this for exact source
        reproduction or for editing an existing deck's content.
        """
        canvas_id = _tid(runtime)
        if mode == "prepare":
            if source is None or source_sha256 is None or pages is None:
                return _error(
                    "invalid_source",
                    "prepare requires source, source_sha256, and pages",
                )
            if not source.startswith("sources/") or not source.lower().endswith(
                (".pdf", ".pptx")
            ):
                return _error(
                    "invalid_source",
                    "source must be a sources/*.pdf or sources/*.pptx upload",
                )
            try:
                request = PrepareRequest(
                    mode="prepare",
                    source=source,
                    source_sha256=source_sha256,
                    pages=pages,
                )
            except ValidationError as exc:
                return _error("invalid_source", str(exc))
            return prepare_template(request, store=store, canvas_id=canvas_id)

        if mode == "finalize":
            if candidate_ref is None or bindings is None:
                return _error(
                    "ambiguous_slots", "finalize requires candidate_ref and bindings"
                )
            try:
                ref = ArtifactRef.model_validate(candidate_ref)
                request = FinalizeRequest(
                    mode="finalize", candidate_ref=ref, bindings=bindings
                )
            except ValidationError as exc:
                return _error("ambiguous_slots", str(exc))
            try:
                candidate = require_trusted_artifact(
                    store, canvas_id, ref, expected_status="candidate"
                )
            except TrustError as exc:
                return _error(exc.code, str(exc))
            try:
                current_bytes = store.read_bytes(canvas_id, candidate.source.path).data
            except CanvasStoreError as exc:
                return _error("invalid_source", str(exc))
            current_source_sha256 = hashlib.sha256(current_bytes).hexdigest()
            return finalize_template(
                request,
                store=store,
                canvas_id=canvas_id,
                current_source_sha256=current_source_sha256,
            )

        return _error("invalid_source", "mode must be 'prepare' or 'finalize'")

    @tool
    def write_deck_from_template(
        template_ref: dict,
        destination: str,
        title: str,
        slides: list[dict],
        runtime: ToolRuntime,
    ) -> dict:
        """Fill a trusted ``ready`` template's archetypes into a new deck.

        Each entry in ``slides`` names an ``archetype_id`` from the ready
        template plus a ``mode`` (``verbatim`` copies text through
        unchanged; ``rewrite`` calls the writer model with only that
        archetype's observed writing style, the requested slot text, and
        ``required_facts`` as grounding — never the original source HTML).
        Call ``verify_template_deck`` on the result before reporting
        success. Never used for exact source reproduction or scratch decks
        — use ``plan_deck``/``write_slides`` or the reproduction tools for
        those.
        """
        canvas_id = _tid(runtime)
        try:
            ref = ArtifactRef.model_validate(template_ref)
            slide_requests = [
                SlideContentRequest.model_validate(slide) for slide in slides
            ]
        except ValidationError as exc:
            return _error("ambiguous_slots", str(exc))
        return _write_deck_from_template(
            ref,
            destination,
            title,
            slide_requests,
            runtime,
            store=store,
            canvas_id=canvas_id,
            writer_model=config.writer_model,
            concurrency=config.deck_writer_concurrency,
        )

    @tool
    def verify_template_deck(path: str, revision: str, runtime: ToolRuntime) -> dict:
        """Verify one ``write_deck_from_template`` output's visual/content/style proofs.

        Recovers the immutable original request contract and the pinned
        ready template from store history alone (never in-memory state), so
        it works identically after a restart. Report the returned
        ``complete`` flag and per-dimension ``status``/``issues`` honestly —
        a saved deck is never fidelity-approved on its own.
        """
        canvas_id = _tid(runtime)
        return verify_template_deck_snapshot(
            path,
            revision,
            store=store,
            canvas_id=canvas_id,
            judge_model=config.writer_model,
        )

    return [
        inspect_deck_patterns,
        define_deck_template,
        write_deck_from_template,
        verify_template_deck,
    ]
