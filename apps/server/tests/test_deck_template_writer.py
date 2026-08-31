"""U3 ordered slot writer and writer-origin provenance publication (task 4).

Covers `write_deck_from_template`/`generate_slot_content`: verbatim is
model-free and deterministic; rewrite only ever sees writing-style rules,
requested slots, and required facts (never source HTML or `DECK_STYLE`);
overflow/failure never commits a partial deck; and the shared
`TemplateBudget` bounds every rewrite retry across a whole batch.
"""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

import pytest
from app.agent.deck_template_writer import write_deck_from_template
from app.agent.deck_template_models import (
    Archetype,
    ArtifactRef,
    Fact,
    SlideContentRequest,
    SlotContentResult,
    SourceRef,
    StyleEvidence,
    StyleRule,
    CompiledTemplateManifest,
    TemplateBudget,
)
from app.agent.deck_templates import TEMPLATE_COMPILER_ACTOR
from langchain_canvas.deck import parse_deck
from langchain_canvas.store import CanvasFileNotFoundError, InMemoryCanvasStore
from pydantic import ValidationError


def _single_slot_archetype(
    archetype_id: str,
    source_page: int,
    *,
    node_id: str | None = None,
    body_text: str = "Old body text",
    writing_style: list[StyleRule] | None = None,
) -> Archetype:
    node_id = node_id or f"node-{archetype_id}"
    frame_html = (
        f'<section class="slide"><p data-node-id="{node_id}">{body_text}</p></section>'
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
        static_nodes=[],
        writing_style=writing_style or [],
    )


def _rich_run_archetype(archetype_id: str = "headline") -> Archetype:
    frame_html = (
        '<section class="slide">'
        '<div data-node-id="node-headline"><b>OLD_BOLD</b><span>OLD_PLAIN</span></div>'
        "</section>"
    )
    return Archetype(
        id=archetype_id,
        source_page=1,
        frame_html=frame_html,
        style_css="",
        slots=[
            {
                "key": "headline",
                "node_id": "node-headline",
                "node_type": "text",
                "role": "title",
                "required": True,
                "rich_run_count": 2,
            }
        ],
        static_nodes=[],
        writing_style=[],
    )


def _seed_ready_template(
    store: InMemoryCanvasStore, canvas_id: str, archetypes: list[Archetype]
) -> ArtifactRef:
    manifest = CompiledTemplateManifest(
        status="ready",
        source=SourceRef(path="sources/original.pptx", revision="head", sha256="0" * 64),
        selected_pages=sorted({a.source_page for a in archetypes}),
        ratio="16:9",
        archetypes=archetypes,
    )
    payload = manifest.model_dump_json()
    path = "templates/h.template.json"
    commit = store.write(canvas_id, path, payload, "seed ready template", actor=TEMPLATE_COMPILER_ACTOR)
    return ArtifactRef(
        path=path, revision=commit.revision, sha256=hashlib.sha256(payload.encode("utf-8")).hexdigest()
    )


def _runtime(events: list | None = None) -> SimpleNamespace:
    events = events if events is not None else []
    return SimpleNamespace(stream_writer=events.append)


def test_three_archetypes_produce_ten_ordered_slides():
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetypes = [_single_slot_archetype(name, page) for name, page in [("a", 1), ("b", 2), ("c", 3)]]
    ref = _seed_ready_template(store, canvas_id, archetypes)

    slides = [
        SlideContentRequest(
            archetype_id=["a", "b", "c"][index % 3],
            mode="verbatim",
            slots={"body": f"New text {index}"},
        )
        for index in range(10)
    ]
    events: list = []
    result = write_deck_from_template(
        ref, "deck.slides.html", "Generated Deck", slides, _runtime(events),
        store=store, canvas_id=canvas_id, writer_model="unused-model",
    )

    assert result["status"] == "ok", result
    assert result["slide_count"] == 10

    deck = parse_deck(store.read(canvas_id, "deck.slides.html").content)
    assert [slide.slide_id for slide in deck.slides] == [f"slide-{i:03d}" for i in range(1, 11)]
    assert deck.template is not None
    instances = deck.template["instances"]
    assert len(instances) == 10
    for index, slide in enumerate(deck.slides):
        expected_archetype = ["a", "b", "c"][index % 3]
        assert instances[slide.slide_id]["archetype_id"] == expected_archetype
        assert f"New text {index}" in slide.body_html


