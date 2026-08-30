"""Tests for the `/api/chat` route: request validation and SSE streaming.

Uses `httpx.ASGITransport` (which does not run FastAPI's lifespan) so each
test sets `app.state.agent` directly to a `create_canvas_server_agent`
compiled with a `GenericFakeChatModel` — real streaming plumbing
(`sse_from_agent`), no network call. A separate test exercises `lifespan`
itself to prove startup builds `app.state.agent` and shutdown calls
`render.shutdown_browser()`.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from app.agent.agent import create_canvas_server_agent
from app.agent.configuration import Configuration
from app.main import app, lifespan
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage


def _build_config() -> Configuration:
    return Configuration(
        main_model="anthropic:claude-sonnet-4-5-20250929",
        writer_model="anthropic:claude-sonnet-4-5-20250929",
        fallback_model=None,
        model_max_retries=2,
        canvas_data_dir=Configuration.from_env().canvas_data_dir,
        cors_origins=["http://localhost:3000"],
    )


def _fake_agent() -> Any:
    """A compiled canvas agent backed by a fake model — no network call."""
    fake_model = GenericFakeChatModel(messages=iter([AIMessage(content="Hi there")]))
    return create_canvas_server_agent(model=fake_model, configuration=_build_config())


@pytest.fixture
def client() -> httpx.AsyncClient:
    app.state.agent = _fake_agent()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


class TestChatRoute:
    async def test_post_chat_streams_frames_ending_in_done(
        self, client: httpx.AsyncClient
    ) -> None:
        async with client, client.stream(
            "POST",
            "/api/chat",
            json={"thread_id": "thread-1", "message": "Hello there"},
        ) as response:
            assert response.status_code == 200
            body = ""
            async for chunk in response.aiter_text():
                body += chunk

        frames = [line for line in body.split("\n\n") if line.strip()]
        assert frames, "expected at least one SSE frame"
        assert '"type": "done"' in frames[-1] or '"type":"done"' in frames[-1]

    async def test_post_chat_empty_message_returns_422(
        self, client: httpx.AsyncClient
    ) -> None:
        async with client:
            response = await client.post(
                "/api/chat", json={"thread_id": "thread-1", "message": ""}
            )
        assert response.status_code == 422

    async def test_post_chat_empty_thread_id_returns_422(
        self, client: httpx.AsyncClient
    ) -> None:
        async with client:
            response = await client.post(
                "/api/chat", json={"thread_id": "", "message": "Hello"}
            )
        assert response.status_code == 422

    async def test_post_chat_with_selections_streams_frames(
        self, client: httpx.AsyncClient
    ) -> None:
        """A request with a `selections` entry exercises `_with_selections`."""
        payload = {
            "thread_id": "thread-1",
            "message": "Make this bold",
            "selections": [
                {
                    "artifactId": "page.html",
                    "cid": "c1",
                    "selector": "#title",
                    "tag": "h1",
                }
            ],
        }
        async with client, client.stream(
            "POST", "/api/chat", json=payload
        ) as response:
            assert response.status_code == 200
            body = ""
            async for chunk in response.aiter_text():
                body += chunk

        frames = [line for line in body.split("\n\n") if line.strip()]
        assert frames, "expected at least one SSE frame"

    async def test_get_health_returns_ok(self, client: httpx.AsyncClient) -> None:
        async with client:
            response = await client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class _FakeShutdownBrowser:
    """Typed call-recording stand-in for `render.shutdown_browser`."""

    def __init__(self) -> None:
        self.call_count = 0

    def __call__(self) -> None:
        self.call_count += 1


class TestLifespan:
    async def test_lifespan_builds_agent_and_shuts_down_browser(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_agent = object()

        def _fake_create_canvas_server_agent(checkpointer: Any = None, **_: Any) -> Any:
            return fake_agent

        monkeypatch.setattr(
            "app.main.create_canvas_server_agent", _fake_create_canvas_server_agent
        )
        fake_shutdown = _FakeShutdownBrowser()
        monkeypatch.setattr("app.main.render.shutdown_browser", fake_shutdown)

        async with lifespan(app):
            assert app.state.agent is fake_agent

        assert fake_shutdown.call_count == 1

    async def test_lifespan_swallows_shutdown_browser_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A raising `shutdown_browser` must not prevent lifespan from exiting cleanly."""
        fake_agent = object()

        def _fake_create_canvas_server_agent(checkpointer: Any = None, **_: Any) -> Any:
            return fake_agent

        def _raising_shutdown_browser() -> None:
            raise RuntimeError("Chromium already closed")

        monkeypatch.setattr(
            "app.main.create_canvas_server_agent", _fake_create_canvas_server_agent
        )
        monkeypatch.setattr("app.main.render.shutdown_browser", _raising_shutdown_browser)

        async with lifespan(app):
            assert app.state.agent is fake_agent
