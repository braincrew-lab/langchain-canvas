"""U5 verification: writer-origin contract recovery, full DOM correspondence,
and a typed runtime judge separating visual/content/writing-style proofs
over a single output snapshot (task 5).

``verify_template_deck_snapshot`` re-reads, from store history alone (no
in-memory state), the FIRST writer-origin commit for the requested path —
never the current revision's possibly-edited metadata — and the pinned
compiler-origin ready template. Structure/content hard gates never get
overridden by the runtime judge.
"""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

from app.agent.deck_template_models import (
    Archetype,
    ArtifactRef,
    AssetRef,
    CompiledTemplateManifest,
    Fact,
    RuntimeJudgeResult,
    SlideContentRequest,
    SourceRef,
    StyleEvidence,
    StyleRule,
    TemplateBudget,
)
from app.agent.deck_template_verification import verify_template_deck_snapshot
from app.agent.deck_template_writer import TEMPLATE_WRITER_ACTOR, write_deck_from_template
from app.agent.deck_templates import TEMPLATE_COMPILER_ACTOR
from langchain_canvas.deck import Deck, SlideTemplate, parse_deck, reorder_slides, serialize_deck
from langchain_canvas.store import InMemoryCanvasStore


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(stream_writer=None)


def _single_slot_archetype(
    archetype_id: str,
    source_page: int,
    *,
    node_id: str | None = None,
    body_text: str = "Old body text",
    writing_style: list[StyleRule] | None = None,
    static_nodes: list | None = None,
    assets: list | None = None,
    extra_static_html: str = "",
) -> Archetype:
    node_id = node_id or f"node-{archetype_id}"
    frame_html = (
        f'<section class="slide"><p data-node-id="{node_id}">{body_text}</p>'
        f"{extra_static_html}</section>"
    )
    return Archetype(
        id=archetype_id,
        source_page=source_page,
        frame_html=frame_html,
        style_css="",
        slots=[
            {
                "key": "body",
                "node_id": node_id,
                "node_type": "text",
                "role": "body",
                "required": True,
                "rich_run_count": 1,
            }
        ],
        static_nodes=static_nodes or [],
        assets=assets or [],
        writing_style=writing_style or [],
    )


def _seed_ready_template(
    store: InMemoryCanvasStore, canvas_id: str, archetypes: list[Archetype], *, ratio: str = "16:9"
) -> ArtifactRef:
    manifest = CompiledTemplateManifest(
        status="ready",
        source=SourceRef(path="sources/original.pptx", revision="head", sha256="0" * 64),
        selected_pages=sorted({a.source_page for a in archetypes}),
        ratio=ratio,
        archetypes=archetypes,
    )
    payload = manifest.model_dump_json()
    path = f"templates/{hashlib.sha256(payload.encode()).hexdigest()}.template.json"
    commit = store.write(canvas_id, path, payload, "seed ready template", actor=TEMPLATE_COMPILER_ACTOR)
    return ArtifactRef(
        path=path, revision=commit.revision, sha256=hashlib.sha256(payload.encode("utf-8")).hexdigest()
    )


def _fake_measure(_document: str, *, ratio: str) -> dict:
    return {"width": 960, "height": 540, "elements": [], "unsupported": []}


def _patch_measure(monkeypatch) -> None:
    monkeypatch.setattr("app.agent.deck_template_verification.measure_slide", _fake_measure)


def _patch_judge(monkeypatch, result_or_factory) -> list[list[dict]]:
    captured: list[list[dict]] = []

    def _fake_init_chat_model(_model_name):
        def _invoke(messages):
            captured.append(messages)
            if callable(result_or_factory) and not isinstance(result_or_factory, RuntimeJudgeResult):
                return result_or_factory()
            return result_or_factory

        return SimpleNamespace(with_structured_output=lambda _schema: SimpleNamespace(invoke=_invoke))

    monkeypatch.setattr("app.agent.deck_template_verification.init_chat_model", _fake_init_chat_model)
    return captured


def _write_verbatim_deck(store, canvas_id, ref, destination, text="New body text"):
    slides = [SlideContentRequest(archetype_id="body", mode="verbatim", slots={"body": text})]
    result = write_deck_from_template(
        ref, destination, "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="unused-model",
    )
    assert result["status"] == "ok", result
    return result


def _write_rewrite_deck(store, canvas_id, ref, destination, monkeypatch, output_text="Formal new text"):
    def _fake_init_chat_model(_model_name):
        def _invoke(_messages):
            from app.agent.deck_template_models import SlotContentResult

            return SlotContentResult(
                archetype_id="body", mode="rewrite", slots={"body": output_text},
                fact_coverage={"f1": "body"},
            )

        return SimpleNamespace(with_structured_output=lambda _schema: SimpleNamespace(invoke=_invoke))

    monkeypatch.setattr("app.agent.deck_template_writer.init_chat_model", _fake_init_chat_model)
    slides = [
        SlideContentRequest(
            archetype_id="body", mode="rewrite", slots={"body": "topic: quarterly results"},
            required_facts=[Fact(id="f1", text="Revenue grew 12%")],
        )
    ]
    result = write_deck_from_template(
        ref, destination, "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="test-model",
    )
    assert result["status"] == "ok", result
    return result


