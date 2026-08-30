"""Tests for `app.agent.agent.create_canvas_server_agent`.

Uses `GenericFakeChatModel` so the factory can be exercised end-to-end
without ever hitting the network, and spies on the underlying
`langchain_canvas.agent.create_agent` call to assert on the resolved
middleware chain — `create_canvas_agent`'s compiled graph does not expose
its middleware list directly (see `packages/canvas-py/src/langchain_canvas
/agent.py`), so the call-argument spy is the only reliable inspection
point.
"""

from __future__ import annotations

from typing import Any

import pytest
from app.agent.agent import create_canvas_server_agent
from app.agent.configuration import Configuration
from langchain.agents.middleware import ModelFallbackMiddleware, ModelRetryMiddleware
from langchain_canvas.history_repair import repair_tool_history
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel


def _build_config(*, fallback_model: str | None = None) -> Configuration:
    return Configuration(
        main_model="anthropic:claude-sonnet-4-5-20250929",
        writer_model="anthropic:claude-sonnet-4-5-20250929",
        fallback_model=fallback_model,
        model_max_retries=2,
        canvas_data_dir=Configuration.from_env().canvas_data_dir,
        cors_origins=["http://localhost:3000"],
    )


def _capture_create_agent_kwargs(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Spy on `langchain_canvas.agent.create_agent`, recording its kwargs."""
    captured: dict[str, Any] = {}
    real_create_agent = __import__(
        "langchain_canvas.agent", fromlist=["create_agent"]
    ).create_agent

    def _spy(*args: Any, **kwargs: Any) -> Any:
        captured["args"] = args
        captured["kwargs"] = kwargs
        return real_create_agent(*args, **kwargs)

    monkeypatch.setattr("langchain_canvas.agent.create_agent", _spy)
    return captured


class TestCreateCanvasServerAgent:
    def test_factory_compiles_with_a_fake_model_without_network(self) -> None:
        fake_model = GenericFakeChatModel(messages=iter([]))
        cfg = _build_config(fallback_model=None)

        agent = create_canvas_server_agent(model=fake_model, configuration=cfg)

        assert agent is not None

    def test_middleware_chain_contains_repair_history_and_retry(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = _capture_create_agent_kwargs(monkeypatch)
        fake_model = GenericFakeChatModel(messages=iter([]))
        cfg = _build_config(fallback_model=None)

        create_canvas_server_agent(model=fake_model, configuration=cfg)

        middleware = captured["kwargs"]["middleware"]
        assert any(isinstance(m, type(repair_tool_history)) for m in middleware)
        assert any(isinstance(m, ModelRetryMiddleware) for m in middleware)

    def test_fallback_model_adds_fallback_middleware(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = _capture_create_agent_kwargs(monkeypatch)
        fake_model = GenericFakeChatModel(messages=iter([]))
        cfg = _build_config(fallback_model="anthropic:claude-haiku-4-5")

        create_canvas_server_agent(model=fake_model, configuration=cfg)

        middleware = captured["kwargs"]["middleware"]
        assert any(isinstance(m, ModelFallbackMiddleware) for m in middleware)

    def test_defaults_to_in_memory_checkpointer_when_none_given(self) -> None:
        fake_model = GenericFakeChatModel(messages=iter([]))
        cfg = _build_config(fallback_model=None)

        agent = create_canvas_server_agent(model=fake_model, configuration=cfg)

        assert agent.checkpointer is not None

    def test_uses_configured_main_model_when_no_model_override_given(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = _capture_create_agent_kwargs(monkeypatch)
        cfg = _build_config(fallback_model=None)

        create_canvas_server_agent(configuration=cfg)

        assert captured["kwargs"]["model"] == cfg.main_model
