"""The reference server's canvas store — one durable folder per thread.

A thread's canvas lives at ``./canvas-data/<thread_id>/`` (head files +
described commit history). Both the agent tools and the human-save endpoint
write through this single store, which is what makes a hand edit visible to
the agent's next ``read``.
"""

from __future__ import annotations

from langchain_canvas import FileCanvasStore

from .configuration import config

DATA_DIR = config.canvas_data_dir

STORE = FileCanvasStore(DATA_DIR)

# The demo maps one page per thread; the artifact id doubles as the file path.
PAGE_PATH = "index.html"

# The one canonical deck a thread's scratch authoring pipeline
# (`plan_deck`/`write_slide`) creates and edits. Ratio for a scratch deck is
# always 16:9 — only an imported `.pptx` (`open_deck_for_editing`) picks its
# ratio from the source file's declared page size.
DECK_PATH = "deck.slides.html"
DECK_RATIO = "16:9"

# Fixed slide canvas in CSS pixels (16:9).
SLIDE_WIDTH = 1280
SLIDE_HEIGHT = 720


def _slug(title: str, fallback: str) -> str:
    slug = "".join(c if c.isalnum() else "-" for c in title.lower()).strip("-")
    return "-".join(part for part in slug.split("-") if part)[:40] or fallback


def artifact_path(title: str, suffix: str) -> str:
    """Store path for a titled artifact: ``<slug><suffix>``.

    The artifact id doubles as the file path, so reloads and hand-edit saves
    address the same store file the tool wrote.
    """
    return f"{_slug(title, 'artifact')}{suffix}"
