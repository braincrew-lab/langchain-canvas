"""U5 verification: recover the writer-origin contract and judge a snapshot.

``verify_template_deck_snapshot`` re-reads three things from store history
alone — never from in-memory state, so it works identically after a
restart:

1. The requested output revision's actual slide markup (the *only* thing
   being graded).
2. The FIRST writer-origin commit for the requested path (actor
   ``deck_template_writer.TEMPLATE_WRITER_ACTOR``) — the immutable original
   request contract. Later edits are compared against *this* contract, not
   whatever the current revision's metadata claims; a contract forged into
   the current revision (different facts, a recomputed hash, a swapped
   ``input_slots``) cannot self-approve, because it is never read.
3. The U2 compiler-origin pinned ``ready`` template, via
   ``deck_templates.require_trusted_artifact`` — through the writer-origin
   contract's own template ref, never the current revision's.

Three proofs are kept separate and never let one override another:

- **Visual fidelity** — full bidirectional DOM correspondence (every
  archetype slot/static node must appear; no extra visible node may
  appear) plus the existing ``deck_editing`` geometry tolerance
  (``_layout_issues``). A structure failure here is never overridden by
  the runtime judge.
- **Content** — ``verbatim`` is an exact string comparison against the
  original ``verbatim_expectations`` (no model call, deterministic).
  ``rewrite`` calls ``judge_content_and_voice`` for an independent,
  typed judgment; the writer model's own ``fact_coverage`` self-report and
  a matching content hash are never treated as evidence.
- **Writing style** — the same judge call's per-role-rule verdict.

Slide identity throughout is the manifest's ``instances`` map, keyed by
``slide_id`` — never list ordinal — so a UI reorder cannot desync proof
from output.
"""

from __future__ import annotations

import html
import re
from typing import Any, Callable

from langchain.chat_models import init_chat_model
from langchain_canvas.deck import DeckParseError, parse_deck
from langchain_canvas.store import CanvasStore, CanvasStoreError
from pydantic import ValidationError

from .deck_editing import _Markup, _layout_issues
from .deck_template_models import (
    Archetype,
    RuntimeJudgeResult,
    StyleRule,
    TemplateBudget,
    TemplateInstance,
    TemplateInstanceRequest,
    TemplateManifest,
)
from .deck_template_prompts import build_judge_prompt, judge_prompt_text
from .deck_template_writer import TEMPLATE_WRITER_ACTOR
from .deck_templates import TrustError, _error, require_trusted_artifact
from .render import measure_slide, viewport_for_ratio

_TAG_RE = re.compile(r"<[^>]+>")

_DEFAULT_JUDGE_MAX_RESPONSE_TOKENS = 2000

# failed > degraded > not_checked > verified — the worst status any single
# instance contributes wins for that dimension across the whole deck.
_STATUS_PRIORITY = {"verified": 0, "not_checked": 1, "degraded": 2, "failed": 3}


def _worse(current: str, candidate: str) -> str:
    return candidate if _STATUS_PRIORITY[candidate] > _STATUS_PRIORITY[current] else current


def _role_rule_key(rule: StyleRule) -> str:
    """The stable id a judge response's ``role_rule_status`` keys against."""
    return f"{rule.role}:{rule.property}"


def _extract_slot_runs(body_html: str, node_id: str) -> list[str]:
    """The actual ordered rich-run texts ``node_id`` currently holds.

    The read counterpart to ``deck_editing._replace_text``'s fill — used so
    verification always judges what the output markup really contains,
    never a self-reported ``SlotContentResult``.
    """
    try:
        node = _Markup(body_html).target(node_id)
    except ValueError:
        return []
    inner = body_html[node.inner : node.close]
    spans = list(re.finditer(r"[^<>]+(?=<|$)", inner))
    spans = [m for m in spans if m.start() == 0 or inner[m.start() - 1] == ">"]
    return [html.unescape(m.group()).strip() for m in spans]


def _allowed_node_ids(archetype: Archetype) -> set[str]:
    return {slot.node_id for slot in archetype.slots} | {
        node.node_id for node in archetype.static_nodes
    }


