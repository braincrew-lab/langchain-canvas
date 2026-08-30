"""Assemble the canvas agent for the reference server."""

from __future__ import annotations

from typing import Any

from langchain_canvas import create_canvas_agent
from langgraph.checkpoint.memory import InMemorySaver

from .configuration import Configuration
from .configuration import config as default_config
from .prompt import SYSTEM_PROMPT
from .resilience import build_model_resilience_middleware
from .tools import CANVAS_TOOLS
from .verify import VERIFY_TOOLS


def create_canvas_server_agent(
    checkpointer: Any = None,
    *,
    configuration: Configuration | None = None,
    model: str | Any | None = None,
) -> Any:
    """Build the compiled canvas agent for the reference server.

    Uses an in-memory checkpointer by default so a `thread_id` gives
    short-lived conversation memory. Swap in a persistent checkpointer
    (Postgres, Redis) for production and durable version history.

    Args:
        checkpointer: LangGraph checkpointer. Defaults to a fresh
            `InMemorySaver()` when not provided.
        configuration: Server `Configuration` to read the main model and
            resilience settings from. Defaults to the process-wide `config`
            singleton.
        model: Override for the model the agent runs — a provider-prefixed
            string or an initialized chat model (e.g. a fake model in
            tests). Defaults to `configuration.main_model`.
    """
    cfg = configuration or default_config
    return create_canvas_agent(
        model=model if model is not None else cfg.main_model,
        tools=CANVAS_TOOLS + VERIFY_TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=checkpointer or InMemorySaver(),
        middleware=build_model_resilience_middleware(cfg),
    )
