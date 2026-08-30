"""Model resilience middleware: retry-with-backoff and fallback-model switching.

The Anthropic SDK's own ``max_retries`` only covers the transport layer of a
single model client; it does not retry through LangChain's agent middleware
stack and has no notion of switching to a different model. This module adds
that layer on top of `create_canvas_agent`, so a transient 529/429/connection
reset on the main model gets retried with backoff, and — if a fallback model
is configured — the agent switches models instead of surfacing an ``error``
frame to the chat stream.
"""

from __future__ import annotations

from langchain.agents.middleware import (
    AgentMiddleware,
    ModelFallbackMiddleware,
    ModelRetryMiddleware,
)

from .configuration import Configuration
from .configuration import config as default_config

# Exception class names (Anthropic SDK, its httpx transport, and stdlib
# equivalents) that indicate a connection or timeout failure rather than a
# well-formed API error with a status code. Matched by name — not by
# `isinstance` — so this stays correct even if the Anthropic/httpx packages
# are not importable in a given environment (e.g. this module under test).
_RETRYABLE_EXCEPTION_NAMES = frozenset(
    {
        "APIConnectionError",
        "APITimeoutError",
        "ConnectError",
        "ConnectTimeout",
        "ReadTimeout",
        "ConnectionError",
        "TimeoutError",
    }
)


def should_retry_model_call(exc: BaseException) -> bool:
    """Decide whether a model-call failure is transient and worth retrying.

    Retries HTTP 429 (rate limited) and any 5xx status (server error,
    including Anthropic's 529 "overloaded"), read via the ``status_code``
    attribute the Anthropic SDK's `APIStatusError` (and compatible errors)
    expose. Falls back to matching connection/timeout exceptions by class
    name. Everything else (e.g. 400/401, `ValueError`) is not retried.
    """
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int) and (status_code == 429 or status_code >= 500):
        return True
    return type(exc).__name__ in _RETRYABLE_EXCEPTION_NAMES


def build_model_resilience_middleware(
    configuration: Configuration | None = None,
) -> list[AgentMiddleware]:
    """Build the resilience middleware stack for `create_canvas_agent`.

    Prepends a `ModelFallbackMiddleware` only when `fallback_model` is
    configured. Middleware order matters: `ModelFallbackMiddleware` must wrap
    `ModelRetryMiddleware` (i.e. come first in the list) so that every model
    attempt — the primary model and each configured fallback — gets its own
    full retry-with-backoff treatment before the next model in the fallback
    chain is tried.
    """
    cfg = configuration or default_config
    middleware: list[AgentMiddleware] = []
    if cfg.fallback_model:
        middleware.append(ModelFallbackMiddleware(cfg.fallback_model))
    middleware.append(
        ModelRetryMiddleware(
            max_retries=cfg.model_max_retries,
            retry_on=should_retry_model_call,
            on_failure="error",
        )
    )
    return middleware