def _present_node_ids(body_html: str) -> set[str]:
    markup = _Markup(body_html)
    return {
        node.attrs.get("data-node-id")
        for node in markup.nodes
        if node.attrs.get("data-node-id")
    }


def _dom_correspondence_issues(archetype: Archetype, body_html: str) -> list[dict[str, Any]]:
    """Bidirectional check: every allowed node present, no extra node appears.

    Compared against the archetype's full node set (slots + static nodes) —
    before any geometry tolerance is applied, per plan U5 — and static
    (retained) node content must stay byte-identical to the pinned frame.
    """
    allowed = _allowed_node_ids(archetype)
    present = _present_node_ids(body_html)
    issues: list[dict[str, Any]] = []
    for node_id in sorted(allowed - present):
        issues.append(
            {"code": "missing_node", "id": node_id, "message": "Archetype node is missing from the output."}
        )
    for node_id in sorted(present - allowed):
        issues.append(
            {
                "code": "extra_node",
                "id": node_id,
                "message": "An extra node not declared in the archetype template appears in the output.",
            }
        )
    frame_markup = _Markup(archetype.frame_html)
    body_markup = _Markup(body_html)
    for node in archetype.static_nodes:
        try:
            frame_node = frame_markup.target(node.node_id)
            actual_node = body_markup.target(node.node_id)
        except ValueError:
            continue  # already reported as missing above
        frame_inner = archetype.frame_html[frame_node.inner : frame_node.close]
        actual_inner = body_html[actual_node.inner : actual_node.close]
        if frame_inner != actual_inner:
            issues.append(
                {
                    "code": "static_node_changed",
                    "id": node.node_id,
                    "message": "A static/retained node's content changed after publication.",
                }
            )
    return issues


def _asset_and_font_issues(archetype: Archetype, body_html: str) -> list[dict[str, Any]]:
    """Missing pinned assets (fail-worthy) and unknown font evidence (degrade-worthy).

    Both are reported in ``visual_fidelity.issues`` — an unresolved font
    never blocks verification outright (visual is ``degraded``, not
    ``failed``), but it is never silently dropped either.
    """
    issues: list[dict[str, Any]] = []
    for asset in archetype.assets:
        if asset.path not in body_html and asset.sha256 not in body_html:
            issues.append(
                {
                    "code": "missing_asset",
                    "id": asset.path,
                    "message": "Expected pinned asset reference is missing from the output.",
                }
            )
    for role in sorted({rule.role for rule in archetype.writing_style if rule.origin == "unknown"}):
        issues.append(
            {
                "code": "unknown_font_evidence",
                "id": role,
                "message": "Original font could not be confirmed; visual fidelity for this role is degraded.",
            }
        )
    return issues


def _measure_body(body_html: str, style_css: str, ratio: str) -> dict[str, Any]:
    width, height = viewport_for_ratio(ratio)
    document = (
        f"<html><head><style>html,body{{margin:0;width:{width}px;height:{height}px}}"
        f"{style_css}</style></head><body>{body_html}</body></html>"
    )
    return measure_slide(document, ratio=ratio)


def _geometry_issues(archetype: Archetype, body_html: str, ratio: str) -> list[dict[str, Any]] | None:
    """``_layout_issues`` over the current render, or ``None`` if unmeasurable.

    ``None`` means the geometry backend itself is unavailable (not that
    there are zero issues) — the caller treats that as a degrade, never a
    silent pass.
    """
    try:
        layout = _measure_body(body_html, archetype.style_css, ratio)
    except Exception:  # noqa: BLE001 - rendering boundary; caller degrades, never crashes
        return None
    return _layout_issues(layout)


