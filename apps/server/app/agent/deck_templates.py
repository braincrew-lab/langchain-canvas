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

import base64
import hashlib
import re
from dataclasses import dataclass
from typing import Any, Callable

from langchain.chat_models import init_chat_model
from langchain_canvas.deck._shapes import PptxImportError
from langchain_canvas.deck.baseline import baseline_slide_html
from langchain_canvas.deck.extract import extract_slides
from langchain_canvas.deck.source_inventory import (
    OversizedPageError,
    PageInventory,
    SourceInventoryError,
    inspect_source_pages,
)
from langchain_canvas.store import (
    CanvasFileNotFoundError,
    CanvasStore,
    CanvasStoreError,
    Commit,
)

from .configuration import config
from .deck_editing import _Markup, _attrs
from .deck_template_models import (
    MAX_CANDIDATE_JSON_BYTES,
    Archetype,
    ArtifactRef,
    AssetRef,
    BudgetExceededError,
    CompiledTemplateManifest,
    FinalizeRequest,
    NodeBinding,
    OmitBinding,
    PrepareRequest,
    RetainBinding,
    Slot,
    SourceRef,
    StaticNode,
    StyleProfileResponse,
    StyleRule,
    TemplateBudget,
    VariableBinding,
)
from .deck_template_prompts import (
    RoleExample,
    build_style_profile_prompt,
    style_profile_prompt_text,
)
from .pdf_deck import reconstruct_pdf_page
from .pdf_source import PdfPageSource, extract_pdf_pages

_TAG_RE = re.compile(r"<[^>]+>")

# The one actor pinned template image assets are written under (task 3's
# ticket #4 fix) — distinct from source uploads, so a pinned asset's own
# content-addressed path can never collide with `sources/` or `exports/`.
_TEMPLATE_ASSET_PREFIX = "templates/assets"

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
) -> Commit:
    """Write ``path`` only if it does not already exist (idempotent by hash).

    ``CanvasStore.write`` has no native create-only mode; this wraps it with
    a read-first check. The path is content-addressed
    (``templates/<hash>.{candidate,template}.json``), so a pre-existing file
    at the same path is expected to already hold byte-identical content from
    a prior compiler run — this returns the *actual historical commit* that
    wrote it (verified via ``store.history``, never the head's own ``read``
    result, which is a ``FileContent``, not a ``Commit``).

    If the path is occupied by bytes this compiler never wrote (a
    pre-planted human/agent file at the deterministic content-addressed
    path — the same attack ``require_trusted_artifact`` guards against on
    read), that content is never adopted as if it were trusted compiler
    output. Since the path is derived from a hash of the *exact* payload
    this call is about to write, refusing outright would let one pre-planted
    file permanently block templating for this exact candidate/ready
    payload (a same-canvas DoS) — so this instead writes a fresh
    compiler-authored commit that overwrites the squatted content. The
    returned ``Commit`` names that specific new revision, and
    ``require_trusted_artifact`` only ever trusts the exact revision named
    in a caller's ``ArtifactRef`` — never "whatever is at this path now" —
    so the squatted revision (if it remains reachable in history) is never
    read back as if it were this compiler's output.
    """
    try:
        store.read(canvas_id, path)
    except CanvasFileNotFoundError:
        return store.write(canvas_id, path, content, description, actor=TEMPLATE_COMPILER_ACTOR)

    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    for commit in store.history(canvas_id):
        if path not in commit.paths or commit.actor != TEMPLATE_COMPILER_ACTOR:
            continue
        try:
            historical = store.read(canvas_id, path, revision=commit.revision)
        except CanvasFileNotFoundError:
            continue
        if hashlib.sha256(historical.content.encode("utf-8")).hexdigest() == content_hash:
            return commit

    return store.write(canvas_id, path, content, description, actor=TEMPLATE_COMPILER_ACTOR)


