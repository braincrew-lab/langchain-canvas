"""Concurrent slide-body generation for batched deck writes.

``write_slides`` (task 4, ``tools.py``) fans out one writer-model call per
slide across a thread pool instead of writing slides one at a time. This
module owns that fan-out plus the writer-model retry/backoff wrapper and the
per-slide result formatting — kept out of ``tools.py`` so that module does
not need to import this one (this module MUST NOT import ``tools.py``: that
would create an import cycle once ``write_slides`` in ``tools.py`` imports
from here).

Context propagation rationale: LangGraph's ``ToolRuntime.stream_writer``
reads a ``ContextVar`` (``var_child_runnable_config``) at call time to know
which run to attach a custom stream event to. A bare
``ThreadPoolExecutor.submit`` does **not** propagate the calling thread's
context to the worker thread, so a writer callback invoked from a plain pool
thread would see stream_writer break (or write to the wrong run) once one
exists. Each submission is therefore wrapped in
``contextvars.copy_context().run(...)`` — mirroring the pattern
``langchain_core.runnables.config.run_in_executor`` uses for the same
reason. A **fresh** ``copy_context()`` is taken per submission (not shared
across submissions): running one ``Context`` object in more than one thread
raises ``RuntimeError``.
"""

from __future__ import annotations

import contextvars
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

from langchain.chat_models import init_chat_model

from .resilience import should_retry_model_call
from .store import SLIDE_HEIGHT, SLIDE_WIDTH

# Module attribute (not a bare `time.sleep` call) so tests can patch it out
# with a no-op and assert on the backoff delays it was called with.
_sleep = time.sleep

_MAX_BACKOFF_SECONDS = 4.0

# The deck's shared design language — duplicated from `tools.py`'s
# `DECK_STYLE` (not imported: this module must not import `tools.py`, to
# avoid an import cycle once `tools.py` imports from here in a later task).
DECK_STYLE = f"""The slide is a fixed {SLIDE_WIDTH}x{SLIDE_HEIGHT} canvas. Hard rules:
- <body> is exactly {SLIDE_WIDTH}x{SLIDE_HEIGHT} px (margin 0, overflow hidden). Everything must fit — no scrolling, nothing clipped.
- Generous margins: at least 64px of padding on every side. Leave breathing room; do not fill every pixel.
- Typography: a large display serif for the headline (Georgia, 'Times New Roman', serif) and a clean sans-serif for body text ('Helvetica Neue', Arial, sans-serif). Strong size contrast: headline 56-88px, body 20-26px.
- One accent color, used sparingly and consistently (kicker label, rules, highlights) on a calm near-white or near-black background. The whole deck shares one palette.
- Structure per slide: a small uppercase kicker label, one strong headline, then at most 3-4 supporting points OR one focused visual block. Less is more.
- Self-contained: inline <style> only. No external resources, no scripts, no network images. Use CSS (gradients, borders, simple shapes) for visual interest.
- Return ONLY the HTML document."""


@dataclass(frozen=True)
class SlideSpec:
    """One slide to write: its target id, title, and content brief."""

    slide_id: str
    title: str
    brief: str


@dataclass
class SlideOutcome:
    """The result of writing one slide's body in a batch."""

    slide_id: str
    body_html: str | None = None
    error: str | None = None
    layout_report: str | None = None
    stage: Literal["complete", "degraded"] = "complete"


def _text_of(chunk: object) -> str:
    content = getattr(chunk, "content", "")
    return content if isinstance(content, str) else ""


def _strip_code_fence(text: str) -> str:
    """Drop a leading ```html / trailing ``` fence if the model wrapped its output."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1]
        if stripped.endswith("```"):
            stripped = stripped[: stripped.rfind("```")]
    return stripped.strip()


def build_slide_prompt(brief: str) -> str:
    """The writer-model prompt for one slide's markup, given its content brief."""
    return (
        "Create one presentation slide's markup as a single "
        '<section class="slide">...</section> fragment — no <html>/<body>/'
        f"<style> wrapper.\n\n{DECK_STYLE}\n\nSlide content: {brief}"
    )


def invoke_writer_with_retry(model_name: str, prompt: str, *, max_retries: int) -> str:
    """Call the writer model, retrying transient failures with backoff.

    Retries only when `resilience.should_retry_model_call` says the failure
    is transient (429/5xx/connection errors); anything else re-raises
    immediately. Backoff is ``0.5 * 2**attempt`` seconds, capped at
    `_MAX_BACKOFF_SECONDS`.
    """
    model = init_chat_model(model_name)
    attempt = 0
    while True:
        try:
            return _strip_code_fence(_text_of(model.invoke(prompt)))
        except Exception as exc:
            if attempt >= max_retries or not should_retry_model_call(exc):
                raise
            delay = min(0.5 * (2**attempt), _MAX_BACKOFF_SECONDS)
            _sleep(delay)
            attempt += 1


def generate_slide_bodies(
    specs: Sequence[SlideSpec],
    *,
    invoke_writer: Callable[[str], str],
    concurrency: int,
    on_start: Callable[[str], None],
) -> list[SlideOutcome]:
    """Generate each slide's body concurrently, one writer call per slide.

    `invoke_writer` receives the built prompt and returns the slide body
    HTML (or raises — a raise is caught here and turned into a failed
    `SlideOutcome`, never propagated to the caller). `on_start` is called
    from the worker thread right before `invoke_writer`, so a caller can use
    it to emit a per-slide "started" stream event. Outcomes are returned in
    `specs` order regardless of completion order.
    """

    def _one(spec: SlideSpec) -> SlideOutcome:
        on_start(spec.slide_id)
        try:
            body_html = invoke_writer(build_slide_prompt(spec.brief))
        except Exception as exc:  # noqa: BLE001 - failure becomes a SlideOutcome, never raises
            return SlideOutcome(slide_id=spec.slide_id, error=str(exc))
        return SlideOutcome(slide_id=spec.slide_id, body_html=body_html)

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(contextvars.copy_context().run, _one, spec) for spec in specs]
        return [future.result() for future in futures]


def format_batch_result(path: str, outcomes: Sequence[SlideOutcome]) -> str:
    """Summarize a batch write: per-slide OK/Error lines, layout lines, and a
    layout summary. Slides that failed (Error) must be passed again in the
    next `write_slides` call — that hint is appended when any failed.
    """
    lines: list[str] = [f"Batch result for {path}:"]
    error_count = 0
    warning_count = 0
    failed_ids: list[str] = []

    for outcome in outcomes:
        if outcome.error:
            lines.append(f"Error {outcome.slide_id}: {outcome.error}")
            failed_ids.append(outcome.slide_id)
            continue
        lines.append(f"OK {outcome.slide_id}")
        if outcome.layout_report:
            lines.append(outcome.layout_report)
            for report_line in outcome.layout_report.splitlines():
                if report_line.startswith("ERROR:"):
                    error_count += 1
                elif report_line.startswith("WARNING:"):
                    warning_count += 1

    lines.append(f"Layout summary: {error_count} ERROR, {warning_count} WARNING")
    if failed_ids:
        lines.append(
            "Error slides must be re-included in the next write_slides call: "
            + ", ".join(failed_ids)
        )
    return "\n".join(lines)
