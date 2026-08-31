"""Opt-in live gate for the source-grounded slide template pipeline (task 6).

Runs only when ``RUN_TEMPLATE_LIVE=1`` — the default CI run always skips this
file with a recorded reason, per the plan's "live gate is separate from the
deterministic suite" rule. This exercises the full
inspect -> prepare -> finalize -> write -> verify sequence against the
*real* configured model (no fake boundary), so source fidelity and fact
completeness are hard gates and role-specific voice/format rubrics are
0-2 advisory scores a human reviews from this test's own output — an
automated pass/fail on the rubric dimensions is not asserted here, only
recorded, per the plan's "ambiguous judge calls stay unconfirmed" rule.

600s is an explicit, stated exception to the project's normal per-test
timeout (see ``testing/test-execution.md``): this is the one opt-in live
case that reconstructs PDF pages and calls an external model/judge twice.
"""

from __future__ import annotations

import hashlib
import os
from types import SimpleNamespace

import pytest
from app.agent.configuration import config
from app.agent.deck_template_tools import create_deck_template_tools
from langchain_canvas.store import InMemoryCanvasStore
from template_source_fixtures import korean_pptx_source

pytestmark = pytest.mark.timeout(600)

_SKIP_REASON = (
    "Live template-workflow gate is opt-in: set RUN_TEMPLATE_LIVE=1 to run it "
    "against a real configured model. Skipped by default so CI never depends "
    "on a live provider."
)


def _runtime(canvas_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        config={"configurable": {"thread_id": canvas_id}}, context=None, stream_writer=None
    )


@pytest.mark.skipif(os.environ.get("RUN_TEMPLATE_LIVE") != "1", reason=_SKIP_REASON)
def test_baseline_candidate_voice_and_fidelity() -> None:
    """The candidate template pipeline preserves source fidelity and required
    facts (hard gates) against a real model, with per-role voice/format
    rubrics recorded for human review.

    "Baseline" here is the same synthetic source and input the deterministic
    suite (``test_template_workflow.py``) already exercises against a fake
    model boundary; "candidate" is this same pipeline run once against the
    real ``config.writer_model``/judge model. There is no second, legacy
    template-generation implementation in this codebase to A/B against — a
    literal baseline-vs-candidate architecture comparison is out of task 6's
    scope and would need its own plan.
    """
    canvas_id = "thread-live-template"
    store = InMemoryCanvasStore()
    data = korean_pptx_source(
        [("연간 성과 요약", "이 페이지는 지난 한 해의 핵심 성과를 서술형으로 요약합니다.")]
    )
    store.write_bytes(canvas_id, "sources/deck.pptx", data, "Upload")
    runtime = _runtime(canvas_id)
    tools = {t.name: t for t in create_deck_template_tools(store)}

    census = tools["inspect_deck_patterns"].func(source="sources/deck.pptx", runtime=runtime)
    assert census["groups"], "the synthetic source must yield at least one reusable page group"

    define = tools["define_deck_template"]
    candidate = define.func(
        mode="prepare",
        runtime=runtime,
        source="sources/deck.pptx",
        source_sha256=hashlib.sha256(data).hexdigest(),
        pages=[1],
    )
    assert candidate["status"] == "candidate"
    archetype = candidate["archetypes"][0]
    bindings = [
        {
            "archetype_id": archetype["id"],
            "node_id": slot["node_id"],
            "disposition": "variable",
            "slot_key": slot["key"],
            "role": slot["role"],
            "required": True,
        }
        for slot in archetype["slots"]
    ]
    ready = define.func(
        mode="finalize", runtime=runtime, candidate_ref=candidate["candidate_ref"], bindings=bindings
    )
    assert ready["status"] == "ready"

    slot_keys = [slot["key"] for slot in archetype["slots"]]
    required_fact = {"id": "quarterly-growth", "text": "분기별 매출 성장률 12%"}
    write_result = tools["write_deck_from_template"].func(
        template_ref=ready["template_ref"],
        destination="live-deck.slides.html",
        title="새 분기 성과 보고",
        slides=[
            {
                "archetype_id": archetype["id"],
                "mode": "rewrite",
                "slots": {
                    slot_keys[0]: "새 분기 성과 제목",
                    slot_keys[1]: "이 슬라이드는 새 분기의 핵심 성과를 서술형으로 설명합니다.",
                },
                "required_facts": [required_fact],
            }
        ],
        runtime=runtime,
    )
    assert write_result["status"] == "ok", write_result

    verified = tools["verify_template_deck"].func(
        path="live-deck.slides.html", revision=write_result["revision"], runtime=runtime
    )

    # Hard gates: source fidelity and required-fact completeness.
    assert verified["visual_fidelity"]["status"] in ("verified", "degraded"), verified
    assert verified["content"]["status"] != "failed", verified

    # Advisory, human-read voice/format signal — recorded, not asserted pass/fail.
    print(f"writer_model={config.writer_model} content_status={verified['content']['status']}")
    print(f"writing_style_status={verified['writing_style']['status']}")
    print(f"issues={verified['issues']!r}")
    print(f"warnings={verified['warnings']!r}")
