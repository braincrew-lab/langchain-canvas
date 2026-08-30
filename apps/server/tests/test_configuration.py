"""Tests for `app.agent.configuration.Configuration`.

Every test builds a fresh `Configuration` via `from_env()` after
monkeypatching the environment — none of them rely on the module-level
`config` singleton, so they stay isolated from import order and from the
`ANTHROPIC_API_KEY=test` default `conftest.py` sets for the rest of the
suite.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.agent.configuration import Configuration


def test_from_env_missing_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        Configuration.from_env()


def test_from_env_empty_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")

    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        Configuration.from_env()


def test_from_env_defaults_resolve(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("MAIN_MODEL", raising=False)
    monkeypatch.delenv("WRITER_MODEL", raising=False)
    monkeypatch.delenv("FALLBACK_MODEL", raising=False)
    monkeypatch.delenv("MODEL_MAX_RETRIES", raising=False)
    monkeypatch.delenv("CANVAS_DATA_DIR", raising=False)
    monkeypatch.delenv("CORS_ORIGINS", raising=False)

    config = Configuration.from_env()

    assert config.main_model == "anthropic:claude-sonnet-4-5-20250929"
    assert config.writer_model == "anthropic:claude-sonnet-4-5-20250929"
    assert config.fallback_model is None
    assert config.model_max_retries == 2
    assert config.canvas_data_dir.name == "canvas-data"
    assert config.cors_origins == ["http://localhost:3000"]


def test_from_env_cors_origins_parses_comma_separated_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:3000,http://localhost:3005")

    config = Configuration.from_env()

    assert config.cors_origins == [
        "http://localhost:3000",
        "http://localhost:3005",
    ]


def test_from_env_model_max_retries_parses_int(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MODEL_MAX_RETRIES", "5")

    config = Configuration.from_env()

    assert config.model_max_retries == 5
    assert isinstance(config.model_max_retries, int)


def test_from_env_reads_main_writer_fallback_and_data_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MAIN_MODEL", "anthropic:claude-opus-5")
    monkeypatch.setenv("WRITER_MODEL", "anthropic:claude-haiku-4-5")
    monkeypatch.setenv("FALLBACK_MODEL", "anthropic:claude-sonnet-4-5-20250929")
    monkeypatch.setenv("CANVAS_DATA_DIR", str(tmp_path))

    config = Configuration.from_env()

    assert config.main_model == "anthropic:claude-opus-5"
    assert config.writer_model == "anthropic:claude-haiku-4-5"
    assert config.fallback_model == "anthropic:claude-sonnet-4-5-20250929"
    assert config.canvas_data_dir == tmp_path