def _create_only_write_bytes(
    store: CanvasStore, canvas_id: str, path: str, data: bytes, *, description: str
) -> Commit:
    """The :func:`_create_only_write` bytes counterpart, for pinned image assets."""
    try:
        store.read_bytes(canvas_id, path)
    except CanvasFileNotFoundError:
        return store.write_bytes(
            canvas_id, path, data, description, actor=TEMPLATE_COMPILER_ACTOR
        )

    content_hash = hashlib.sha256(data).hexdigest()
    for commit in store.history(canvas_id):
        if path not in commit.paths or commit.actor != TEMPLATE_COMPILER_ACTOR:
            continue
        try:
            historical = store.read_bytes(canvas_id, path, revision=commit.revision)
        except CanvasFileNotFoundError:
            continue
        if hashlib.sha256(historical.data).hexdigest() == content_hash:
            return commit

    return store.write_bytes(canvas_id, path, data, description, actor=TEMPLATE_COMPILER_ACTOR)


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


def _source_to_frame_status(
    archetype: Archetype, *, reconstruction_issues: list[str]
) -> dict[str, Any]:
    """Real per-archetype ``proof.source_to_frame`` correspondence proof (plan U2).

    A non-empty ``reconstruction_issues`` (the PDF degraded-reconstruction
    signal) always fails the page outright. For a PPTX page, the
    pre-extraction census's own text-object count (stashed on
    ``archetype.proof['source_object_counts']`` at ``prepare`` time — see
    ``_compile_pptx_archetypes``) is compared against how many text nodes
    the *materialized* archetype actually covers: a census-counted business
    text object that ``extract_slides`` silently dropped (never became a
    slot or a static node at all) is a real correspondence gap no binding
    coverage check alone can catch, since that check only ever sees the
    nodes the candidate already has. A PDF page (or a PPTX page whose
    census result is unavailable) carries no such count and is ``checked``
    once its reconstruction is clean — there is no per-object source
    signal to compare against a fully rewritten HTML page.
    """
    if reconstruction_issues:
        return {
            "status": "failed",
            "reason": "degraded_reconstruction",
            "issues": list(reconstruction_issues),
        }
    source_counts = archetype.proof.get("source_object_counts")
    if source_counts is None:
        return {"status": "checked"}
    expected_text = int(source_counts.get("text", 0))
    covered_text = len([slot for slot in archetype.slots if slot.node_type == "text"]) + len(
        [node for node in archetype.static_nodes if node.node_type == "text"]
    )
    if covered_text < expected_text:
        return {
            "status": "failed",
            "reason": "unclassified_business_text",
            "expected_text_objects": expected_text,
            "covered_text_objects": covered_text,
        }
    return {"status": "checked"}


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
                source_bytes, request.pages, budget, path=request.source,
                store=store, canvas_id=canvas_id,
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


def _pin_pptx_image_asset(
    store: CanvasStore, canvas_id: str, data: bytes, ext: str
) -> dict[str, str]:
    """Content-address, create-only pin ``data`` under :data:`_TEMPLATE_ASSET_PREFIX`.

    Runs at ``prepare`` time — before any disposition is known — because
    ``finalize_template`` never re-extracts the source (a candidate is
    reused byte-for-byte, see ``test_finalize_reuses_candidate_without_reconversion``),
    so this is the only point at which the original image bytes are still
    available to pin. The returned mapping is stashed on the archetype's own
    ``proof`` dict (see ``_compile_pptx_archetypes``) so a later ``finalize``
    call can recover it — for a ``retain`` disposition only — without
    touching the source file again.
    """
    sha256 = hashlib.sha256(data).hexdigest()
    path = f"{_TEMPLATE_ASSET_PREFIX}/{sha256}.{ext}"
    commit = _create_only_write_bytes(
        store, canvas_id, path, data, description="pin candidate template image asset"
    )
    return {"path": path, "revision": commit.revision, "sha256": sha256}


