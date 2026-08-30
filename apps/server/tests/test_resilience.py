"""Tests for `app.agent.resilience`: `should_retry_model_call` predicate and
`build_model_resilience_middleware` factory, plus an async integration test
that drives a real `create_canvas_agent` run through a flaky fake model to
prove the retry middleware actually recovers a transient failure.
"""

from __future__ import annotations

import pytest
from app.agent.configuration import Configuration
from app.agent.resilience import (
    build_model_resilience_middleware,
    should_retry_model_call,
)
from langchain.agents.middleware import ModelFallbackMiddleware, ModelRetryMiddleware
from langchain_canvas import create_canvas_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import PrivateAttr


class _StatusError(Exception):
    """Minimal stand-in for `anthropic.APIStatusError`: exposes `status_code`."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"status {status_code}")
        self.status_code = status_code


def _build_config(*, fallback_model: str | None = None, model_max_retries: int = 2) -> Configuration:
    return Configuration(
        main_model="anthropic:claude-sonnet-4-5-20250929",
        writer_model="anthropic:claude-sonnet-4-5-20250929",
        fallback_model=fallback_model,
        model_max_retries=model_max_retries,
        canvas_data_dir=Configuration.from_env().canvas_data_dir,
        cors_origins=["http://localhost:3000"],
    )


class TestShouldRetryModelCall:
    @pytest.mark.parametrize(
        ("exc", "expected"),
        [
            (_StatusError(429), True),
            (_StatusError(529), True),
            (_StatusError(500), True),
            (_StatusError(400), False),
            (ValueError("bad input"), False),
            (TimeoutError("timed out"), True),
            (ConnectionError("connection reset"), True),
        ],
    )
    def test_predicate_matches_expected_retry_decision(
        self, exc: BaseException, expected: bool
    ) -> None:
        assert should_retry_model_call(exc) is expected


class TestBuildModelResilienceMiddleware:
    def test_no_fallback_configured_returns_retry_only(self) -> None:
        cfg = _build_config(fallback_model=None)

        middleware = build_model_resilience_middleware(cfg)

        assert [type(m) for m in middleware] == [ModelRetryMiddleware]

    def test_fallback_configured_prepends_fallback_middleware(self) -> None:
        cfg = _build_config(fallback_model="anthropic:claude-haiku-4-5")

        middleware = build_model_resilience_middleware(cfg)

        assert [type(m) for m in middleware] == [
            ModelFallbackMiddleware,
            ModelRetryMiddleware,
        ]

    def test_retry_middleware_uses_configured_max_retries_and_predicate(self) -> None:
        cfg = _build_config(fallback_model=None, model_max_retries=5)

        middleware = build_model_resilience_middleware(cfg)

        retry_middleware = middleware[0]
        assert isinstance(retry_middleware, ModelRetryMiddleware)
        assert retry_middleware.max_retries == 5
        assert retry_middleware.retry_on is should_retry_model_call
        assert retry_middleware.on_failure == "error"


class _FlakyChatModel(BaseChatModel):
    """Raises a 529-shaped `_StatusError` on its first call, then succeeds."""

    _calls: int = PrivateAttr(default=0)

    @property
    def _llm_type(self) -> str:
        return "flaky-fake-chat-model"

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: object | None = None,
        **kwargs: object,
    ) -> ChatResult:
        self._calls += 1
        if self._calls == 1:
            raise _StatusError(529)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="All set."))])

    @property
    def call_count(self) -> int:
        return self._calls


@pytest.mark.asyncio
async def test_retry_middleware_recovers_from_one_transient_failure() -> None:
    fake_model = _FlakyChatModel()
    cfg = _build_config(fallback_model=None, model_max_retries=2)

    agent = create_canvas_agent(
        model=fake_model,
        tools=[],
        middleware=build_model_resilience_middleware(cfg),
    )

    final_ai_message: AIMessage | None = None
    async for chunk in agent.astream(
        {"messages": [{"role": "user", "content": "Hello"}]},
        stream_mode="updates",
    ):
        for update in chunk.values():
            for message in update.get("messages", []):
                if isinstance(message, AIMessage):
                    final_ai_message = message

    assert fake_model.call_count == 2
    assert final_ai_message is not None
    assert final_ai_message.content == "All set."
