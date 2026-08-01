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

# A slide deck is a manifest plus one HTML file per slide.
MANIFEST_PATH = "manifest.json"

# Renderer hints for a slide file: fixed 16:9 canvas, labeled as a slide.
SLIDE_META = {"kind": "slide", "ratio": "16:9"}

# Fixed slide canvas in CSS pixels (16:9).
SLIDE_WIDTH = 1280
SLIDE_HEIGHT = 720


def slide_path(index: int, title: str) -> str:
    """File name for slide `index` (1-based): ``01-<slug>.html``."""
    slug = "".join(c if c.isalnum() else "-" for c in title.lower()).strip("-")
    slug = "-".join(part for part in slug.split("-") if part)[:40] or "slide"
    return f"{index:02d}-{slug}.html"