def _compile_pptx_archetypes(
    data: bytes,
    pages: list[int],
    budget: TemplateBudget,
    *,
    path: str,
    store: CanvasStore,
    canvas_id: str,
) -> tuple[list[_CompiledPage], str]:
    census: dict[int, PageInventory] = {}
    for page in pages:
        with budget.run_stage(f"census_page_{page}"):
            result = inspect_source_pages(data, path=path, start_page=page, limit=1)
        if result.pages:
            census[page] = result.pages[0]

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
        image_asset_refs: dict[str, dict[str, str]] = {}
        image_static_nodes: list[StaticNode] = []
        for image in extraction.images:
            node_id = node_id_by_shape_id.get(image.element_id, image.element_id)
            image_static_nodes.append(StaticNode(node_id=node_id, node_type="image"))
            with budget.run_stage(f"pin_image_asset_{slide_id}_{image.element_id}"):
                image_asset_refs[node_id] = _pin_pptx_image_asset(
                    store, canvas_id, image.data, image.ext
                )
        static_nodes = image_static_nodes + [
            StaticNode(
                node_id=node_id_by_shape_id.get(shape.element_id, shape.element_id),
                node_type="shape",
            )
            for shape in extraction.shapes
        ]
        inventory = census.get(page)
        archetype = Archetype(
            id=slide_id,
            source_page=page,
            frame_html=frame_html,
            style_css="",
            slots=slots,
            static_nodes=static_nodes,
            proof={
                "warnings": extraction.warnings,
                "capability_issues": list(inventory.capability_issues) if inventory else [],
                "source_object_counts": dict(inventory.object_kind_counts) if inventory else {},
                "candidate_asset_refs": image_asset_refs,
            },
        )
        compiled.append(
            _CompiledPage(
                archetype=archetype,
                capability_issues=inventory.capability_issues if inventory else (),
                reconstruction_issues=[],
            )
        )
    return compiled, "16:9"


