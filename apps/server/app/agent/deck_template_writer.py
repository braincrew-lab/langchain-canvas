"""Fill a locked archetype frame with new slot content (plan U3).

``instantiate_archetype`` (task 1) clones a pinned archetype frame and fills
its slots through the existing ``deck_editing.py::_replace_text`` (so
rich-run topology and style rules stay identical to manual editing), strips
any residual PPTX patch-provenance attributes (U4 requires a ``source=None``
instance to carry none), and rejects a fill that leaves original source
business text behind, misses a required slot, or supplies an unknown extra
slot.

``write_deck_from_template`` and ``generate_slot_content`` (task 4) complete
the ordered slot writer: ``verbatim`` copies request text through with no
model call (deterministic — the same template plus the same verbatim input
always produces identical canonical HTML); ``rewrite`` calls
``config.writer_model`` with only the archetype's observed writing-style
rules, the requested slots, and required facts as grounding — never the
source HTML or the scratch writer's ``DECK_STYLE``. A shared
:class:`~app.agent.deck_template_models.TemplateBudget` bounds every
model-call retry across the whole batch; any worker failure or budget
overflow aborts before the single closing ``store.write`` commit, so a
failed write never lands a partial deck.
"""

from __future__ import annotations

import contextvars
import hashlib
import html
import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from typing import Any

from langchain.chat_models import init_chat_model
from langchain.tools import ToolRuntime
from langchain_canvas.deck import Deck, SlideTemplate, serialize_deck
from langchain_canvas.replay import events_for_commit
from langchain_canvas.store import (
    CanvasFileNotFoundError,
    CanvasStore,
    CanvasStoreError,
    RevisionMismatchError,
)
from pydantic import ValidationError

from .deck_editing import _Markup, _replace_text
from .deck_template_models import (
    MAX_FACTS_PER_INSTANCE,
    MAX_METADATA_BYTES,
    MAX_SLOTS_PER_INSTANCE,
    Archetype,
    ArtifactRef,
    BudgetExceededError,
    SlideContentRequest,
    SlotContentResult,
    StyleRule,
    TemplateBudget,
    TemplateInstance,
    TemplateInstanceRequest,
    TemplateManifest,
)
from .deck_template_prompts import build_content_writer_prompt, content_writer_prompt_text
from .deck_templates import TrustError, _error, require_trusted_artifact

_PPTX_PROVENANCE_ATTR_RE = re.compile(r'\s+data-pptx-[a-zA-Z0-9-]*="[^"]*"')

# The one actor `write_deck_from_template`'s single closing commit uses (plan
# U4) — distinct from `deck_templates.TEMPLATE_COMPILER_ACTOR`, which owns
# the candidate/ready template artifacts this writer only ever reads.
TEMPLATE_WRITER_ACTOR = "deck-template-writer-v1"

# `write_deck_from_template` never creates a deck inside these namespaces
# (plan U3): they hold source uploads, exports, and pinned template
# artifacts, none of which are writer output destinations.
_RESERVED_DESTINATION_PREFIXES = ("sources/", "exports/", "templates/")

_DEFAULT_REWRITE_MAX_RESPONSE_TOKENS = 2000


class TemplateInstantiationError(ValueError):
    """A slot fill that violates the locked-frame contract of an archetype."""


@dataclass(frozen=True)
class ArchetypeFrame:
    """A pinned, reusable slide frame: fixed markup with named text slots.

    ``slot_node_ids`` maps each slot key to the ``data-node-id`` of the
    element ``_replace_text`` fills. The frame's markup, CSS, and every
    non-slot node are locked — instantiation only ever calls
    ``_replace_text`` on the slot node ids.
    """

    archetype_id: str
    style_css: str
    body_html: str
    slot_node_ids: dict[str, str]


def _strip_pptx_provenance(body_html: str) -> str:
    """Drop patch-provenance attributes so a ``source=None`` instance carries none."""
    return _PPTX_PROVENANCE_ATTR_RE.sub("", body_html)


