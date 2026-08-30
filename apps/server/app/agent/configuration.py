"""Server-wide configuration: env loading, model names, and validation.

Centralizes the settings that were previously scattered as literals in
``build.py``/``tools.py`` (model names) and env reads in ``main.py`` (CORS
origins). Import ``config`` for the process-wide singleton; use
``Configuration.from_env()`` directly in tests that need a fresh instance
built from a monkeypatched environment.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load apps/server/.env (if present) before any field below reads os.environ.
# Does not override variables already set in the process environment.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "anthropic:claude-sonnet-4-5-20250929"
_DEFAULT_CANVAS_DATA_DIR = Path(__file__).resolve().parents[2] / "canvas-data"
_DEFAULT_CORS_ORIGINS = "http://localhost:3000"


@dataclass(frozen=True)
class Configuration:
    """Typed, validated server configuration read from the environment."""

    main_model: str
    writer_model: str
    fallback_model: str | None
    model_max_retries: int
    canvas_data_dir: Path
    cors_origins: list[str]
    deck_batch_size: int = 10
    deck_writer_concurrency: int = 10

    def __post_init__(self) -> None:
        if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Copy apps/server/.env.example to "
                "apps/server/.env and fill in your Anthropic API key."
            )

    def log_banner(self) -> None:
        """Log the one-line startup banner (called from the app lifespan so a
        log handler exists; import-time logging has none under uvicorn)."""
        logger.info(
            "Configuration loaded: main_model=%s writer_model=%s fallback_model=%s "
            "model_max_retries=%s canvas_data_dir=%s cors_origins=%s "
            "deck_batch_size=%s deck_writer_concurrency=%s",
            self.main_model,
            self.writer_model,
            self.fallback_model,
            self.model_max_retries,
            self.canvas_data_dir,
            self.cors_origins,
            self.deck_batch_size,
            self.deck_writer_concurrency,
        )

    @classmethod
    def from_env(cls) -> Configuration:
        """Build a `Configuration` from the current environment."""
        main_model = os.environ.get("MAIN_MODEL", _DEFAULT_MODEL)
        writer_model = os.environ.get("WRITER_MODEL", _DEFAULT_MODEL)
        fallback_model = os.environ.get("FALLBACK_MODEL", "").strip() or None
        model_max_retries = int(os.environ.get("MODEL_MAX_RETRIES", "2"))
        canvas_data_dir = Path(
            os.environ.get("CANVAS_DATA_DIR", str(_DEFAULT_CANVAS_DATA_DIR))
        )
        cors_origins = [
            origin.strip()
            for origin in os.environ.get(
                "CORS_ORIGINS", _DEFAULT_CORS_ORIGINS
            ).split(",")
            if origin.strip()
        ]
        deck_batch_size = int(os.environ.get("DECK_BATCH_SIZE", "10"))
        if deck_batch_size < 1:
            raise ValueError("DECK_BATCH_SIZE must be >= 1")
        deck_writer_concurrency = int(
            os.environ.get("DECK_WRITER_CONCURRENCY", "10")
        )
        if deck_writer_concurrency < 1:
            raise ValueError("DECK_WRITER_CONCURRENCY must be >= 1")
        return cls(
            main_model=main_model,
            writer_model=writer_model,
            fallback_model=fallback_model,
            model_max_retries=model_max_retries,
            canvas_data_dir=canvas_data_dir,
            cors_origins=cors_origins,
            deck_batch_size=deck_batch_size,
            deck_writer_concurrency=deck_writer_concurrency,
        )


config = Configuration.from_env()
