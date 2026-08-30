"""Reference render adapter: headless-Chromium screenshot plus layout metrics.

This is the reference implementation of the SDK's ``RenderSlideAdapter``
protocol (``render_slide(html, *, ratio) -> tuple[metrics, png]``), ported
from ``verify.py::_render`` and parameterized by ``ratio`` instead of the
scratch-authoring pipeline's fixed 1280x720 slide viewport. ``convert_slide``
consumes the metrics half of the return value (feeding
``verify.py::_layout_report``); the deck PPTX exporter's unsupported-effect
raster fallback (a later task) consumes the PNG bytes.

Playwright's sync API refuses to run on an asyncio loop thread, so rendering
runs on a dedicated worker thread — the same single-worker executor pattern
``verify.py`` uses to keep Chromium memory bounded.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

_EXECUTOR = ThreadPoolExecutor(max_workers=1)

# Deck ratio -> viewport in CSS pixels. Mirrors the pixel canvas each ratio
# projects onto in `langchain_canvas.deck.baseline` (16:9 default 1280x720,
# 4:3 at the same width) so a rendered slide sees the same box it was laid
# out against.
_VIEWPORT_FOR_RATIO: dict[str, tuple[int, int]] = {
    "16:9": (1280, 720),
    "4:3": (1280, 960),
}
_DEFAULT_VIEWPORT = (1280, 720)

# Runs inside the rendered slide. Tolerances (4px) forgive sub-pixel rounding.
# Identical to verify.py's _METRICS_JS — kept as its own copy here since the
# two modules serve different consumers (fixed-viewport scratch pipeline vs.
# ratio-aware deck pipeline) and neither is allowed to import the other's
# private helpers across that boundary.
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


def _viewport_for(ratio: str) -> tuple[int, int]:
    return _VIEWPORT_FOR_RATIO.get(ratio, _DEFAULT_VIEWPORT)


def render_slide(html: str, *, ratio: str) -> tuple[dict[str, Any], bytes]:
    """Render ``html`` in headless Chromium at ``ratio``'s viewport.

    Returns ``(metrics, png)``: layout metrics for
    ``verify.py::_layout_report``, and a PNG for a raster export fallback.
    An unrecognized ``ratio`` falls back to the 1280x720 16:9 viewport.
    """
    width, height = _viewport_for(ratio)

    def task() -> tuple[dict[str, Any], bytes]:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": width, "height": height})
            page.set_content(html, wait_until="load")
            metrics = page.evaluate(_METRICS_JS)
            png = page.screenshot(type="png")
            browser.close()
        return metrics, png

    return _EXECUTOR.submit(task).result()