def instantiate_archetype(
    frame: ArchetypeFrame,
    slide_index: int,
    slots: dict[str, str | list[str]],
    *,
    source_business_text: frozenset[str] = frozenset(),
) -> SlideTemplate:
    """Return a new ``slide-NNN`` :class:`SlideTemplate` with ``slots`` filled in.

    ``slots`` values are either a single plain-text replacement or an ordered
    list of rich-run strings, matching ``_replace_text``'s ``text``/``slots``
    duality. Raises :class:`TemplateInstantiationError` when a required slot
    is missing, an extra slot is unrecognized, or any string in
    ``source_business_text`` survives inside the filled body (a leaked
    original document sentence in a variable node).
    """
    missing = frame.slot_node_ids.keys() - slots.keys()
    if missing:
        raise TemplateInstantiationError(
            f"missing required slot(s): {sorted(missing)}"
        )
    unknown = slots.keys() - frame.slot_node_ids.keys()
    if unknown:
        raise TemplateInstantiationError(f"unknown extra slot(s): {sorted(unknown)}")

    body = _strip_pptx_provenance(frame.body_html)
    for slot_key, node_id in frame.slot_node_ids.items():
        value = slots[slot_key]
        if isinstance(value, str):
            body = _replace_text(body, node_id, value, None)
        else:
            body = _replace_text(body, node_id, None, list(value))

    for leftover in source_business_text:
        if leftover and leftover in body:
            raise TemplateInstantiationError(
                "source business text remains in a variable node after fill"
            )

    return SlideTemplate(
        slide_id=f"slide-{slide_index:03d}",
        title=None,
        style_css=frame.style_css,
        body_html=body,
    )


def _with_style_tokens(slide: SlideTemplate, archetype: Archetype) -> SlideTemplate:
    """Plant the archetype's design tokens on the instantiated markup root.

    ``style_css`` alone cannot be reversed back into tokens, so export reads
    them from this attribute (``export_fallback.py::_apply_theme_from_tokens``). An
    archetype without tokens gets no attribute at all — never an empty one.
    """
    if archetype.style_tokens is None:
        return slide
    markup = _Markup(slide.body_html)
    if not markup.nodes:
        return slide
    root = markup.nodes[0]
    cut = root.inner - (2 if slide.body_html[root.inner - 2 : root.inner] == "/>" else 1)
    payload = html.escape(archetype.style_tokens.model_dump_json(), quote=True)
    body = f'{slide.body_html[:cut]} data-style-tokens="{payload}"{slide.body_html[cut:]}'
    return replace(slide, body_html=body)


class InvalidModelOutputError(RuntimeError):
    """A ``rewrite`` model response failed schema, key, or fill validation.

    Raised only after the shared content-correction budget (first attempt
    plus up to ``max_content_retries`` retries) is exhausted.
    """


_TAG_RE = re.compile(r"<[^>]+>")


def _frame_from_archetype(archetype: Archetype) -> ArchetypeFrame:
    """The pinned, reusable frame a ready archetype's slots compile to."""
    return ArchetypeFrame(
        archetype_id=archetype.id,
        style_css=archetype.style_css,
        body_html=archetype.frame_html,
        slot_node_ids={slot.key: slot.node_id for slot in archetype.slots},
    )


def _slot_source_texts(frame: ArchetypeFrame) -> frozenset[str]:
    """The literal business text each locked slot node holds before a fill.

    A real compiled archetype's slot nodes still hold the original source
    sentence until filled; comparing the filled body against this set is
    ``instantiate_archetype``'s leftover-source-text guard.
    """
    texts: set[str] = set()
    markup = _Markup(frame.body_html)
    for node_id in frame.slot_node_ids.values():
        try:
            node = markup.target(node_id)
        except ValueError:
            continue
        inner = frame.body_html[node.inner : node.close]
        text = _TAG_RE.sub("", inner).strip()
        if text:
            texts.add(text)
    return frozenset(texts)


