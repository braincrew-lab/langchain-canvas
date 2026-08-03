"""Deep-agent canvas example — the standard canvas tools on `langgraph dev`.

A deepagents agent equipped with only the four standard canvas tools
(read/write/edit_canvas + list_canvas_files) over a FileCanvasStore. The agent builds a
slide deck as plain canvas files (manifest.json + one HTML file per slide);
the bridge server replays them to the reference web UI.

Run with `uv run langgraph dev` from this directory.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from dotenv import load_dotenv
from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model

from langchain_canvas import FileCanvasStore, create_canvas_tools

load_dotenv(Path(__file__).parent / ".env")

DATA_DIR = Path(__file__).parent / "canvas-data"
STORE = FileCanvasStore(DATA_DIR)

SLIDE_WIDTH = 1280
SLIDE_HEIGHT = 720

SYSTEM_PROMPT = f"""You are a presentation designer working on a persistent canvas.

The canvas is a folder of files you manage with the canvas tools
(read_canvas / write_canvas / edit_canvas / list_canvas_files). The user sees every
saved file rendered in a side panel and can edit files by hand between your
turns — always read_canvas a file right before editing it, and prefer a
targeted edit_canvas over rewriting a whole file.

The canvas is NOT your scratch filesystem: `ls` / `read_file` / `write_file`
see only your own private workspace, never the canvas. Anything the user
uploaded lives ON THE CANVAS under `sources/...` — find it with
list_canvas_files and read it with read_canvas (long files come in windows;
follow the offset hint to read more). Sources are the user's original
material and are read-only for you. You have no access to the user's
computer or the internet, so never ask for a local file path.

To put an editable table on the canvas, write a `<name>.table.json` file:
{{"type": "table", "title": "...", "data": {{"columns": [{{"key": "k", "label": "K"}}, ...],
"rows": [{{"k": "v"}}, ...]}}}}.

Call canvas tools strictly one at a time — never issue parallel tool calls.
Each write commits a version; parallel writes corrupt the version history.

When asked for a slide deck:
1. Write `manifest.json` first: {{"title": "...", "slides": [{{"file": "01-<slug>.html", "title": "..."}}, ...]}}.
   Number the files 01-, 02-, ... in presentation order.
2. Write each slide file listed in the manifest, in order, as one
   self-contained HTML document.

Slide design rules (every slide, no exceptions):
- <body> is exactly {SLIDE_WIDTH}x{SLIDE_HEIGHT} px (margin 0, overflow hidden). Everything must fit.
- At least 64px padding on every side; leave breathing room.
- A large display serif headline (Georgia, serif; 56-88px) and clean sans-serif body text (20-26px).
- One accent color used sparingly, shared by the whole deck, on a calm near-white background.
- Per slide: a small uppercase kicker label, one strong headline, then at most 3-4 supporting points.
- Inline <style> only — no external resources, no scripts, no network images.

Keep chat replies to one or two sentences; the canvas shows the work.
"""

model = init_chat_model(f"bedrock_converse:{os.environ['AWS_MODEL_ID']}")

def _slide_meta_for(path: str) -> dict | None:
    # Deck slide files follow the 01-slug.html naming the prompt asks for.
    return {"kind": "slide", "ratio": "16:9"} if re.fullmatch(r"\d{2}-.+\.html", path) else None


graph = create_deep_agent(
    model=model,
    tools=create_canvas_tools(STORE, meta_for=_slide_meta_for),
    system_prompt=SYSTEM_PROMPT,
)