def test_proof_uses_instance_map_not_ordinal(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetypes = [_single_slot_archetype(name, page) for name, page in [("a", 1), ("b", 2)]]
    ref = _seed_ready_template(store, canvas_id, archetypes)
    slides = [
        SlideContentRequest(archetype_id="a", mode="verbatim", slots={"body": "Text A"}),
        SlideContentRequest(archetype_id="b", mode="verbatim", slots={"body": "Text B"}),
    ]
    write_deck_from_template(
        ref, "deck.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="unused-model",
    )

    # Reorder the slides (as a UI reorder would) so ordinal position no
    # longer matches the original write order; verification must key off
    # slide_id, not list position.
    content = store.read(canvas_id, "deck.slides.html").content
    swapped = reorder_slides(content, ["slide-002", "slide-001"])
    store.write(canvas_id, "deck.slides.html", swapped, "reorder slides", actor="agent")

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "verified", result
    assert set(result["checked_slide_ids"]) == {"slide-001", "slide-002"}


def test_degraded_or_unchecked_never_aggregates_verified(monkeypatch):
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype(
        "body", 1,
        writing_style=[
            StyleRule(
                role="body", property="font-family", value="unknown",
                origin="unknown", evidence=[],
            )
        ],
    )
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_verbatim_deck(store, canvas_id, ref, "deck.slides.html")
    _patch_measure(monkeypatch)

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["visual_fidelity"]["status"] == "degraded", result
    assert result["complete"] is False


def test_changed_text_invalidates_content_proof(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_verbatim_deck(store, canvas_id, ref, "deck.slides.html", text="Original text")

    content = store.read(canvas_id, "deck.slides.html").content
    edited = content.replace("Original text", "Tampered text")
    store.write(canvas_id, "deck.slides.html", edited, "edit slide text", actor="agent")

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "failed", result
    assert result["complete"] is False


def test_missing_asset_and_font_evidence_are_reported(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype(
        "body", 1,
        assets=[AssetRef(path="assets/logo.png", revision="r1", sha256="a" * 64)],
        writing_style=[
            StyleRule(role="body", property="font-family", value="?", origin="unknown", evidence=[])
        ],
    )
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_verbatim_deck(store, canvas_id, ref, "deck.slides.html")

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    codes = {issue["code"] for issue in result["visual_fidelity"]["issues"]}
    assert "missing_asset" in codes
    assert "unknown_font_evidence" in codes


def test_verifier_recovers_original_fact_contract_after_restart(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_rewrite_deck(store, canvas_id, ref, "deck.slides.html", monkeypatch)

    judge_result = RuntimeJudgeResult(fact_status={"f1": "preserved"}, claims=[])
    _patch_judge(monkeypatch, judge_result)

    # Nothing is passed but path/revision/store/canvas_id — no in-memory state.
    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "verified", result


def test_output_hash_does_not_prove_requested_fact_coverage(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_rewrite_deck(store, canvas_id, ref, "deck.slides.html", monkeypatch)

    # The model claims the fact was preserved via fact_coverage at write time,
    # but the independent judge says it is actually missing — the judge wins.
    judge_result = RuntimeJudgeResult(fact_status={"f1": "missing"}, claims=[])
    _patch_judge(monkeypatch, judge_result)

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "failed", result


def test_verbatim_expectations_survive_publication(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_verbatim_deck(store, canvas_id, ref, "deck.slides.html", text="Exact text")

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "verified", result
    # A verbatim instance has no new authored voice to judge — writing_style
    # is not_checked (never vacuously verified), so `complete` is correctly
    # False even though the one dimension this test targets (content) passed.
    assert result["writing_style"]["status"] == "not_checked", result
    assert result["complete"] is False


def test_modified_expectations_and_hash_cannot_self_approve(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_verbatim_deck(store, canvas_id, ref, "deck.slides.html", text="Original text")

    content = store.read(canvas_id, "deck.slides.html").content
    deck = parse_deck(content)
    forged_slides = [
        SlideTemplate(
            slide_id=slide.slide_id,
            title=slide.title,
            style_css=slide.style_css,
            body_html=slide.body_html.replace("Original text", "Forged text"),
        )
        for slide in deck.slides
    ]
    forged_template = dict(deck.template)
    forged_instances = dict(forged_template["instances"])
    for slide_id, instance in forged_instances.items():
        forged_instance = dict(instance)
        forged_request = dict(forged_instance["request"])
        forged_request["input_slots"] = {"body": ["Forged text"]}
        forged_request["verbatim_expectations"] = {"body": ["Forged text"]}
        forged_instance["request"] = forged_request
        forged_instances[slide_id] = forged_instance
    forged_template["instances"] = forged_instances
    forged_deck = Deck(
        title=deck.title, ratio=deck.ratio, source=deck.source,
        slides=forged_slides, template=forged_template,
    )
    forged = serialize_deck(forged_deck)
    store.write(canvas_id, "deck.slides.html", forged, "forged self-approval edit", actor="agent")

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "failed", result


def test_extra_visible_non_slot_node_invalidates_fidelity(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_verbatim_deck(store, canvas_id, ref, "deck.slides.html")

    content = store.read(canvas_id, "deck.slides.html").content
    injected = content.replace(
        "</section>", '<div data-node-id="injected-claim">Extra business claim</div></section>'
    )
    store.write(canvas_id, "deck.slides.html", injected, "inject extra node", actor="agent")

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["visual_fidelity"]["status"] == "failed", result
    codes = {issue["code"] for issue in result["visual_fidelity"]["issues"]}
    assert "extra_node" in codes


def test_added_business_claim_cannot_pass_existing_slot_hashes(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_rewrite_deck(store, canvas_id, ref, "deck.slides.html", monkeypatch)

    judge_result = RuntimeJudgeResult(
        fact_status={"f1": "preserved"},
        claims=[
            {
                "slot_key": "body",
                "start": 0,
                "end": 5,
                "status": "unsupported",
                "evidence": [],
            }
        ],
    )
    _patch_judge(monkeypatch, judge_result)

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "failed", result


def test_contradictory_extra_claim_inside_valid_slot_fails(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_rewrite_deck(store, canvas_id, ref, "deck.slides.html", monkeypatch)

    judge_result = RuntimeJudgeResult(
        fact_status={"f1": "preserved"},
        claims=[
            {
                "slot_key": "body",
                "start": 0,
                "end": 5,
                "status": "contradictory",
                "evidence": [{"fact_id": "f1"}],
            }
        ],
    )
    _patch_judge(monkeypatch, judge_result)

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "failed", result


def test_judge_malformed_unavailable_or_ambiguous_is_not_checked(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_rewrite_deck(store, canvas_id, ref, "deck.slides.html", monkeypatch)

    def _fake_init_chat_model(_model_name):
        def _invoke(_messages):
            raise RuntimeError("model unavailable")

        return SimpleNamespace(with_structured_output=lambda _schema: SimpleNamespace(invoke=_invoke))

    monkeypatch.setattr("app.agent.deck_template_verification.init_chat_model", _fake_init_chat_model)

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "not_checked", result
    assert result["complete"] is False


def test_all_required_facts_plus_invented_claim_inside_valid_slot_fails(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_rewrite_deck(store, canvas_id, ref, "deck.slides.html", monkeypatch)

    judge_result = RuntimeJudgeResult(
        fact_status={"f1": "preserved"},
        claims=[
            {
                "slot_key": "body",
                "start": 0,
                "end": 10,
                "status": "unsupported",
                "evidence": [],
            }
        ],
    )
    _patch_judge(monkeypatch, judge_result)

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "failed", result
    assert result["complete"] is False


def test_missing_original_input_slots_cannot_verify(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])

    manifest = {
        "schema_version": 1,
        "template": {"path": ref.path, "revision": ref.revision, "sha256": ref.sha256},
        "instances": {
            "slide-001": {
                "archetype_id": "body",
                "source_page": 1,
                "slot_content_sha256": "0" * 64,
                "request": {
                    "mode": "rewrite",
                    "locale": "ko",
                    "required_facts": [{"id": "f1", "text": "Revenue grew 12%"}],
                    "input_slots": {},
                },
                "fact_to_slot": {},
            }
        },
    }
    deck = Deck(
        title="Deck",
        ratio="16:9",
        source=None,
        slides=[
            SlideTemplate(
                slide_id="slide-001",
                title=None,
                style_css="",
                body_html='<section class="slide"><p data-node-id="node-body">New text</p></section>',
            )
        ],
        template=manifest,
    )
    store.write(canvas_id, "deck.slides.html", serialize_deck(deck), "seed", actor=TEMPLATE_WRITER_ACTOR)

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "not_checked", result
    assert result["complete"] is False


def test_ambiguous_claim_is_not_checked(monkeypatch):
    _patch_measure(monkeypatch)
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])
    _write_rewrite_deck(store, canvas_id, ref, "deck.slides.html", monkeypatch)

    judge_result = RuntimeJudgeResult(
        fact_status={"f1": "preserved"},
        claims=[
            {
                "slot_key": "body",
                "start": 0,
                "end": 5,
                "status": "ambiguous",
                "evidence": [],
            }
        ],
    )
    _patch_judge(monkeypatch, judge_result)

    result = verify_template_deck_snapshot(
        "deck.slides.html", None, store=store, canvas_id=canvas_id, judge_model="judge",
    )
    assert result["content"]["status"] == "not_checked", result
    assert result["complete"] is False