def _pdf_node_ids(frame_html: str) -> tuple[list[str], list[str]]:
    """The actual ``data-node-id`` values a reconstructed PDF frame assigned.

    ``reconstruct_pdf_page`` asks the writer model to invent its own node
    ids per ``PDF_WRITER_SYSTEM``'s "unique data-node-id" instruction —
    never the ``text-{i}``/``image-{i}`` synthesized ids a prior version of
    this compiler assumed. Parses the compiled markup itself, in document
    order, so every returned id names a real DOM target. The v1 PDF compile
    path recognizes exactly two node kinds (mirroring ``_compile_pdf_archetypes``'s
    own slot/static-node split): any ``<img>`` carrying ``data-node-id`` is
    an image node; every other element carrying ``data-node-id`` is a text
    node — real writer output additionally marks these
    ``data-text-block="true"``/``data-text-role="..."``, but that marker is
    not required to classify them, only their tag and the presence of an id.
    """
    text_ids: list[str] = []
    image_ids: list[str] = []
    for node in _Markup(frame_html).nodes:
        node_id = node.attrs.get("data-node-id")
        if not node_id:
            continue
        if node.tag == "img":
            image_ids.append(node_id)
        else:
            text_ids.append(node_id)
    return text_ids, image_ids


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
        issues = list(issues)
        text_node_ids, image_node_ids = _pdf_node_ids(frame_html)
        if len(text_node_ids) != len(source.texts) or len(image_node_ids) != len(
            source.image_boxes
        ):
            issues.append(
                "reconstructed frame's node count does not match the source census "
                f"({len(text_node_ids)} text / {len(image_node_ids)} node(s) vs "
                f"{len(source.texts)} text / {len(source.image_boxes)} object(s))"
            )
        slots = [
            Slot(
                key=f"slot-text-{index}",
                node_id=node_id,
                node_type="text",
                role="title" if index == 0 else "body",
                required=True,
                rich_run_count=1,
                observed_lengths={"chars": len(text.get("text", ""))},
            )
            for index, (node_id, text) in enumerate(zip(text_node_ids, source.texts))
        ]
        static_nodes = [
            StaticNode(node_id=node_id, node_type="image") for node_id in image_node_ids
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


def _remove_node(body: str, node_id: str) -> str:
    """Delete ``node_id``'s whole element (open tag through its close) from ``body``."""
    node = _Markup(body).target(node_id)
    return body[: node.start] + body[node.end :]


def _apply_bindings_to_archetype(
    archetype: Archetype, bindings: list[NodeBinding]
) -> Archetype:
    """Materialize one archetype's ``ready`` shape from its validated dispositions.

    Previously ``finalize_template`` discarded every binding's own
    disposition and copied the candidate through unchanged
    (``candidate.model_copy(update={"status": "ready"})``), so every
    candidate slot was treated as a required variable slot regardless of
    what the caller actually bound it to. This instead reads each
    binding: a ``variable`` node becomes a writer-fillable :class:`Slot`
    named by the binding's own ``slot_key``/``role``/``required``; a
    ``retain`` node becomes a :class:`StaticNode` recording its
    ``retain_reason`` (its text stays byte-identical — the writer's
    ``instantiate_archetype`` only ever calls ``_replace_text`` on slot
    node ids); an ``omit`` node is dropped from both the slot/static lists
    and the frame markup itself, so it can never leak into a written deck.
    """
    slots_by_node = {slot.node_id: slot for slot in archetype.slots}
    static_by_node = {node.node_id: node for node in archetype.static_nodes}

    new_slots: list[Slot] = []
    new_static: list[StaticNode] = []
    frame_html = archetype.frame_html

    for binding in bindings:
        if binding.archetype_id != archetype.id:
            continue
        if isinstance(binding, VariableBinding):
            source_slot = slots_by_node[binding.node_id]
            new_slots.append(
                source_slot.model_copy(
                    update={
                        "key": binding.slot_key,
                        "role": binding.role,
                        "required": binding.required,
                        "disposition": "variable",
                    }
                )
            )
        elif isinstance(binding, RetainBinding):
            if binding.node_id in slots_by_node:
                source_slot = slots_by_node[binding.node_id]
                new_static.append(
                    StaticNode(
                        node_id=binding.node_id,
                        node_type=source_slot.node_type,
                        disposition="retain",
                        retain_reason=binding.retain_reason,
                    )
                )
            else:
                source_node = static_by_node[binding.node_id]
                new_static.append(
                    source_node.model_copy(
                        update={"disposition": "retain", "retain_reason": binding.retain_reason}
                    )
                )
        elif isinstance(binding, OmitBinding):
            frame_html = _remove_node(frame_html, binding.node_id)

    return archetype.model_copy(
        update={"frame_html": frame_html, "slots": new_slots, "static_nodes": new_static}
    )


def _embed_retained_pptx_assets(
    archetype: Archetype,
    original_asset_refs: dict[str, Any],
    *,
    store: CanvasStore,
    canvas_id: str,
) -> Archetype:
    """Embed each retained PPTX image node's pinned bytes as a ``data:`` URI.

    ``original_asset_refs`` is the candidate-time
    ``proof['candidate_asset_refs']`` map (see ``_pin_pptx_image_asset``),
    keyed by node id — the only point the original image bytes were still
    available, since ``finalize_template`` never re-extracts the source. A
    retained image node is read back through that pinned, content-addressed
    reference, embedded so the ready frame is self-contained, and its hash
    is stamped onto the node via ``data-lcx-asset-sha256`` — so
    ``deck_template_verification.py``'s pinned-asset check can detect a
    later overwrite even though the sha256 no longer appears in a bare
    store path. A PDF archetype (or any node absent from
    ``original_asset_refs``) is left untouched — this is a PPTX-only fix
    per the ticket's evidence.
    """
    frame_html = archetype.frame_html
    assets: list[AssetRef] = []
    for node in archetype.static_nodes:
        if node.node_type != "image" or node.disposition != "retain":
            continue
        ref = original_asset_refs.get(node.node_id)
        if not ref:
            continue
        data = store.read_bytes(canvas_id, ref["path"], revision=ref["revision"]).data
        ext = ref["path"].rsplit(".", 1)[-1]
        mime = "image/png" if ext == "png" else f"image/{ext}"
        data_uri = f"data:{mime};base64,{base64.b64encode(data).decode()}"
        frame_html = _attrs(
            frame_html,
            node.node_id,
            {"src": data_uri, "data-lcx-asset-sha256": ref["sha256"]},
        )
        assets.append(AssetRef(path=ref["path"], revision=ref["revision"], sha256=ref["sha256"]))
    return archetype.model_copy(update={"frame_html": frame_html, "assets": assets})


def _slot_text(frame_html: str, node_id: str) -> str:
    """The plain text a bound slot node currently holds, tags stripped."""
    try:
        node = _Markup(frame_html).target(node_id)
    except ValueError:
        return ""
    inner = frame_html[node.inner : node.close]
    return _TAG_RE.sub("", inner).strip()


def _invoke_style_profile_model(
    writer_model: str, messages: list[dict[str, str]]
) -> StyleProfileResponse:
    model = init_chat_model(writer_model)
    structured = model.with_structured_output(StyleProfileResponse)
    return structured.invoke(messages)


def _profile_writing_style(
    archetype: Archetype,
    *,
    writer_model: str,
    budget: TemplateBudget,
    invoke_model: Callable[[str, list[dict[str, str]]], StyleProfileResponse] | None = None,
) -> list[StyleRule]:
    """Observe writing style from this archetype's own bound text — ticket #1 fix.

    Previously ``Archetype.writing_style`` was never populated on any code
    path (``build_style_profile_prompt``/``style_profile_prompt_text`` had
    zero callers), so the writer's ``_writing_style_for_request`` always
    saw ``[]`` and the runtime judge always saw "(no observed style rules)".
    This draws only the finalized variable slots' current frame text plus
    role — never the source file, the whole deck, or the candidate's full
    HTML (plan U2's isolation requirement) — reserves the call against
    ``budget`` first, and treats a budget exhaustion or a
    malformed/unavailable model response as a soft failure: the archetype's
    style rules stay ``[]`` rather than aborting finalize. The caller never
    claims an empty rule set was successfully verified — see
    ``deck_template_verification.py``'s writing_style ``not_checked`` path,
    fixed alongside this so a verbatim instance or an instance with zero
    observed rules is never reported ``verified`` by omission.
    """
    examples = [
        RoleExample(role=slot.role, page=archetype.source_page, text=text)
        for slot in archetype.slots
        if slot.node_type == "text"
        for text in [_slot_text(archetype.frame_html, slot.node_id)]
        if text
    ]
    if not examples:
        return []
    messages = build_style_profile_prompt(examples)
    prompt_text = style_profile_prompt_text(examples)
    try:
        budget.reserve_model_call(prompt_text=prompt_text, max_response_tokens=1500)
    except BudgetExceededError:
        return []
    # Resolved inside the body (not a bound default parameter) so tests can
    # monkeypatch the module-level `_invoke_style_profile_model` symbol.
    invoke = invoke_model or _invoke_style_profile_model
    try:
        response = invoke(writer_model, messages)
    except Exception:  # noqa: BLE001 - style profiling is best-effort, never blocking
        return []
    return list(response.rules)


def finalize_template(
    request: FinalizeRequest,
    *,
    store: CanvasStore,
    canvas_id: str,
    current_source_sha256: str,
    budget: TemplateBudget | None = None,
    writer_model: str | None = None,
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

    try:
        materialized: list[Archetype] = []
        source_to_frame_by_archetype: dict[str, dict[str, Any]] = {}
        for archetype in candidate.archetypes:
            with budget.run_stage(f"materialize_archetype_{archetype.id}"):
                # Evaluated against the *candidate* archetype's own
                # slot/static-node coverage, before any binding is applied —
                # an intentional `omit` disposition legitimately drops a
                # census-counted object from the materialized ready shape,
                # and must never be confused with extraction silently
                # dropping it before any binding ever saw it.
                status = _source_to_frame_status(
                    archetype,
                    reconstruction_issues=reconstruction_by_archetype.get(archetype.id, []),
                )
                bound = _apply_bindings_to_archetype(archetype, request.bindings)
                original_refs = archetype.proof.get("candidate_asset_refs", {})
                with_assets = _embed_retained_pptx_assets(
                    bound, original_refs, store=store, canvas_id=canvas_id
                )
            source_to_frame_by_archetype[archetype.id] = status
            materialized.append(
                with_assets.model_copy(
                    update={"proof": {**with_assets.proof, "source_to_frame": status}}
                )
            )
    except BudgetExceededError as exc:
        return _error("resource_budget_exceeded", str(exc))

    failed_correspondence = {
        archetype_id: status
        for archetype_id, status in source_to_frame_by_archetype.items()
        if status["status"] != "checked"
    }
    if failed_correspondence:
        return _error(
            "unsupported_template",
            "one or more pages failed source-to-frame correspondence",
            details={"source_to_frame": failed_correspondence},
        )

    # Writing-style profiling is best-effort and never a hard gate: a budget
    # exhaustion or a malformed/unavailable model response leaves an
    # archetype's rules empty rather than aborting finalize (see
    # `_profile_writing_style`'s own soft-failure handling).
    resolved_writer_model = writer_model or config.writer_model
    styled = [
        archetype.model_copy(
            update={
                "writing_style": _profile_writing_style(
                    archetype, writer_model=resolved_writer_model, budget=budget
                )
            }
        )
        for archetype in materialized
    ]

    ready = candidate.model_copy(update={"status": "ready", "archetypes": styled})
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
