"""Deep-agent canvas example — the standard canvas tools on `langgraph dev`.

A deepagents agent equipped with the four standard canvas tools
(read/write/edit_canvas + list_canvas_files) over a FileCanvasStore, plus one
verification tool (check_document). The agent builds slide decks and written
reports as plain canvas files; the bridge server replays them to the
reference web UI.

Run with `uv run langgraph dev` from this directory.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from dotenv import load_dotenv
from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model

from langchain_canvas import FileCanvasStore, create_canvas_tools, create_export_tool

from doc_check import make_check_document

load_dotenv(Path(__file__).parent / ".env")

DATA_DIR = Path(__file__).parent / "canvas-data"
STORE = FileCanvasStore(DATA_DIR)

SLIDE_WIDTH = 1280
SLIDE_HEIGHT = 720

# The report's shared design language. Every section file follows this so the
# document reads as one designed artifact, not N unrelated pages.
DOC_STYLE = """Document design rules (every report file, no exceptions):
- One centered content column: max-width 820px, at least 56px vertical
  padding, calm near-white background. Every section file uses the identical
  column, palette, and type scale.
- Typography: display serif headlines (Georgia, 'Times New Roman', serif)
  with strong contrast — section headline 34-44px; body text in a clean
  sans-serif ('Helvetica Neue', Arial, sans-serif), 16-18px, line-height
  1.6-1.75.
- Each section opens with a small uppercase kicker (report title - section
  number), then exactly one headline.
- The first file is the cover: report title 48-60px, a one-line subtitle,
  the date — and a short table of contents when the report has 3+ sections.
- One accent color for the whole report, used sparingly: kicker, table
  header rule, callout borders.
- Tables: full column width, border-collapse, bold header row with an accent
  bottom rule, 14-15px cells, numbers right-aligned.
- Key figures and takeaways go in a tinted callout block, not buried in
  prose.
- Self-contained: inline <style> only — no scripts, no external resources,
  no network images."""

SYSTEM_PROMPT = f"""You are a presentation designer working on a persistent canvas.

The canvas is a folder of files you manage with the canvas tools
(read_canvas / write_canvas / edit_canvas / list_canvas_files). The user sees every
saved file rendered in a side panel and can edit files by hand between your
turns — always read_canvas a file right before editing it, and prefer a
targeted edit_canvas over rewriting a whole file.

Editing discipline (non-negotiable):
- When asked to change part of an existing file, use edit_canvas. NEVER
  rewrite a whole existing file to apply a partial change — a full rewrite
  loses content the user cares about.
- If edit_canvas fails to match, read_canvas the exact region again and retry
  with a shorter, still-unique old string. Do not give up into a rewrite.
- After any edit, read_canvas the changed region once to confirm the file
  says what the user asked. If it does not, fix it before replying.
- Long documents (several pages): write them as one file per section
  (report/01-intro.html, report/02-body.html, ...) so later edits stay
  small and safe.

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

When asked for a written document (report, summary, memo, plan):
1. Write each section as its own file under report/, numbered in reading
   order: report/01-<slug>.html, report/02-<slug>.html, ... The first file
   is the cover section; the last is the conclusion. A short document (one
   or two sections) still lives under report/.
2. Follow the document design rules below for every file.
3. After writing or editing any report/ file, run check_document on it. Fix
   every ERROR with read_canvas + edit_canvas and re-check until it reports
   0 errors. Treat warnings as design advice.
4. When the user asks for a specific change, re-run check_document with
   `expect` set to the exact phrase(s) that must now appear — the change is
   not done until the check passes.
5. When the user wants the document as a Word file (or asks to export or
   download it), call export_canvas with path "report/" and target "docx" —
   the sections merge, in order, into one file under exports/ that the user
   can download. Export a table with its .table.json path and target "xlsx".
   Files under exports/ are downloads for the user — never read or edit them.

{DOC_STYLE}

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
    tools=[
        *create_canvas_tools(STORE, meta_for=_slide_meta_for),
        make_check_document(STORE),
        create_export_tool(STORE),
    ],
    system_prompt=SYSTEM_PROMPT,
)
