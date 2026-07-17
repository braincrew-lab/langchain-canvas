"""`create_canvas_agent` — a thin wrapper over LangChain's `create_agent`.

It adds nothing to the agent's *runtime* behaviour (the canvas is driven purely
by tools calling `Canvas`); its only job is to append guidance that teaches the
model *when* to reach for a canvas-emitting tool instead of answering in prose.
Everything `create_agent` accepts is forwarded verbatim.
"""

from __future__ import annotations

from typing import Any, Callable, Sequence

from langchain.agents import create_agent

CANVAS_GUIDANCE = """
You can render rich artifacts on a side canvas by calling the appropriate tools
(documents, charts, and so on). Prefer the canvas over long inline answers when
the user asks for something substantial or visual:

- Reports, drafts, essays, structured explanations -> a document artifact.
- Comparisons, trends, distributions, anything numeric -> a chart artifact.

Keep your chat reply short — a one or two sentence summary that points at the
canvas. Do not paste the full artifact contents back into the chat.
""".strip()


def create_canvas_agent(
    model: str | Any,
    tools: Sequence[Callable[..., Any] | Any] | None = None,
    *,
    system_prompt: str | None = None,
    **kwargs: Any,
) -> Any:
    """Build a canvas-aware agent.

    Args:
        model: A provider-prefixed model string (e.g. ``"anthropic:claude-..."``)
            or an initialized ``BaseChatModel``.
        tools: Canvas-emitting (and ordinary) tools the agent may call.
        system_prompt: Your domain instructions. Canvas guidance is appended.
        **kwargs: Forwarded to ``create_agent`` (``middleware``, ``checkpointer``,
            ``response_format``, ``store``, ...).

    Returns:
        A compiled LangGraph agent; stream it with ``langchain_canvas.sse_from_agent``.
    """
    prompt = CANVAS_GUIDANCE if not system_prompt else f"{system_prompt}\n\n{CANVAS_GUIDANCE}"
    return create_agent(
        model=model,
        tools=list(tools or []),
        system_prompt=prompt,
        **kwargs,
    )
