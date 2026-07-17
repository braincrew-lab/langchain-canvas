"""Streaming bridges from an agent run to a client transport."""

from .sse import sse_from_agent

__all__ = ["sse_from_agent"]