def _verbatim_content_issues(
    instance: TemplateInstance, actual_slots: dict[str, list[str]]
) -> list[dict[str, Any]]:
    """Exact comparison against the original ``verbatim_expectations`` — no model call."""
    expected = instance.request.verbatim_expectations or {}
    issues: list[dict[str, Any]] = []
    for slot_key, expected_runs in expected.items():
        if actual_slots.get(slot_key, []) != expected_runs:
            issues.append(
                {
                    "code": "verbatim_mismatch",
                    "id": slot_key,
                    "message": "Output text no longer matches the original verbatim request.",
                }
            )
    return issues


def _invoke_judge_model(judge_model: str, messages: list[dict[str, str]]) -> RuntimeJudgeResult:
    model = init_chat_model(judge_model)
    structured = model.with_structured_output(RuntimeJudgeResult)
    return structured.invoke(messages)


def judge_content_and_voice(
    request: TemplateInstanceRequest,
    writing_style: list[StyleRule],
    output_slots: dict[str, list[str]],
    *,
    judge_model: str,
    budget: TemplateBudget,
    invoke_model: Callable[[str, list[dict[str, str]]], RuntimeJudgeResult] = _invoke_judge_model,
) -> RuntimeJudgeResult | None:
    """One independent judge call over the actual output text alone.

    Draws from the shared ``budget`` (first attempt plus at most one
    malformed-transport retry, per plan U5). Returns ``None`` on an
    unavailable transport or a malformed response after retries — the
    caller reports that dimension ``not_checked``, never ``failed``, since
    the judge itself rendered no verdict.
    """
    messages = build_judge_prompt(request, writing_style, output_slots)
    prompt_text = judge_prompt_text(request, writing_style, output_slots)
    attempts = 0
    while attempts <= 1:
        try:
            budget.reserve_model_call(
                prompt_text=prompt_text, max_response_tokens=_DEFAULT_JUDGE_MAX_RESPONSE_TOKENS
            )
        except Exception:  # noqa: BLE001 - budget exhaustion; caller treats as not_checked
            return None
        try:
            return invoke_model(judge_model, messages)
        except Exception:  # noqa: BLE001 - malformed/unavailable judge transport boundary
            attempts += 1
    return None


def _evaluate_judge_result(
    judge: RuntimeJudgeResult, required_fact_ids: set[str]
) -> tuple[str, list[dict[str, Any]], str, list[dict[str, Any]]]:
    """Reduce one judge response into (content_status, content_issues, style_status, style_issues).

    Missing/unsupported/contradictory findings fail their dimension;
    ambiguous or uncovered findings mark it ``not_checked`` instead —
    never silently ``verified``. Harmless connective phrases never appear
    here because the judge prompt asks it to skip them, not because this
    reducer filters anything out.
    """
    content_issues: list[dict[str, Any]] = []
    style_issues: list[dict[str, Any]] = []
    content_failed = content_ambiguous = False
    style_failed = style_ambiguous = False

    for fact_id in required_fact_ids:
        status = judge.fact_status.get(fact_id, "ambiguous")
        if status == "missing":
            content_failed = True
            content_issues.append(
                {"code": "fact_missing", "id": fact_id, "message": "Required fact is missing from the output."}
            )
        elif status == "ambiguous":
            content_ambiguous = True
            content_issues.append(
                {
                    "code": "fact_ambiguous",
                    "id": fact_id,
                    "message": "Judge could not confirm this fact's preservation.",
                }
            )

    for claim in judge.claims:
        if claim.status in ("unsupported", "contradictory"):
            content_failed = True
            content_issues.append(
                {
                    "code": f"claim_{claim.status}",
                    "id": claim.slot_key,
                    "message": "Output asserts a claim not grounded in the original facts/input slots.",
                }
            )
        elif claim.status == "ambiguous":
            content_ambiguous = True
            content_issues.append(
                {"code": "claim_ambiguous", "id": claim.slot_key, "message": "Judge could not classify this claim."}
            )

    for rule_key, status in judge.role_rule_status.items():
        if status == "fail":
            style_failed = True
            style_issues.append(
                {"code": "style_rule_failed", "id": rule_key, "message": "Output violates an observed writing-style rule."}
            )
        elif status == "ambiguous":
            style_ambiguous = True
            style_issues.append(
                {"code": "style_rule_ambiguous", "id": rule_key, "message": "Judge could not confirm this style rule."}
            )

    content_status = "failed" if content_failed else ("not_checked" if content_ambiguous else "verified")
    style_status = "failed" if style_failed else ("not_checked" if style_ambiguous else "verified")
    return content_status, content_issues, style_status, style_issues


