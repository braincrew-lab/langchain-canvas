"""U2 template compiler: ``prepare``/``finalize`` and the compiler-origin trust gate.

``prepare_template`` converts only the selected sample pages of a source
into an unresolved, non-writable ``candidate`` manifest. ``finalize_template``
takes a trusted candidate plus explicit node dispositions (bindings) and, only
when every node is classified and no unsupported native dependency or
degraded reconstruction remains, writes a ``ready`` template. Both stages —
and the PDF render/reconstruction and model calls inside them — run under a
shared :class:`~app.agent.deck_template_models.TemplateBudget`.

``require_trusted_artifact`` is the compiler-origin trust boundary: a
candidate or ready manifest is only ever read back if the exact historical
commit that wrote it used the internal ``deck-template-compiler-v1`` actor
(never exposed to the generic ``write``/human-save path — see
``tools.py``/``routes/canvas.py``), so a forged JSON file with a matching
``status``/hash cannot be laundered into template input.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Callable

from langchain_canvas.deck._shapes import PptxImportError
from langchain_canvas.deck.baseline import baseline_slide_html
from langchain_canvas.deck.extract import extract_slides
from langchain_canvas.deck.source_inventory import (
    OversizedPageError,
    SourceInventoryError,
    inspect_source_pages,
)
from langchain_canvas.store import CanvasFileNotFoundError, CanvasStore, CanvasStoreError

from .deck_editing import _Markup
from .deck_template_models import (
    MAX_CANDIDATE_JSON_BYTES,
    Archetype,
    ArtifactRef,
    BudgetExceededError,
    CompiledTemplateManifest,
    FinalizeRequest,
    PrepareRequest,
    Slot,
    SourceRef,
    StaticNode,
    TemplateBudget,
)
from .pdf_deck import reconstruct_pdf_page
from .pdf_source import PdfPageSource, extract_pdf_pages

# The one actor create-only prepare/finalize writes use — never accepted from
# the generic public write/human-save path (`tools.py`, `routes/canvas.py`).
TEMPLATE_COMPILER_ACTOR = "deck-template-compiler-v1"

# Native dependencies `source_inventory`'s census already flags that this v1
# compiler cannot resolve into a faithful HTML frame — see plan U2's
# capability gate.
_UNRESOLVED_CAPABILITY_ISSUES = frozenset(
    {
        "group",
        "native_table",
        "chart",
        "smartart",
        "master_background",
        "text_fill",
        "text_outline",
        "text_vertical_anchor",
        "text_paragraph_spacing",
    }
)

_ERROR_CODES = frozenset(
    {
        "invalid_source",
        "stale_source",
        "stale_template",
        "ambiguous_slots",
        "unsupported_template",
        "template_capacity_exceeded",
        "invalid_model_output",
        "destination_exists",
        "verification_failed",
        "resource_budget_exceeded",
    }
)


def _error(code: str, message: str, *, details: dict[str, Any] | None = None) -> dict[str, Any]:
    assert code in _ERROR_CODES, f"unknown template tool error code: {code}"
    return {
        "status": "error",
        "code": code,
        "message": message,
        "details": details or {},
        "retryable": code == "resource_budget_exceeded",
    }


class TrustError(RuntimeError):
    """``require_trusted_artifact`` found no matching compiler-origin commit."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _create_only_write(
    store: CanvasStore, canvas_id: str, path: str, content: str, *, description: str
):
    """Write ``path`` only if it does not already exist (idempotent by hash).

    ``CanvasStore.write`` has no native create-only mode; this wraps it with
    a read-first check. The path is content-addressed
    (``templates/<hash>.{candidate,template}.json``), so a pre-existing file
    at the same path already holds byte-identical content — read it back
    instead of writing again.
    """
    try:
        existing = store.read(canvas_id, path)
    except CanvasFileNotFoundError:
        return store.write(canvas_id, path, content, description, actor=TEMPLATE_COMPILER_ACTOR)
    return existing