def _check_instance_budget(request: SlideContentRequest) -> str | None:
    """A budget-violation message for ``request``, or ``None`` if within bounds.

    Per-run/per-fact-text-length caps are already enforced by
    :class:`SlideContentRequest`'s field types; this checks the combined
    slot-plus-rich-run count and fact count the plan bounds jointly (v1
    admission caps: 32 facts, 64 slots+rich runs per instance).
    """
    slot_and_run_count = sum(
        len(value) if isinstance(value, list) else 1 for value in request.slots.values()
    )
    if slot_and_run_count > MAX_SLOTS_PER_INSTANCE:
        return f"slot/rich-run count {slot_and_run_count} exceeds {MAX_SLOTS_PER_INSTANCE}"
    if len(request.required_facts) > MAX_FACTS_PER_INSTANCE:
        return f"required_facts count exceeds {MAX_FACTS_PER_INSTANCE}"
    return None


def _is_reserved_destination(destination: str) -> bool:
    return destination.startswith(_RESERVED_DESTINATION_PREFIXES)


def _verbatim_slot_content(request: SlideContentRequest) -> SlotContentResult:
    """Copy ``request.slots`` through unchanged — no model call, deterministic."""
    fact_coverage: dict[str, str] = {}
    for fact in request.required_facts:
        for slot_key, value in request.slots.items():
            runs = value if isinstance(value, list) else [value]
            if any(fact.text in run for run in runs):
                fact_coverage[fact.id] = slot_key
                break
    return SlotContentResult(
        archetype_id=request.archetype_id,
        mode="verbatim",
        slots=dict(request.slots),
        fact_coverage=fact_coverage,
    )


def _writing_style_for_request(
    archetype: Archetype, request: SlideContentRequest
) -> list[StyleRule]:
    """The archetype's style rules for exactly the roles ``request`` fills."""
    slots_by_key = {slot.key: slot for slot in archetype.slots}
    roles = {slots_by_key[key].role for key in request.slots if key in slots_by_key}
    return [rule for rule in archetype.writing_style if rule.role in roles]


def _invoke_rewrite_model(
    writer_model: str, messages: list[dict[str, str]]
) -> SlotContentResult:
    """Call the writer model for one ``rewrite`` slot-content response.

    ``with_structured_output`` both shapes the call and validates the
    response against :class:`SlotContentResult` — a bad schema, an
    HTML-bearing slot, or an oversize field surfaces as a
    :class:`~pydantic.ValidationError` from this call, not a silent
    coercion.
    """
    model = init_chat_model(writer_model)
    structured = model.with_structured_output(SlotContentResult)
    return structured.invoke(messages)


def _validate_rewrite_result(
    result: SlotContentResult, request: SlideContentRequest
) -> None:
    if result.mode != "rewrite":
        raise InvalidModelOutputError("model output mode must be 'rewrite'")
    if set(result.slots) != set(request.slots):
        raise InvalidModelOutputError(
            "model output slot keys do not match the requested slots"
        )


def generate_slot_content(
    request: SlideContentRequest,
    archetype: Archetype,
    *,
    writer_model: str,
    budget: TemplateBudget,
    budget_lock: threading.Lock | None = None,
    invoke_model=_invoke_rewrite_model,
) -> SlotContentResult:
    """One fill attempt for ``request``: verbatim copies input, rewrite calls
    the writer model exactly once.

    ``rewrite`` sees only the archetype's writing-style rules (filtered to
    the requested slots' roles), the requested slots, and the required
    facts — never source HTML or the scratch writer's ``DECK_STYLE``. The
    model call is reserved against ``budget`` (shared across a whole
    ``write_deck_from_template`` batch) before it is made, under
    ``budget_lock`` since :class:`TemplateBudget` is not itself thread-safe.
    Raises :class:`~pydantic.ValidationError` or :class:`InvalidModelOutputError`
    on a bad response; retrying belongs to the caller (see
    ``_fill_and_instantiate``), which also retries a frame-fill failure the
    model response alone could not reveal.
    """
    if request.mode == "verbatim":
        return _verbatim_slot_content(request)

    lock = budget_lock or threading.Lock()
    writing_style = _writing_style_for_request(archetype, request)
    messages = build_content_writer_prompt(request, writing_style)
    prompt_text = content_writer_prompt_text(request, writing_style)
    with lock:
        budget.reserve_model_call(
            prompt_text=prompt_text,
            max_response_tokens=_DEFAULT_REWRITE_MAX_RESPONSE_TOKENS,
        )
    result = invoke_model(writer_model, messages)
    _validate_rewrite_result(result, request)
    return result


