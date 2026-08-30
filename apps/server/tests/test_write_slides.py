"""Tests for `app.agent.deck_batch`: writer retry/backoff and the concurrent
slide-body fan-out (`generate_slide_bodies`), including the context
propagation `copy_context()` submission requires.

Also covers the `write_slides`/`write_slide` tools in `app.agent.tools`,
which build on top of `deck_batch`'s fan-out and retry helpers.
"""

from __future__ import annotations

import contextvars
import dataclasses
import threading
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from app.agent.configuration import config
from app.agent.deck_batch import (
    SlideOutcome,
    SlideSpec,
    build_slide_prompt,
    format_batch_result,
    generate_slide_bodies,
    invoke_writer_with_retry,
)
from app.agent.store import DATA_DIR, STORE
from app.agent.tools import plan_deck, write_slide, write_slides
from langchain_canvas.deck import parse_deck


class _RetryableError(Exception):
    """Stand-in for an Anthropic APIStatusError-like transient failure."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"upstream error {status_code}")
        self.status_code = status_code


def test_invoke_writer_with_retry_retries_transient_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invoke_calls: list[str] = []

    def _invoke(prompt: str) -> SimpleNamespace:
        invoke_calls.append(prompt)
        if len(invoke_calls) <= 2:
            raise _RetryableError(429)
        return SimpleNamespace(content="<section>ok</section>")

    monkeypatch.setattr(
        "app.agent.deck_batch.init_chat_model",
        lambda *_a, **_k: SimpleNamespace(invoke=_invoke),
    )
    sleep_calls: list[float] = []
    monkeypatch.setattr("app.agent.deck_batch._sleep", sleep_calls.append)

    result = invoke_writer_with_retry("test-model", "a prompt", max_retries=2)

    assert result == "<section>ok</section>"
    assert len(invoke_calls) == 3
    assert sleep_calls == [0.5, 1.0]


def test_invoke_writer_with_retry_non_retryable_raises_immediately(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invoke_calls: list[str] = []

    def _invoke(prompt: str) -> SimpleNamespace:
        invoke_calls.append(prompt)
        raise _RetryableError(400)

    monkeypatch.setattr(
        "app.agent.deck_batch.init_chat_model",
        lambda *_a, **_k: SimpleNamespace(invoke=_invoke),
    )
    sleep_calls: list[float] = []
    monkeypatch.setattr("app.agent.deck_batch._sleep", sleep_calls.append)

    with pytest.raises(_RetryableError) as exc_info:
        invoke_writer_with_retry("test-model", "a prompt", max_retries=2)

    assert exc_info.value.status_code == 400
    assert len(invoke_calls) == 1
    assert sleep_calls == []


def test_generate_slide_bodies_preserves_order_and_isolates_failures() -> None:
    specs = [
        SlideSpec(slide_id="slide-001", title="One", brief="First slide"),
        SlideSpec(slide_id="slide-002", title="Two", brief="Second slide"),
        SlideSpec(slide_id="slide-003", title="Three", brief="Third slide"),
    ]
    started: list[str] = []

    def _invoke_writer(prompt: str) -> str:
        if "Second slide" in prompt:
            raise RuntimeError("writer exploded")
        return f"<section>{prompt}</section>"

    outcomes = generate_slide_bodies(
        specs,
        invoke_writer=_invoke_writer,
        concurrency=3,
        on_start=started.append,
    )

    assert [o.slide_id for o in outcomes] == ["slide-001", "slide-002", "slide-003"]
    assert isinstance(outcomes[0], SlideOutcome)
    assert outcomes[0].error is None
    assert outcomes[0].body_html is not None
    assert "First slide" in outcomes[0].body_html

    assert outcomes[1].error == "writer exploded"
    assert outcomes[1].body_html is None

    assert outcomes[2].error is None
    assert outcomes[2].body_html is not None
    assert "Third slide" in outcomes[2].body_html

    assert set(started) == {"slide-001", "slide-002", "slide-003"}


_probe_var: contextvars.ContextVar[str] = contextvars.ContextVar("probe")


def test_generate_slide_bodies_propagates_calling_thread_context() -> None:
    """`generate_slide_bodies` submits each task via `copy_context().run`, so
    a ContextVar set in the calling thread must be visible inside the worker
    thread's `on_start` callback. A bare `ThreadPoolExecutor.submit` would
    NOT propagate the ContextVar, and `on_start` below would raise."""
    token = _probe_var.set("propagated")
    try:

        def _on_start(slide_id: str) -> None:
            if _probe_var.get(None) is None:
                raise RuntimeError("outside of a runnable context")

        specs = [SlideSpec(slide_id="slide-001", title="One", brief="Brief")]

        outcomes = generate_slide_bodies(
            specs,
            invoke_writer=lambda _prompt: "<section>ok</section>",
            concurrency=1,
            on_start=_on_start,
        )
    finally:
        _probe_var.reset(token)

    assert outcomes[0].error is None
    assert outcomes[0].body_html == "<section>ok</section>"


def test_build_slide_prompt_includes_brief_and_fragment_instructions() -> None:
    prompt = build_slide_prompt("Say hello to the audience")

    assert "Say hello to the audience" in prompt
    assert '<section class="slide">' in prompt
    assert "no <html>/<body>/" in prompt


def test_format_batch_result_reports_ok_error_and_layout_summary() -> None:
    outcomes = [
        SlideOutcome(
            slide_id="slide-001",
            body_html="<section>ok</section>",
            layout_report="LAYOUT CHECK deck.slides.html#slide-001: 1 error(s), 1 warning(s)\n"
            "ERROR: content overflows\n"
            "WARNING: almost no text content rendered",
        ),
        SlideOutcome(slide_id="slide-002", error="writer exploded"),
    ]

    result = format_batch_result("deck.slides.html", outcomes)

    assert "OK slide-001" in result
    assert "ERROR: content overflows" in result
    assert "WARNING: almost no text content rendered" in result
    assert "Error slide-002: writer exploded" in result
    assert "Layout summary: 1 ERROR, 1 WARNING" in result
    assert "re-included in the next write_slides call: slide-002" in result


# --- write_slides / write_slide tool tests -------------------------------

_WRITE_SLIDES_THREAD_IDS = (
    "t-ws-parallel",
    "t-ws-peak-concurrency",
    "t-ws-commit-order",
    "t-ws-partial-failure",
    "t-ws-events",
    "t-ws-batch-cap",
    "t-ws-validation",
    "t-ws-missing-deck",
    "t-ws-edit-error",
    "t-ws-render-error",
    "t-ws-write-slide-regression",
)


@pytest.fixture(autouse=True)
def _cleanup_write_slides_canvas_data() -> Any:
    yield
    import shutil

    for thread_id in _WRITE_SLIDES_THREAD_IDS:
        shutil.rmtree(DATA_DIR / thread_id, ignore_errors=True)


@dataclass
class _Runtime:
    """The slice of ToolRuntime the server tools read — same shape as
    `test_tools_errors.py`'s fixture."""

    context: Any = None
    config: dict[str, Any] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)

    @property
    def stream_writer(self):
        return self.events.append