def require_trusted_artifact(
    store: CanvasStore, canvas_id: str, ref: ArtifactRef, *, expected_status: str
) -> CompiledTemplateManifest:
    """Read back ``ref`` only if its exact revision was written by the compiler.

    Verifies, against ``store.history`` (never trusting the JSON body's own
    ``status``/hash fields as authentication): the named revision exists for
    ``ref.path``, its ``actor`` is :data:`TEMPLATE_COMPILER_ACTOR`, and the
    revision's stored bytes hash to ``ref.sha256``. Raises :class:`TrustError`
    on any mismatch — a generic ``write``/human-save commit at the same path,
    or a forged JSON body, is never accepted as compiler output.
    """
    commits = store.history(canvas_id)
    matching = [
        commit
        for commit in commits
        if commit.revision == ref.revision and ref.path in commit.paths
    ]
    if not matching:
        raise TrustError(
            "verification_failed", f"no commit at revision {ref.revision} touched {ref.path}"
        )
    if matching[0].actor != TEMPLATE_COMPILER_ACTOR:
        raise TrustError(
            "verification_failed",
            f"{ref.path}@{ref.revision} was not written by the template compiler",
        )
    try:
        content = store.read(canvas_id, ref.path, revision=ref.revision)
    except CanvasFileNotFoundError as exc:
        raise TrustError("verification_failed", str(exc)) from exc
    actual_hash = hashlib.sha256(content.content.encode("utf-8")).hexdigest()
    if actual_hash != ref.sha256:
        raise TrustError(
            "verification_failed", f"{ref.path}@{ref.revision} bytes do not match {ref.sha256}"
        )
    manifest = CompiledTemplateManifest.model_validate_json(content.content)
    if manifest.status != expected_status:
        raise TrustError(
            "verification_failed",
            f"{ref.path}@{ref.revision} is {manifest.status!r}, expected {expected_status!r}",
        )
    return manifest


def check_source_to_frame(
    capability_issues: dict[int, tuple[str, ...]],
    reconstruction_issues: dict[int, list[str]],
) -> dict[str, Any]:
    """A ``proof.source_to_frame`` summary: which selected pages fail closed.

    A page with any :data:`_UNRESOLVED_CAPABILITY_ISSUES` native dependency,
    or any non-empty PDF reconstruction review issue, is ``failed`` — the
    caller must never promote such a page to ``ready``.
    """
    failed_pages = sorted(
        {
            page
            for page, issues in capability_issues.items()
            if set(issues) & _UNRESOLVED_CAPABILITY_ISSUES
        }
        | {page for page, issues in reconstruction_issues.items() if issues}
    )
    return {"failed_pages": failed_pages, "status": "failed" if failed_pages else "checked"}


@dataclass
class _CompiledPage:
    archetype: Archetype
    capability_issues: tuple[str, ...]
    reconstruction_issues: list[str]