def _fill_and_instantiate(
    slide_index: int,
    request: SlideContentRequest,
    frame: ArchetypeFrame,
    archetype: Archetype,
    *,
    writer_model: str,
    budget: TemplateBudget,
    budget_lock: threading.Lock,
    max_content_retries: int,
    invoke_model=_invoke_rewrite_model,
) -> tuple[SlideTemplate, SlotContentResult]:
    """Fill one requested slide and instantiate it against its locked frame.

    ``verbatim`` is model-free and never retried (a fill failure there is a
    request/frame mismatch, not a correctable model error). ``rewrite``
    retries the whole generate-then-instantiate step up to
    ``max_content_retries`` times after the first attempt — so a rich-run
    count mismatch caught only by ``instantiate_archetype`` also consumes a
    retry, and every attempt keeps the same required facts and requested
    slots (``request`` is reused unchanged).
    """
    source_texts = _slot_source_texts(frame)
    if request.mode == "verbatim":
        result = generate_slot_content(
            request, archetype, writer_model=writer_model, budget=budget,
            budget_lock=budget_lock,
        )
        slide = instantiate_archetype(
            frame, slide_index, result.slots, source_business_text=source_texts
        )
        return _with_style_tokens(slide, archetype), result

    attempt = 0
    last_error: Exception | None = None
    while attempt <= max_content_retries:
        try:
            result = generate_slot_content(
                request, archetype, writer_model=writer_model, budget=budget,
                budget_lock=budget_lock, invoke_model=invoke_model,
            )
            slide = instantiate_archetype(
                frame, slide_index, result.slots, source_business_text=source_texts
            )
            return _with_style_tokens(slide, archetype), result
        except (
            ValidationError,
            InvalidModelOutputError,
            TemplateInstantiationError,
            ValueError,
        ) as exc:
            last_error = exc
            attempt += 1

    raise InvalidModelOutputError(f"invalid model output after retries: {last_error}")


def _instance_request(request: SlideContentRequest) -> TemplateInstanceRequest:
    """The immutable original request, frozen for the U4 provenance contract."""
    input_slots = {
        key: (value if isinstance(value, list) else [value])
        for key, value in request.slots.items()
    }
    verbatim_expectations = dict(input_slots) if request.mode == "verbatim" else None
    return TemplateInstanceRequest(
        mode=request.mode,
        locale=request.locale,
        required_facts=list(request.required_facts),
        input_slots=input_slots,
        verbatim_expectations=verbatim_expectations,
    )


def _error_for_exception(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, BudgetExceededError):
        return _error("resource_budget_exceeded", str(exc))
    if isinstance(exc, InvalidModelOutputError):
        return _error("invalid_model_output", str(exc))
    if isinstance(exc, (TemplateInstantiationError, ValueError)):
        return _error("ambiguous_slots", str(exc))
    return _error("verification_failed", str(exc))