def _runtime(thread_id: str) -> _Runtime:
    return _Runtime(config={"configurable": {"thread_id": thread_id}})


def _seed_deck(thread_id: str, n: int) -> tuple[str, list[str]]:
    titles = [f"Slide {i}" for i in range(1, n + 1)]
    result = plan_deck.func(title="Deck", slide_titles=titles, runtime=_runtime(thread_id))
    assert "Error" not in result, result
    path = next(
        info.path for info in STORE.list_files(thread_id) if info.path.endswith(".slides.html")
    )
    slide_ids = [s.slide_id for s in parse_deck(STORE.read(thread_id, path).content).slides]
    return path, slide_ids


def _patch_render_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.agent.tools.render_slide", lambda html, *, ratio: ({"html": html}, b"")
    )
    monkeypatch.setattr(
        "app.agent.verify._layout_report",
        lambda label, metrics: f"LAYOUT CHECK {label}: 0 error(s), 0 warning(s)",
    )


def _patch_writer_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.agent.deck_batch.init_chat_model",
        lambda *_a, **_k: SimpleNamespace(
            invoke=lambda _prompt: SimpleNamespace(content='<section class="slide">ok</section>')
        ),
    )
    monkeypatch.setattr("app.agent.deck_batch._sleep", lambda *_a: None)