def prepare_template(
    request: PrepareRequest,
    *,
    store: CanvasStore,
    canvas_id: str,
    budget: TemplateBudget | None = None,
    reconstruct_pdf_page_fn: Callable[[PdfPageSource], tuple[str, list[str]]] = (
        reconstruct_pdf_page
    ),
) -> dict[str, Any]:
    """Compile only ``request.pages`` of ``request.source`` into a candidate.

    Never calls the full import tool — PDF pages go through
    ``extract_pdf_pages`` + ``reconstruct_pdf_page_fn`` (a model call, budget
    permitting); PPTX pages go through ``extract_slides`` +
    ``baseline_slide_html`` (deterministic, no model call). Writes
    ``templates/<hash>.candidate.json`` create-only and returns its ref plus
    a compact node/slot summary — never the frame HTML itself.
    """
    budget = budget or TemplateBudget()
    try:
        with budget.run_stage("read_source"):
            source_bytes = store.read_bytes(canvas_id, request.source).data
    except CanvasStoreError as exc:
        return _error("invalid_source", str(exc))
    except Exception as exc:  # noqa: BLE001 - budget/render boundary
        return _error("resource_budget_exceeded", str(exc))

    actual_hash = hashlib.sha256(source_bytes).hexdigest()
    if actual_hash != request.source_sha256:
        return _error(
            "invalid_source",
            f"{request.source} does not match the given source_sha256",
        )

    lowered = request.source.lower()
    try:
        if lowered.endswith(".pdf"):
            pages, ratio = _compile_pdf_archetypes(
                source_bytes, request.pages, budget, path=request.source,
                reconstruct_pdf_page_fn=reconstruct_pdf_page_fn,
            )
        elif lowered.endswith(".pptx"):
            pages, ratio = _compile_pptx_archetypes(
                source_bytes, request.pages, budget, path=request.source
            )
        else:
            return _error("invalid_source", f"{request.source} is neither .pdf nor .pptx")
    except BudgetExceededError as exc:
        return _error("resource_budget_exceeded", str(exc))
    except (PptxImportError, SourceInventoryError, OversizedPageError) as exc:
        return _error("invalid_source", str(exc))

    manifest = CompiledTemplateManifest(
        status="candidate",
        source=SourceRef(path=request.source, revision="head", sha256=actual_hash),
        selected_pages=sorted(request.pages),
        ratio=ratio,
        archetypes=[page.archetype for page in pages],
    )
    payload = manifest.model_dump_json()
    if len(payload.encode("utf-8")) > MAX_CANDIDATE_JSON_BYTES:
        return _error(
            "template_capacity_exceeded",
            f"candidate JSON is over the {MAX_CANDIDATE_JSON_BYTES}-byte limit",
        )
    candidate_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    path = f"templates/{candidate_hash}.candidate.json"
    try:
        commit = _create_only_write(
            store, canvas_id, path, payload,
            description=f"prepare template candidate for {request.source}",
        )
    except CanvasStoreError as exc:
        return _error("invalid_source", str(exc))

    return {
        "status": "candidate",
        "candidate_ref": {"path": path, "revision": commit.revision, "sha256": candidate_hash},
        "archetypes": [
            {
                "id": page.archetype.id,
                "source_page": page.archetype.source_page,
                "slots": [slot.model_dump() for slot in page.archetype.slots],
                "static_nodes": [node.model_dump() for node in page.archetype.static_nodes],
                "capability_issues": list(page.capability_issues),
                "reconstruction_issues": list(page.reconstruction_issues),
            }
            for page in pages
        ],
        "budget_consumed": budget.consumed_state(),
    }


def _compile_pptx_archetypes(
    data: bytes, pages: list[int], budget: TemplateBudget, *, path: str
) -> tuple[list[_CompiledPage], str]:
    census: dict[int, tuple[str, ...]] = {}
    for page in pages:
        with budget.run_stage(f"census_page_{page}"):
            result = inspect_source_pages(data, path=path, start_page=page, limit=1)
        if result.pages:
            census[page] = result.pages[0].capability_issues

    with budget.run_stage("extract_selected_pptx_pages"):
        extractions = extract_slides(data, path=path, pages=pages)

    compiled: list[_CompiledPage] = []
    for page, extraction in zip(pages, extractions, strict=True):
        slide_id = f"archetype-{page}"
        with budget.run_stage(f"baseline_html_page_{page}"):
            frame_html = baseline_slide_html(extraction, slide_id=slide_id, ratio="16:9")
        # `baseline_slide_html` assigns its own `data-node-id` (e.g.
        # "node-archetype-1-0"), distinct from the extraction's PPTX
        # `element_id` (e.g. "e0") it also stamps as `data-pptx-shape-id` on
        # the same node — recover that mapping here so every Slot/StaticNode
        # `node_id` names the id the frame's DOM (and therefore
        # `instantiate_archetype`'s `_replace_text`) actually targets.
        node_id_by_shape_id = {
            node.attrs["data-pptx-shape-id"]: node.attrs["data-node-id"]
            for node in _Markup(frame_html).nodes
            if node.attrs.get("data-pptx-shape-id") and node.attrs.get("data-node-id")
        }
        slots = [
            Slot(
                key=f"slot-{run.element_id}",
                node_id=node_id_by_shape_id.get(run.element_id, run.element_id),
                node_type="text",
                role="title" if index == 0 else "body",
                required=True,
                rich_run_count=1,
                observed_lengths={"chars": len(run.text)},
            )
            for index, run in enumerate(extraction.texts)
        ]
        static_nodes = [
            StaticNode(
                node_id=node_id_by_shape_id.get(image.element_id, image.element_id),
                node_type="image",
            )
            for image in extraction.images
        ] + [
            StaticNode(
                node_id=node_id_by_shape_id.get(shape.element_id, shape.element_id),
                node_type="shape",
            )
            for shape in extraction.shapes
        ]
        archetype = Archetype(
            id=slide_id,
            source_page=page,
            frame_html=frame_html,
            style_css="",
            slots=slots,
            static_nodes=static_nodes,
            proof={
                "warnings": extraction.warnings,
                "capability_issues": list(census.get(page, ())),
            },
        )
        compiled.append(
            _CompiledPage(
                archetype=archetype,
                capability_issues=census.get(page, ()),
                reconstruction_issues=[],
            )
        )
    return compiled, "16:9"