def _find_original_writer_commit(store: CanvasStore, canvas_id: str, path: str):
    """The FIRST (oldest) writer-origin commit that touched ``path``.

    ``store.history`` returns newest-first, so the oldest matching commit
    is the last one in the filtered list.
    """
    commits = store.history(canvas_id)
    matching = [
        commit
        for commit in commits
        if commit.actor == TEMPLATE_WRITER_ACTOR and path in commit.paths
    ]
    return matching[-1] if matching else None


def verify_template_deck_snapshot(
    path: str,
    revision: str | None,
    *,
    store: CanvasStore,
    canvas_id: str,
    judge_model: str,
    budget: TemplateBudget | None = None,
    invoke_judge: Callable[[str, list[dict[str, str]]], RuntimeJudgeResult] = _invoke_judge_model,
) -> dict[str, Any]:
    """Verify one deck snapshot's visual/content/writing-style proofs.

    Reads everything fresh from ``store`` — the requested revision's actual
    slides, the FIRST writer-origin commit for ``path`` (the immutable
    original contract), and the pinned ready template that contract names
    — so this works identically after a process restart. ``revision=None``
    reads the current head.
    """
    budget = budget or TemplateBudget()
    try:
        current = store.read(canvas_id, path, revision=revision)
    except CanvasStoreError as exc:
        return _error("verification_failed", str(exc))
    try:
        deck = parse_deck(current.content)
    except DeckParseError as exc:
        return _error("verification_failed", str(exc))

    original_commit = _find_original_writer_commit(store, canvas_id, path)
    if original_commit is None:
        return _error("verification_failed", f"no writer-origin commit found for {path}")
    try:
        original_content = store.read(canvas_id, path, revision=original_commit.revision)
        original_deck = parse_deck(original_content.content)
    except (CanvasStoreError, DeckParseError) as exc:
        return _error("verification_failed", str(exc))
    if original_deck.template is None:
        return _error(
            "verification_failed",
            f"writer-origin commit {original_commit.revision} has no template metadata",
        )
    try:
        original_manifest = TemplateManifest.model_validate(original_deck.template)
    except ValidationError as exc:
        return _error("verification_failed", str(exc))

    try:
        ready_manifest = require_trusted_artifact(
            store, canvas_id, original_manifest.template, expected_status="ready"
        )
    except TrustError as exc:
        return _error(exc.code, str(exc))

    archetypes_by_id = {archetype.id: archetype for archetype in ready_manifest.archetypes}
    slides_by_id = {slide.slide_id: slide for slide in deck.slides}

    checked_slide_ids: list[str] = []
    warnings: list[str] = []
    visual_status = content_status = style_status = "verified"
    visual_issues: list[dict[str, Any]] = []
    content_issues: list[dict[str, Any]] = []
    style_issues: list[dict[str, Any]] = []

    for slide_id, instance in original_manifest.instances.items():
        checked_slide_ids.append(slide_id)
        slide = slides_by_id.get(slide_id)
        if slide is None:
            visual_status = _worse(visual_status, "not_checked")
            content_status = _worse(content_status, "not_checked")
            style_status = _worse(style_status, "not_checked")
            warnings.append(f"{slide_id}: output slide is missing from {path}@{current.revision}")
            continue
        archetype = archetypes_by_id.get(instance.archetype_id)
        if archetype is None:
            visual_status = _worse(visual_status, "not_checked")
            content_status = _worse(content_status, "not_checked")
            style_status = _worse(style_status, "not_checked")
            warnings.append(
                f"{slide_id}: archetype {instance.archetype_id!r} not found on the pinned template"
            )
            continue

        dom_issues = _dom_correspondence_issues(archetype, slide.body_html)
        asset_font_issues = _asset_and_font_issues(archetype, slide.body_html)
        geometry_issues = _geometry_issues(archetype, slide.body_html, ready_manifest.ratio)
        has_missing_asset = any(issue["code"] == "missing_asset" for issue in asset_font_issues)
        has_unknown_font = any(issue["code"] == "unknown_font_evidence" for issue in asset_font_issues)

        instance_visual_issues = [
            {**issue, "slide_id": slide_id}
            for issue in dom_issues + asset_font_issues + (geometry_issues or [])
        ]
        visual_issues.extend(instance_visual_issues)
        if dom_issues or has_missing_asset or geometry_issues:
            visual_status = _worse(visual_status, "failed")
        elif geometry_issues is None or has_unknown_font:
            visual_status = _worse(visual_status, "degraded")

        slot_node_ids = {slot.key: slot.node_id for slot in archetype.slots}
        actual_slots = {
            key: _extract_slot_runs(slide.body_html, node_id)
            for key, node_id in slot_node_ids.items()
            if key in instance.request.input_slots
        }

        if instance.request.mode == "verbatim":
            # Verbatim copies the original wording through unchanged — there is
            # no new authored voice to judge. Per plan U5 this is reported
            # not_checked (a voice claim was never evaluated for this
            # instance), never verified — a prior version left style_status
            # untouched here, which vacuously stayed "verified" for a
            # dimension nothing ever graded.
            mismatch_issues = _verbatim_content_issues(instance, actual_slots)
            content_issues.extend({**issue, "slide_id": slide_id} for issue in mismatch_issues)
            if mismatch_issues:
                content_status = _worse(content_status, "failed")
            style_status = _worse(style_status, "not_checked")
            continue

        if not instance.request.input_slots:
            content_status = _worse(content_status, "not_checked")
            style_status = _worse(style_status, "not_checked")
            warnings.append(f"{slide_id}: no original input slots recorded; content cannot be verified")
            continue

        requested_roles = {
            slot.role for slot in archetype.slots if slot.key in instance.request.input_slots
        }
        writing_style = [rule for rule in archetype.writing_style if rule.role in requested_roles]
        judge = judge_content_and_voice(
            instance.request, writing_style, actual_slots,
            judge_model=judge_model, budget=budget, invoke_model=invoke_judge,
        )
        if judge is None:
            content_status = _worse(content_status, "not_checked")
            style_status = _worse(style_status, "not_checked")
            warnings.append(f"{slide_id}: runtime judge unavailable or returned a malformed response")
            continue

        required_fact_ids = {fact.id for fact in instance.request.required_facts}
        (
            instance_content_status,
            instance_content_issues,
            instance_style_status,
            instance_style_issues,
        ) = _evaluate_judge_result(judge, required_fact_ids)
        if not writing_style:
            # No observed style rule applied to this instance's roles at all
            # (either the archetype's writing_style is empty — see the
            # `_profile_writing_style` fix — or none matched the requested
            # roles). `_evaluate_judge_result` reduces zero rules to
            # "verified" by construction (nothing failed or was ambiguous),
            # which is vacuous, not a real pass — force not_checked instead.
            instance_style_status = "not_checked"
        content_status = _worse(content_status, instance_content_status)
        style_status = _worse(style_status, instance_style_status)
        content_issues.extend({**issue, "slide_id": slide_id} for issue in instance_content_issues)
        style_issues.extend({**issue, "slide_id": slide_id} for issue in instance_style_issues)

    complete = visual_status == "verified" and content_status == "verified" and style_status == "verified"
    issues = visual_issues + content_issues + style_issues
    return {
        "complete": complete,
        "output_revision": current.revision,
        "template_ref": original_manifest.template.model_dump(),
        "checked_slide_ids": checked_slide_ids,
        "visual_fidelity": {"status": visual_status, "issues": visual_issues},
        "content": {"status": content_status, "issues": content_issues},
        "writing_style": {"status": style_status, "issues": style_issues},
        "issues": issues,
        "warnings": warnings,
    }