def test_verbatim_is_deterministic_and_model_free(monkeypatch):
    def _fail_if_called(*_args, **_kwargs):
        raise AssertionError("verbatim mode must never call init_chat_model")

    monkeypatch.setattr("app.agent.deck_template_writer.init_chat_model", _fail_if_called)

    archetype = _single_slot_archetype("body", 1)
    ref_and_slides = []
    for destination in ("deck1.slides.html", "deck2.slides.html"):
        store = InMemoryCanvasStore()
        canvas_id = "c1"
        ref = _seed_ready_template(store, canvas_id, [archetype])
        slides = [
            SlideContentRequest(archetype_id="body", mode="verbatim", slots={"body": "Same text"})
        ]
        result = write_deck_from_template(
            ref, destination, "Deck", slides, _runtime(),
            store=store, canvas_id=canvas_id, writer_model="unused-model",
        )
        assert result["status"] == "ok", result
        content = store.read(canvas_id, destination).content
        deck = parse_deck(content)
        ref_and_slides.append(deck.slides[0].body_html)

    assert ref_and_slides[0] == ref_and_slides[1]


def test_rewrite_receives_voice_not_house_style(monkeypatch):
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype(
        "body",
        1,
        writing_style=[
            StyleRule(
                role="body", property="tone", value="formal",
                origin="observed", evidence=[StyleEvidence(page=1, snippet="ex")],
            )
        ],
    )
    ref = _seed_ready_template(store, canvas_id, [archetype])

    captured_messages: list = []

    def _fake_init_chat_model(_model_name):
        def _invoke(messages):
            captured_messages.extend(messages)
            return SlotContentResult(
                archetype_id="body", mode="rewrite", slots={"body": "Formal new text"},
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
        ref, "deck.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="test-model",
    )

    assert result["status"] == "ok", result
    prompt_text = "\n".join(m["content"] for m in captured_messages)
    assert "formal" in prompt_text
    assert "Revenue grew 12%" in prompt_text
    assert "quarterly results" in prompt_text
    # Never the scratch writer's house style or a frame's raw markup.
    assert "Helvetica" not in prompt_text
    assert "kicker" not in prompt_text
    assert "<section" not in prompt_text
    assert "Old body text" not in prompt_text


def test_all_variable_nodes_replace_source_business_text():
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1, body_text="Old body text")
    ref = _seed_ready_template(store, canvas_id, [archetype])

    slides = [
        SlideContentRequest(archetype_id="body", mode="verbatim", slots={"body": "Brand new text"})
    ]
    result = write_deck_from_template(
        ref, "deck.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="unused-model",
    )

    assert result["status"] == "ok", result
    content = store.read(canvas_id, "deck.slides.html").content
    assert "Old body text" not in content
    assert "Brand new text" in content


def test_rich_runs_keep_style_and_exact_topology(monkeypatch):
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _rich_run_archetype()
    ref = _seed_ready_template(store, canvas_id, [archetype])

    def _fake_init_chat_model(_model_name):
        def _invoke(_messages):
            return SlotContentResult(
                archetype_id="headline", mode="rewrite",
                slots={"headline": ["New Bold", "New Plain"]},
            )
        return SimpleNamespace(with_structured_output=lambda _schema: SimpleNamespace(invoke=_invoke))

    monkeypatch.setattr("app.agent.deck_template_writer.init_chat_model", _fake_init_chat_model)

    slides = [
        SlideContentRequest(archetype_id="headline", mode="rewrite", slots={"headline": "seed text"})
    ]
    result = write_deck_from_template(
        ref, "deck.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="test-model",
    )

    assert result["status"] == "ok", result
    content = store.read(canvas_id, "deck.slides.html").content
    assert "<b>New Bold</b>" in content
    assert "<span>New Plain</span>" in content
    assert "OLD_BOLD" not in content
    assert "OLD_PLAIN" not in content


def test_long_korean_content_fails_without_truncation_or_shrink(monkeypatch):
    # The schema itself refuses over-length content rather than truncating it.
    with pytest.raises(ValidationError):
        SlideContentRequest(archetype_id="body", mode="verbatim", slots={"body": "가" * 5000})

    # A rewrite model that keeps returning over-length content is rejected
    # (invalid_model_output) after retries, never truncated into a commit.
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])

    def _fake_init_chat_model(_model_name):
        def _invoke(_messages):
            raise ValidationError.from_exception_data(
                "SlotContentResult", [{"type": "string_too_long", "loc": ("slots", "body"), "input": "x" * 5000, "ctx": {"max_length": 4000}}]
            )
        return SimpleNamespace(with_structured_output=lambda _schema: SimpleNamespace(invoke=_invoke))

    monkeypatch.setattr("app.agent.deck_template_writer.init_chat_model", _fake_init_chat_model)

    slides = [
        SlideContentRequest(archetype_id="body", mode="rewrite", slots={"body": "가" * 10})
    ]
    result = write_deck_from_template(
        ref, "deck.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="test-model",
    )
    assert result["status"] == "error"
    assert result["code"] == "invalid_model_output"
    with pytest.raises(CanvasFileNotFoundError):
        store.read(canvas_id, "deck.slides.html")