def _compile_pdf_archetypes(
    data: bytes,
    pages: list[int],
    budget: TemplateBudget,
    *,
    path: str,
    reconstruct_pdf_page_fn: Callable[[PdfPageSource], tuple[str, list[str]]],
) -> tuple[list[_CompiledPage], str]:
    census: dict[int, tuple[str, ...]] = {}
    for page in pages:
        with budget.run_stage(f"census_page_{page}"):
            result = inspect_source_pages(data, path=path, start_page=page, limit=1)
        if result.pages:
            census[page] = result.pages[0].capability_issues

    with budget.run_stage("extract_selected_pdf_pages"):
        sources = extract_pdf_pages(data, pages, budget=budget)

    compiled: list[_CompiledPage] = []
    ratio = "16:9"
    for source in sources:
        with budget.run_stage(f"reconstruct_pdf_page_{source.number}"):
            frame_html, issues = reconstruct_pdf_page_fn(source)
        slide_id = f"archetype-{source.number}"
        slots = [
            Slot(
                key=f"slot-text-{index}",
                node_id=f"text-{index}",
                node_type="text",
                role="title" if index == 0 else "body",
                required=True,
                rich_run_count=1,
                observed_lengths={"chars": len(text.get("text", ""))},
            )
            for index, text in enumerate(source.texts)
        ]
        static_nodes = [
            StaticNode(node_id=f"image-{index}", node_type="image")
            for index in range(len(source.image_boxes))
        ]
        archetype = Archetype(
            id=slide_id,
            source_page=source.number,
            frame_html=frame_html,
            style_css="",
            slots=slots,
            static_nodes=static_nodes,
            proof={
                "reconstruction_issues": issues,
                "capability_issues": list(census.get(source.number, ())),
            },
        )
        compiled.append(
            _CompiledPage(
                archetype=archetype,
                capability_issues=census.get(source.number, ()),
                reconstruction_issues=issues,
            )
        )
        ratio_fraction = source.width / source.height
        ratio = f"{round(ratio_fraction * 9)}:9" if ratio_fraction else ratio
    return compiled, ratio


