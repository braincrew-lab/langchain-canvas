"""Slide verification tools — mechanical layout check and visual screenshot.

Both render the saved head file in headless Chromium at the slide's fixed
1280x720 viewport. ``check_slide_layout`` reports mechanical problems
(overflow, clipped elements, broken images, large empty areas) as
ERROR/WARNING lines the agent can fix; ``screenshot_slide`` returns the
rendered image so the agent can judge the design with its own eyes.

Playwright's sync API refuses to run on an asyncio loop thread, so all
rendering runs on a dedicated worker thread.
"""

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from langchain.tools import ToolRuntime, tool

from langchain_canvas.store import CanvasFileNotFoundError

from .store import DATA_DIR, SLIDE_HEIGHT, SLIDE_WIDTH, STORE
from .tools import _thread_id

# One browser task at a time — slides render in well under a second, and a
# single worker keeps Chromium memory bounded.
_EXECUTOR = ThreadPoolExecutor(max_workers=1)

# Runs inside the rendered slide. Tolerances (4px) forgive sub-pixel rounding.
_METRICS_JS = """
() => {
  const W = innerWidth, H = innerHeight;
  const doc = document.scrollingElement;
  const off = [];
  let maxBottom = 0;
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    maxBottom = Math.max(maxBottom, Math.min(r.bottom, doc.scrollHeight));
    if ((r.right > W + 4 || r.bottom > H + 4 || r.left < -4 || r.top < -4) && off.length < 5)
      off.push(`<${el.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)} at (${Math.round(r.left)}, ${Math.round(r.top)})`);
  }
  return {
    overflowX: Math.max(0, doc.scrollWidth - W),
    overflowY: Math.max(0, doc.scrollHeight - H),
    offCanvas: off,
    maxBottom,
    textLength: document.body.innerText.trim().length,
    brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
  };
}
"""


def _render(html: str) -> tuple[dict[str, Any], bytes]:
    """Render on the worker thread; return layout metrics and a PNG."""

    def task() -> tuple[dict[str, Any], bytes]:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": SLIDE_WIDTH, "height": SLIDE_HEIGHT})
            page.set_content(html, wait_until="load")
            metrics = page.evaluate(_METRICS_JS)
            png = page.screenshot(type="png")
            browser.close()
        return metrics, png

    return _EXECUTOR.submit(task).result()


def _layout_report(file: str, m: dict[str, Any]) -> str:
    errors: list[str] = []
    warnings: list[str] = []
    if m["overflowX"] or m["overflowY"]:
        errors.append(
            f"content overflows the {SLIDE_WIDTH}x{SLIDE_HEIGHT} slide by "
            f"{m['overflowX']}px horizontally / {m['overflowY']}px vertically — everything must fit"
        )
    for el in m["offCanvas"]:
        errors.append(f"element extends outside the slide: {el}")
    if m["brokenImages"]:
        warnings.append(f"{m['brokenImages']} image(s) failed to load — slides must be self-contained")
    if m["textLength"] < 20:
        warnings.append("almost no text content rendered")
    elif m["maxBottom"] < SLIDE_HEIGHT * 0.55:
        warnings.append(
            f"content ends at y={round(m['maxBottom'])}px — the bottom of the slide looks empty; "
            "balance the layout or enlarge the content"
        )
    lines = [f"LAYOUT CHECK {file}: {len(errors)} error(s), {len(warnings)} warning(s)"]
    lines += [f"ERROR: {e}" for e in errors]
    lines += [f"WARNING: {w}" for w in warnings]
    if not errors and not warnings:
        lines.append("All clear.")
    return "\n".join(lines)


@tool
def check_slide_layout(file: str, runtime: ToolRuntime) -> str:
    """Render a saved slide file at 1280x720 and report layout problems.

    Run this after every write_slide or edit of a slide. Fix every ERROR
    (with read_page + edit_page on the file) and re-check until it reports
    0 errors. Treat warnings as design advice.
    """
    try:
        html = STORE.read(_thread_id(runtime), file).content
    except CanvasFileNotFoundError:
        return f"No file {file} exists yet. Use plan_deck / write_slide first."
    metrics, _ = _render(html)
    return _layout_report(file, metrics)


@tool
def screenshot_slide(file: str, runtime: ToolRuntime) -> list[dict[str, Any]]:
    """Render a saved slide file and return its screenshot for visual review.

    Use after check_slide_layout passes, to confirm the slide actually looks
    good: readable text, balanced composition, consistent style with the rest
    of the deck. If it looks wrong, fix it with read_page + edit_page.
    """
    thread_id = _thread_id(runtime)
    try:
        html = STORE.read(thread_id, file).content
    except CanvasFileNotFoundError:
        return [{"type": "text", "text": f"No file {file} exists yet."}]
    _, png = _render(html)

    shots_dir = DATA_DIR / thread_id / "screenshots"
    shots_dir.mkdir(parents=True, exist_ok=True)
    (shots_dir / f"{file}.png").write_bytes(png)

    return [
        {"type": "text", "text": f"Screenshot of {file} ({SLIDE_WIDTH}x{SLIDE_HEIGHT}):"},
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.b64encode(png).decode("ascii"),
            },
        },
    ]


VERIFY_TOOLS = [check_slide_layout, screenshot_slide]