def write_deck_from_template(
    template_ref: ArtifactRef,
    destination: str,
    title: str,
    slides: list[SlideContentRequest],
    runtime: ToolRuntime,
    *,
    store: CanvasStore,
    canvas_id: str,
    writer_model: str,
    concurrency: int = 1,
    max_content_retries: int = 2,
    budget: TemplateBudget | None = None,
) -> dict[str, Any]:
    """Fill a trusted ``ready`` template's archetypes into a new deck.

    Reads ``template_ref`` only through ``deck_templates.require_trusted_artifact``
    (never re-converts the source). Every requested slide is generated and
    instantiated against its archetype's locked frame — concurrently, up to
    ``concurrency`` workers, each in a fresh ``contextvars`` copy (mirroring
    ``deck_batch.generate_slide_bodies``) — and results are collected in
    ``slides`` order. Any single failure (budget overflow, invalid model
    output, or a fill that cannot satisfy its frame) aborts the whole call:
    the destination is checked for absence up front and the deck is written
    exactly once, at the end, with the start snapshot's revision as
    ``base_revision`` so a concurrent creation is rejected rather than
    silently overwritten.
    """
    if not slides or len(slides) > 100:
        return _error("ambiguous_slots", "slides must contain between 1 and 100 requests")
    if _is_reserved_destination(destination):
        return _error(
            "destination_exists",
            f"{destination} is a reserved namespace and is not a writable destination",
        )

    try:
        history = store.history(canvas_id, limit=1)
    except CanvasStoreError as exc:
        return _error("verification_failed", str(exc))
    base_revision = history[0].revision if history else None

    try:
        store.read(canvas_id, destination)
    except CanvasFileNotFoundError:
        pass
    except CanvasStoreError as exc:
        return _error("verification_failed", str(exc))
    else:
        return _error("destination_exists", f"{destination} already exists on this canvas")

    try:
        manifest = require_trusted_artifact(
            store, canvas_id, template_ref, expected_status="ready"
        )
    except TrustError as exc:
        return _error(exc.code, str(exc))

    archetypes_by_id = {archetype.id: archetype for archetype in manifest.archetypes}
    for request in slides:
        if request.archetype_id not in archetypes_by_id:
            return _error(
                "ambiguous_slots", f"unknown archetype_id {request.archetype_id!r}"
            )
        budget_issue = _check_instance_budget(request)
        if budget_issue:
            return _error("resource_budget_exceeded", budget_issue)

    run_budget = budget or TemplateBudget()
    budget_lock = threading.Lock()

    def _one(pair: tuple[int, SlideContentRequest]) -> tuple[SlideTemplate, SlotContentResult]:
        index, request = pair
        archetype = archetypes_by_id[request.archetype_id]
        frame = _frame_from_archetype(archetype)
        return _fill_and_instantiate(
            index + 1,
            request,
            frame,
            archetype,
            writer_model=writer_model,
            budget=run_budget,
            budget_lock=budget_lock,
            max_content_retries=max_content_retries,
        )

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        futures = [
            pool.submit(contextvars.copy_context().run, _one, pair)
            for pair in enumerate(slides)
        ]
        outcomes: list[tuple[SlideTemplate, SlotContentResult] | Exception] = []
        for future in futures:
            try:
                outcomes.append(future.result())
            except Exception as exc:  # noqa: BLE001 - collected, mapped below
                outcomes.append(exc)

    for outcome in outcomes:
        if isinstance(outcome, Exception):
            return _error_for_exception(outcome)

    filled: list[tuple[SlideTemplate, SlotContentResult]] = outcomes  # type: ignore[assignment]
    template_slides = [slide for slide, _ in filled]

    instances = {
        slide.slide_id: TemplateInstance(
            archetype_id=request.archetype_id,
            source_page=archetypes_by_id[request.archetype_id].source_page,
            slot_content_sha256=hashlib.sha256(slide.body_html.encode("utf-8")).hexdigest(),
            request=_instance_request(request),
            fact_to_slot=dict(result.fact_coverage),
        )
        for (slide, result), request in zip(filled, slides, strict=True)
    }
    manifest_payload = TemplateManifest(template=template_ref, instances=instances)
    template_json = manifest_payload.model_dump(mode="json")
    if len(json.dumps(template_json, ensure_ascii=False).encode("utf-8")) > MAX_METADATA_BYTES:
        return _error(
            "template_capacity_exceeded",
            f"combined template metadata exceeds {MAX_METADATA_BYTES} bytes",
        )

    deck = Deck(
        title=title,
        ratio=manifest.ratio,
        source=None,
        slides=template_slides,
        template=template_json,
    )
    content = serialize_deck(deck)
    description = f"Write deck from template: {title[:50]}"
    try:
        commit = store.write(
            canvas_id,
            destination,
            content,
            description,
            base_revision=base_revision,
            actor=TEMPLATE_WRITER_ACTOR,
        )
    except RevisionMismatchError:
        return _error("destination_exists", f"{destination} was created concurrently")
    except CanvasStoreError as exc:
        return _error("verification_failed", str(exc))

    writer = getattr(runtime, "stream_writer", None)
    if writer is not None:
        for event in events_for_commit(
            destination,
            content,
            is_new=True,
            revision=commit.revision,
            description=description,
        ):
            writer(event)

    return {
        "status": "ok",
        "path": destination,
        "revision": commit.revision,
        "slide_count": len(template_slides),
        "budget_consumed": run_budget.consumed_state(),
    }