def finalize_template(
    request: FinalizeRequest,
    *,
    store: CanvasStore,
    canvas_id: str,
    current_source_sha256: str,
    budget: TemplateBudget | None = None,
) -> dict[str, Any]:
    """Validate ``request.bindings`` against a trusted candidate and write ``ready``.

    ``current_source_sha256`` is the caller's freshly-read source hash at
    finalize start; a mismatch against the candidate's pinned source hash is
    ``stale_source``. Every text/image node across every archetype must
    appear in ``bindings`` exactly once, a variable image binding is
    ``unsupported_template``, and any unresolved native capability issue or
    PDF reconstruction issue blocks ``ready`` — a failed finalize leaves the
    candidate untouched and writes no ready manifest.
    """
    budget = budget or TemplateBudget()
    try:
        with budget.run_stage("read_candidate"):
            candidate = require_trusted_artifact(
                store, canvas_id, request.candidate_ref, expected_status="candidate"
            )
    except TrustError as exc:
        return _error(exc.code, str(exc))
    except Exception as exc:  # noqa: BLE001 - budget boundary
        return _error("resource_budget_exceeded", str(exc))

    if current_source_sha256 != candidate.source.sha256:
        return _error(
            "stale_source",
            f"{candidate.source.path} changed since the candidate was prepared",
        )

    expected_nodes: dict[tuple[str, str], str] = {}
    node_kind: dict[tuple[str, str], str] = {}
    capability_by_archetype: dict[str, tuple[str, ...]] = {}
    reconstruction_by_archetype: dict[str, list[str]] = {}
    for archetype in candidate.archetypes:
        for slot in archetype.slots:
            key = (archetype.id, slot.node_id)
            expected_nodes[key] = "unresolved"
            node_kind[key] = slot.node_type
        for node in archetype.static_nodes:
            key = (archetype.id, node.node_id)
            expected_nodes[key] = "unresolved"
            node_kind[key] = node.node_type
        capability_by_archetype[archetype.id] = tuple(
            archetype.proof.get("capability_issues", [])
        )
        reconstruction_by_archetype[archetype.id] = list(
            archetype.proof.get("reconstruction_issues", [])
        )

    seen_keys: set[tuple[str, str]] = set()
    seen_slot_keys: set[tuple[str, str]] = set()
    for binding in request.bindings:
        key = (binding.archetype_id, binding.node_id)
        if key not in expected_nodes:
            return _error(
                "ambiguous_slots", f"unknown node {binding.node_id!r} in archetype {binding.archetype_id!r}"
            )
        if key in seen_keys:
            return _error(
                "ambiguous_slots", f"duplicate binding for node {binding.node_id!r}"
            )
        seen_keys.add(key)
        if binding.disposition == "variable":
            if node_kind[key] != "text":
                return _error(
                    "unsupported_template",
                    f"node {binding.node_id!r} is a {node_kind[key]}; variable image bindings are unsupported",
                )
            slot_key = (binding.archetype_id, binding.slot_key)
            if slot_key in seen_slot_keys:
                return _error(
                    "ambiguous_slots", f"duplicate slot_key {binding.slot_key!r}"
                )
            seen_slot_keys.add(slot_key)
        expected_nodes[key] = binding.disposition

    missing = [key for key, disposition in expected_nodes.items() if disposition == "unresolved"]
    if missing:
        return _error(
            "ambiguous_slots",
            f"{len(missing)} candidate node(s) have no binding",
            details={"missing_nodes": [f"{a}:{n}" for a, n in missing[:10]]},
        )

    unresolved_capability = {
        archetype_id: issues
        for archetype_id, issues in capability_by_archetype.items()
        if set(issues) & _UNRESOLVED_CAPABILITY_ISSUES
    }
    unresolved_reconstruction = {
        archetype_id: issues for archetype_id, issues in reconstruction_by_archetype.items() if issues
    }
    if unresolved_capability or unresolved_reconstruction:
        return _error(
            "unsupported_template",
            "one or more selected pages have an unresolved native dependency or degraded reconstruction",
            details={
                "capability_issues": {k: list(v) for k, v in unresolved_capability.items()},
                "reconstruction_issues": unresolved_reconstruction,
            },
        )

    ready = candidate.model_copy(update={"status": "ready"})
    payload = ready.model_dump_json()
    if len(payload.encode("utf-8")) > MAX_CANDIDATE_JSON_BYTES:
        return _error(
            "template_capacity_exceeded", f"ready JSON is over the {MAX_CANDIDATE_JSON_BYTES}-byte limit"
        )
    ready_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    path = f"templates/{ready_hash}.template.json"
    try:
        with budget.run_stage("write_ready_template"):
            commit = _create_only_write(
                store, canvas_id, path, payload,
                description=f"finalize ready template from {request.candidate_ref.path}",
            )
    except CanvasStoreError as exc:
        return _error("verification_failed", str(exc))
    except BudgetExceededError as exc:
        return _error("resource_budget_exceeded", str(exc))

    return {
        "status": "ready",
        "template_ref": {"path": path, "revision": commit.revision, "sha256": ready_hash},
        "budget_consumed": budget.consumed_state(),
    }