def test_wrong_keys_and_model_html_are_rejected(monkeypatch):
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])

    def _wrong_keys_model(_model_name):
        def _invoke(_messages):
            return SlotContentResult(archetype_id="body", mode="rewrite", slots={"totally_wrong": "x"})
        return SimpleNamespace(with_structured_output=lambda _schema: SimpleNamespace(invoke=_invoke))

    monkeypatch.setattr("app.agent.deck_template_writer.init_chat_model", _wrong_keys_model)
    slides = [SlideContentRequest(archetype_id="body", mode="rewrite", slots={"body": "topic"})]
    result = write_deck_from_template(
        ref, "deck1.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="test-model",
    )
    assert result["status"] == "error"
    assert result["code"] == "invalid_model_output"

    def _html_model(_model_name):
        def _invoke(_messages):
            return SlotContentResult(archetype_id="body", mode="rewrite", slots={"body": "<b>hi</b>"})
        return SimpleNamespace(with_structured_output=lambda _schema: SimpleNamespace(invoke=_invoke))

    monkeypatch.setattr("app.agent.deck_template_writer.init_chat_model", _html_model)
    result2 = write_deck_from_template(
        ref, "deck2.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="test-model",
    )
    assert result2["status"] == "error"
    assert result2["code"] == "invalid_model_output"


def test_worker_failure_writes_no_partial_deck():
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])

    slides = [
        SlideContentRequest(archetype_id="body", mode="verbatim", slots={"body": "ok text"}),
        SlideContentRequest(
            archetype_id="body", mode="verbatim", slots={"body": "ok", "unknown_slot": "bad"}
        ),
    ]
    result = write_deck_from_template(
        ref, "deck.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="unused-model",
    )

    assert result["status"] == "error"
    assert result["code"] == "ambiguous_slots"
    with pytest.raises(CanvasFileNotFoundError):
        store.read(canvas_id, "deck.slides.html")


class _RaceOnceStore(InMemoryCanvasStore):
    """Simulates another writer creating ``path`` between check and commit."""

    def __init__(self) -> None:
        super().__init__()
        self._raced = False

    def write(self, canvas_id, path, content, description, base_revision=None, actor=None, amends=None):
        if not self._raced and path == "deck.slides.html":
            self._raced = True
            super().write(canvas_id, path, "raced-content", "raced by another writer", actor="agent")
        return super().write(
            canvas_id, path, content, description, base_revision=base_revision, actor=actor, amends=amends
        )


def test_destination_race_emits_no_success_event():
    store = _RaceOnceStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])

    slides = [SlideContentRequest(archetype_id="body", mode="verbatim", slots={"body": "text"})]
    events: list = []
    result = write_deck_from_template(
        ref, "deck.slides.html", "Deck", slides, _runtime(events),
        store=store, canvas_id=canvas_id, writer_model="unused-model",
    )

    assert result["status"] == "error"
    assert result["code"] == "destination_exists"
    assert events == []
    assert store.read(canvas_id, "deck.slides.html").content == "raced-content"


class _NoSourceReadStore(InMemoryCanvasStore):
    """Raises if the pinned source PPTX is ever re-read (no reconversion)."""

    def read_bytes(self, canvas_id, path, revision=None):
        if path == "sources/original.pptx":
            raise AssertionError("write_deck_from_template must not re-read the source")
        return super().read_bytes(canvas_id, path, revision=revision)


def test_reuse_pinned_template_does_not_reconvert_source():
    store = _NoSourceReadStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])

    slides = [SlideContentRequest(archetype_id="body", mode="verbatim", slots={"body": "text"})]
    result = write_deck_from_template(
        ref, "deck.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="unused-model",
    )
    assert result["status"] == "ok", result


def test_shared_content_retry_budget_has_no_partial_commit(monkeypatch):
    store = InMemoryCanvasStore()
    canvas_id = "c1"
    archetype = _single_slot_archetype("body", 1)
    ref = _seed_ready_template(store, canvas_id, [archetype])

    def _fake_init_chat_model(_model_name):
        def _invoke(_messages):
            return SlotContentResult(archetype_id="body", mode="rewrite", slots={"body": "ok text"})
        return SimpleNamespace(with_structured_output=lambda _schema: SimpleNamespace(invoke=_invoke))

    monkeypatch.setattr("app.agent.deck_template_writer.init_chat_model", _fake_init_chat_model)

    slides = [
        SlideContentRequest(archetype_id="body", mode="rewrite", slots={"body": "topic 1"}),
        SlideContentRequest(archetype_id="body", mode="rewrite", slots={"body": "topic 2"}),
    ]
    tiny_budget = TemplateBudget(max_model_attempts=1)
    result = write_deck_from_template(
        ref, "deck.slides.html", "Deck", slides, _runtime(),
        store=store, canvas_id=canvas_id, writer_model="test-model",
        concurrency=1, budget=tiny_budget,
    )

    assert result["status"] == "error"
    assert result["code"] == "resource_budget_exceeded"
    with pytest.raises(CanvasFileNotFoundError):
        store.read(canvas_id, "deck.slides.html")
