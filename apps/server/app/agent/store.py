"""The reference server's canvas store — one durable folder per thread.

A thread's canvas lives at ``./canvas-data/<thread_id>/`` (head files +
described commit history). Both the agent tools and the human-save endpoint
write through this single store, which is what makes a hand edit visible to
the agent's next ``read``.
"""

from __future__ import annotations

from pathlib import Path

from langchain_canvas import FileCanvasStore

DATA_DIR = Path(__file__).resolve().parents[2] / "canvas-data"

STORE = FileCanvasStore(DATA_DIR)

# The demo maps one page per thread; the artifact id doubles as the file path.
PAGE_PATH = "index.html"
