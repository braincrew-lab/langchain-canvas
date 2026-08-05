"""Document verification tool — mechanical checks for canvas report files.

``check_document`` renders a saved ``report/`` file in headless Chromium at
the document column width and reports problems as ERROR/WARNING lines the
agent can fix: horizontal overflow, external resources (documents must be
self-contained), missing requested content (``expect`` phrases), broken
images, missing headings, and too-small body text. The agent's loop is
write -> check -> fix until the check reports 0 errors.

Playwright's sync API refuses to run on an asyncio loop thread, so all
rendering runs on a dedicated worker thread.
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from langchain.tools import ToolRuntime, tool

from langchain_canvas.store import CanvasFileNotFoundError, CanvasStore

# Width the checks render at — roughly the web panel's document column.
DOC_WIDTH = 960
DOC_HEIGHT = 720

# One browser task at a time keeps Chromium memory bounded.
_EXECUTOR = ThreadPoolExecutor(max_workers=1)

# Runs inside the rendered document. The 4px tolerance forgives sub-pixel
# rounding; `text` comes back so requested phrases can be matched in Python.
_METRICS_JS = """
() => {
  const W = innerWidth;
  const doc = document.scrollingElement;
  const external = [];
  for (const el of document.querySelectorAll("script, iframe, link[rel='stylesheet']"))
    if (external.length < 5) external.push(`<${el.tagName.toLowerCase()}>`);
  for (const img of document.images)
    if (/^https?:/i.test(img.getAttribute("src") || "") && external.length < 5)
      external.push(`<img src="${img.getAttribute("src").slice(0, 60)}">`);
  let smallText = 0;
  for (const el of document.querySelectorAll("p, li, td"))
    // Only substantial prose counts — short labels (kickers, captions,
    // dates) are legitimately small.
    if (el.innerText.trim().length > 80 && parseFloat(getComputedStyle(el).fontSize) < 14) smallText++;
  return {
    overflowX: Math.max(0, doc.scrollWidth - W),
    external,
    brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
    headings: document.querySelectorAll("h1, h2, h3").length,
    smallText,
    textLength: document.body.innerText.trim().length,
    text: document.body.innerText,
  };
}
"""


def render_metrics(html: str) -> dict[str, Any]:
    """Render on the worker thread; return document metrics."""

    def task() -> dict[str, Any]:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": DOC_WIDTH, "height": DOC_HEIGHT})
            page.set_content(html, wait_until="load")
            metrics: dict[str, Any] = page.evaluate(_METRICS_JS)
            browser.close()
        return metrics

    return _EXECUTOR.submit(task).result()


def _normalized(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def missing_phrases(text: str, expect: list[str] | None) -> list[str]:
    """The expected phrases that do not appear in the rendered text.

    Matching is whitespace-insensitive: a phrase wrapped across lines in the
    document still counts as present.
    """
    if not expect:
        return []
    haystack = _normalized(text)
    return [phrase for phrase in expect if _normalized(phrase) not in haystack]


def document_report(file: str, m: dict[str, Any], missing: list[str]) -> str:
    errors: list[str] = []
    warnings: list[str] = []
    if m["overflowX"] > 4:
        errors.append(
            f"content overflows the {DOC_WIDTH}px document column by {m['overflowX']}px "
            "horizontally — wide tables or blocks must fit the column"
        )
    for ref in m["external"]:
        errors.append(
            f"external resource {ref} — documents must be self-contained (inline <style> only)"
        )
    for phrase in missing:
        errors.append(f'requested content not found in the rendered text: "{phrase}"')
    if m["brokenImages"]:
        warnings.append(f"{m['brokenImages']} image(s) failed to load — embed images as data: URIs")
    if m["textLength"] < 40:
        warnings.append("almost no text content rendered")
    if not m["headings"]:
        warnings.append("no heading — every section opens with a kicker and one headline")
    if m["smallText"]:
        warnings.append(f"{m['smallText']} text block(s) under 14px — body text should be 16-18px")
    lines = [f"DOCUMENT CHECK {file}: {len(errors)} error(s), {len(warnings)} warning(s)"]
    lines += [f"ERROR: {e}" for e in errors]
    lines += [f"WARNING: {w}" for w in warnings]
    if not errors and not warnings:
        lines.append("All clear.")
    return "\n".join(lines)


def _canvas_scope(runtime: ToolRuntime) -> str:
    # Same precedence the standard canvas tools use for the common case:
    # configurable.canvas_id, then configurable.thread_id.
    configurable: dict[str, Any] = (runtime.config or {}).get("configurable", {})
    for key in ("canvas_id", "thread_id"):
        if configurable.get(key):
            return str(configurable[key])
    raise ValueError("No canvas id: run with a `thread_id`.")


def make_check_document(store: CanvasStore) -> Any:
    """Build the ``check_document`` tool over ``store``."""

    @tool
    def check_document(file: str, runtime: ToolRuntime, expect: list[str] | None = None) -> str:
        """Render a saved document file and report mechanical problems.

        Run this after writing or editing any ``report/`` file. Fix every
        ERROR with read_canvas + edit_canvas and re-check until it reports
        0 errors; treat warnings as design advice. After a change the user
        asked for, pass ``expect`` — the exact phrase(s) that must now appear
        in the document — to verify the request actually landed.
        """
        if not file.endswith(".html"):
            return "check_document verifies .html document files only."
        try:
            html = store.read(_canvas_scope(runtime), file).content
        except CanvasFileNotFoundError:
            return f"No file {file} exists yet. Write it first with write_canvas."
        metrics = render_metrics(html)
        return document_report(file, metrics, missing_phrases(metrics["text"], expect))

    return check_document