def test_write_slides_generates_slide_bodies_in_parallel(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 3-way barrier only releases if all 3 slides' writer calls are in
    flight at once — proves generation is concurrent, not sequential."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-parallel"
    path, slide_ids = _seed_deck(thread_id, 3)
    _patch_render_ok(monkeypatch)

    barrier = threading.Barrier(3, timeout=5)

    def _invoke(prompt: str) -> SimpleNamespace:
        barrier.wait()
        return SimpleNamespace(content='<section class="slide">ok</section>')

    monkeypatch.setattr(
        "app.agent.deck_batch.init_chat_model", lambda *_a, **_k: SimpleNamespace(invoke=_invoke)
    )
    monkeypatch.setattr("app.agent.deck_batch._sleep", lambda *_a: None)

    result = write_slides.func(
        path=path,
        slide_ids=slide_ids,
        titles=["One", "Two", "Three"],
        briefs=["Brief 1", "Brief 2", "Brief 3"],
        runtime=_runtime(thread_id),
    )

    assert f"Wrote 3/3 slides to {path}" in result


def test_write_slides_respects_configured_concurrency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-peak-concurrency"
    path, slide_ids = _seed_deck(thread_id, 6)
    _patch_render_ok(monkeypatch)
    monkeypatch.setattr(
        "app.agent.tools.config", dataclasses.replace(config, deck_writer_concurrency=2)
    )

    lock = threading.Lock()
    state = {"active": 0, "peak": 0}

    def _invoke(prompt: str) -> SimpleNamespace:
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        try:
            threading.Event().wait(0.05)
            return SimpleNamespace(content='<section class="slide">ok</section>')
        finally:
            with lock:
                state["active"] -= 1

    monkeypatch.setattr(
        "app.agent.deck_batch.init_chat_model", lambda *_a, **_k: SimpleNamespace(invoke=_invoke)
    )
    monkeypatch.setattr("app.agent.deck_batch._sleep", lambda *_a: None)

    result = write_slides.func(
        path=path,
        slide_ids=slide_ids,
        titles=[f"T{i}" for i in range(1, 7)],
        briefs=[f"Brief {i}" for i in range(1, 7)],
        runtime=_runtime(thread_id),
    )

    assert f"Wrote 6/6 slides to {path}" in result
    assert state["peak"] <= 2


def test_write_slides_commits_sequentially_with_fresh_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-commit-order"
    path, slide_ids = _seed_deck(thread_id, 3)
    _patch_render_ok(monkeypatch)
    _patch_writer_ok(monkeypatch)

    from app.agent.tools import _edit_deck_slide

    calls: list[tuple[str, str]] = []
    original_func = _edit_deck_slide.func

    def _spy(*, path: str, slide_id: str, template_html: str, revision: str, runtime: Any):
        calls.append((slide_id, revision))
        return original_func(
            path=path,
            slide_id=slide_id,
            template_html=template_html,
            revision=revision,
            runtime=runtime,
        )

    monkeypatch.setattr(_edit_deck_slide, "func", _spy)

    initial_revision = STORE.read(thread_id, path).revision

    result = write_slides.func(
        path=path,
        slide_ids=slide_ids,
        titles=["One", "Two", "Three"],
        briefs=["Brief 1", "Brief 2", "Brief 3"],
        runtime=_runtime(thread_id),
    )

    assert [c[0] for c in calls] == slide_ids
    revisions_seen = [c[1] for c in calls]
    assert revisions_seen[0] == initial_revision
    assert len(set(revisions_seen)) == len(slide_ids)
    final_revision = STORE.read(thread_id, path).revision
    assert final_revision != initial_revision
    assert f"Wrote 3/3 slides to {path}" in result


def test_write_slides_isolates_writer_failure_to_one_slide(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-partial-failure"
    path, slide_ids = _seed_deck(thread_id, 3)
    _patch_render_ok(monkeypatch)

    def _invoke(prompt: str) -> SimpleNamespace:
        if "Second slide" in prompt:
            raise RuntimeError("boom")
        return SimpleNamespace(content='<section class="slide">ok</section>')

    monkeypatch.setattr(
        "app.agent.deck_batch.init_chat_model", lambda *_a, **_k: SimpleNamespace(invoke=_invoke)
    )
    monkeypatch.setattr("app.agent.deck_batch._sleep", lambda *_a: None)

    result = write_slides.func(
        path=path,
        slide_ids=slide_ids,
        titles=["First", "Second", "Third"],
        briefs=["First slide", "Second slide", "Third slide"],
        runtime=_runtime(thread_id),
    )

    assert f"Wrote 2/3 slides to {path}" in result
    assert f"Error {slide_ids[1]}: boom" in result
    deck = parse_deck(STORE.read(thread_id, path).content)
    by_id = {s.slide_id: s for s in deck.slides}
    assert by_id[slide_ids[1]].body_html.strip() == '<section class="slide"></section>'


def test_write_slides_emits_slide_status_events_in_expected_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-events"
    path, slide_ids = _seed_deck(thread_id, 3)
    _patch_render_ok(monkeypatch)

    def _invoke(prompt: str) -> SimpleNamespace:
        if "Second slide" in prompt:
            raise RuntimeError("writer down")
        return SimpleNamespace(content='<section class="slide">ok</section>')

    monkeypatch.setattr(
        "app.agent.deck_batch.init_chat_model", lambda *_a, **_k: SimpleNamespace(invoke=_invoke)
    )
    monkeypatch.setattr("app.agent.deck_batch._sleep", lambda *_a: None)

    runtime = _runtime(thread_id)
    write_slides.func(
        path=path,
        slide_ids=slide_ids,
        titles=["First", "Second", "Third"],
        briefs=["First slide", "Second slide", "Third slide"],
        runtime=runtime,
    )

    events = runtime.events
    generating_ids = {e["slideId"] for e in events if e.get("stage") == "generating"}
    assert generating_ids == set(slide_ids)

    def _stages_for(slide_id: str) -> list[str]:
        return [e["stage"] for e in events if e.get("slideId") == slide_id and "stage" in e]

    for successful_id in (slide_ids[0], slide_ids[2]):
        stages = _stages_for(successful_id)
        assert stages.index("verifying") == stages.index("complete") - 1

    failed_stages = _stages_for(slide_ids[1])
    assert failed_stages.count("degraded") == 1
    assert "verifying" not in failed_stages
    degraded_event = next(
        e for e in events if e.get("slideId") == slide_ids[1] and e.get("stage") == "degraded"
    )
    assert degraded_event["detail"] == "writer down"


def test_write_slides_rejects_batch_over_configured_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-batch-cap"
    path, slide_ids = _seed_deck(thread_id, 3)
    monkeypatch.setattr("app.agent.tools.config", dataclasses.replace(config, deck_batch_size=2))

    writer_calls: list[str] = []
    monkeypatch.setattr(
        "app.agent.deck_batch.init_chat_model",
        lambda *_a, **_k: SimpleNamespace(invoke=lambda p: writer_calls.append(p)),
    )

    result = write_slides.func(
        path=path,
        slide_ids=slide_ids,
        titles=["One", "Two", "Three"],
        briefs=["B1", "B2", "B3"],
        runtime=_runtime(thread_id),
    )

    assert result == (
        "Error: write_slides accepts at most 2 slides per call (got 3); split into batches."
    )
    assert writer_calls == []


@pytest.mark.parametrize(
    "slide_ids,titles,briefs",
    [
        ([], [], []),
        (["slide-001"], [], ["Brief"]),
        (["slide-001", "slide-002"], ["One"], ["B1", "B2"]),
    ],
)
def test_write_slides_validates_list_shape(
    monkeypatch: pytest.MonkeyPatch,
    slide_ids: list[str],
    titles: list[str],
    briefs: list[str],
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    result = write_slides.func(
        path="deck.slides.html",
        slide_ids=slide_ids,
        titles=titles,
        briefs=briefs,
        runtime=_runtime("t-ws-validation"),
    )

    assert result.startswith("Error:")


def test_write_slides_missing_deck_returns_plan_deck_hint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    result = write_slides.func(
        path="deck.slides.html",
        slide_ids=["slide-001"],
        titles=["One"],
        briefs=["Brief"],
        runtime=_runtime("t-ws-missing-deck"),
    )

    assert result == "No deck deck.slides.html exists yet. Call plan_deck first."


def test_write_slides_degrades_slide_when_edit_deck_slide_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-edit-error"
    path, slide_ids = _seed_deck(thread_id, 2)
    _patch_render_ok(monkeypatch)
    _patch_writer_ok(monkeypatch)

    from app.agent.tools import _edit_deck_slide

    original_func = _edit_deck_slide.func

    def _fake(*, path: str, slide_id: str, template_html: str, revision: str, runtime: Any):
        if slide_id == slide_ids[0]:
            return "Error: nope"
        return original_func(
            path=path,
            slide_id=slide_id,
            template_html=template_html,
            revision=revision,
            runtime=runtime,
        )

    monkeypatch.setattr(_edit_deck_slide, "func", _fake)

    result = write_slides.func(
        path=path,
        slide_ids=slide_ids,
        titles=["One", "Two"],
        briefs=["Brief 1", "Brief 2"],
        runtime=_runtime(thread_id),
    )

    assert f"Wrote 1/2 slides to {path}" in result
    assert f"Error {slide_ids[0]}: nope" in result
    assert f"OK {slide_ids[1]}" in result


def test_write_slides_render_failure_keeps_slide_ok_and_skips_layout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-render-error"
    path, slide_ids = _seed_deck(thread_id, 1)
    _patch_writer_ok(monkeypatch)

    def _raising_render(html: str, *, ratio: object):
        raise RuntimeError("playwright crashed")

    monkeypatch.setattr("app.agent.tools.render_slide", _raising_render)

    runtime = _runtime(thread_id)
    result = write_slides.func(
        path=path,
        slide_ids=slide_ids,
        titles=["One"],
        briefs=["Brief"],
        runtime=runtime,
    )

    assert f"Wrote 1/1 slides to {path}" in result
    assert f"OK {slide_ids[0]}" in result
    assert "layout check skipped" in result
    assert "playwright crashed" in result
    complete_events = [
        e for e in runtime.events if e.get("slideId") == slide_ids[0] and e.get("stage") == "complete"
    ]
    assert len(complete_events) == 1


def test_write_slide_still_commits_and_reports_layout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: write_slide's single-slide path still commits and reports
    layout via the new deck_batch-backed helpers."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    thread_id = "t-ws-write-slide-regression"
    path, slide_ids = _seed_deck(thread_id, 1)
    _patch_render_ok(monkeypatch)
    _patch_writer_ok(monkeypatch)

    initial_revision = STORE.read(thread_id, path).revision

    result = write_slide.func(
        path=path,
        slide_id=slide_ids[0],
        title="Cover",
        brief="Say hello",
        runtime=_runtime(thread_id),
    )

    assert "Error" not in result
    assert "LAYOUT CHECK" in result
    final_revision = STORE.read(thread_id, path).revision
    assert final_revision != initial_revision
