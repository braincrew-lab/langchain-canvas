"""Shared pytest fixtures for the reference server's test suite.

Sets a placeholder ``ANTHROPIC_API_KEY`` before any test module imports
``app.agent.configuration`` (whose module-level ``config`` singleton raises
if the key is missing), so the whole suite can import that module without
requiring a real key.
"""

from __future__ import annotations

import os

os.environ.setdefault("ANTHROPIC_API_KEY", "test")
