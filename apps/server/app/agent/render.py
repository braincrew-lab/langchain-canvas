"""Reference render adapter: shared headless-Chromium screenshot plus layout metrics.

This is the reference implementation of the SDK's ``RenderSlideAdapter``
protocol (``render_slide(html, *, ratio) -> tuple[metrics, png]``), ported
from ``verify.py::_render`` and parameterized by ``ratio`` instead of the
scratch-authoring pipeline's fixed 1280x720 slide viewport. ``convert_slide``
consumes the metrics half of the return value (feeding
``verify.py::_layout_report``); the deck PPTX exporter's unsupported-effect
raster fallback (a later task) consumes the PNG bytes. ``verify.py``'s own
``check_slide_layout``/``screenshot_slide`` tools reuse ``render_slide``
directly rather than keeping a second Chromium adapter.

Playwright's sync API refuses to run on an asyncio loop thread, so rendering
runs on a dedicated single-worker executor — and since that worker is the
only thread that ever touches Playwright, one Chromium instance is launched
lazily on first use and cached for the life of the process instead of being
relaunched on every render. ``shutdown_browser()`` closes it (for a FastAPI
lifespan shutdown hook, once one exists); a Playwright failure mid-render
drops the cached browser so the next render relaunches cleanly instead of
failing forever.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any

logger = logging.getLogger(__name__)

_EXECUTOR = ThreadPoolExecutor(max_workers=1)

# Cached Playwright/Chromium handles. Read and written ONLY from tasks running
# on `_EXECUTOR`'s single worker thread — Playwright's sync API is thread-
# bound, and because the executor has exactly one worker, every task that
# touches these runs on that same thread in sequence, so no lock is needed.
_playwright: Any = None
_browser: Any = None

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
# Shared by verify.py's `_layout_report` — the single copy this module owns.
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


def viewport_for_ratio(ratio: str) -> tuple[int, int]:
    """The CSS pixel viewport ``render_slide`` uses to render ``ratio``.

    Public accessor for callers (``verify.py``'s layout report) that need to
    describe the viewport a render used without duplicating the ratio table.
    """
    return _viewport_for(ratio)


def _get_browser() -> Any:
    """Return the cached Chromium browser, launching it on first use.

    Must only be called from ``_EXECUTOR``'s worker thread.
    """
    global _playwright, _browser
    if _browser is None:
        from playwright.sync_api import sync_playwright

        _playwright = sync_playwright().start()
        _browser = _playwright.chromium.launch()
    return _browser


def _drop_browser() -> None:
    """Discard the cached browser/Playwright handles so the next render
    relaunches them from scratch. Safe to call when nothing was launched."""
    global _playwright, _browser
    if _browser is not None:
        try:
            _browser.close()
        except Exception:
            logger.debug("render: error closing cached Chromium browser", exc_info=True)
    if _playwright is not None:
        try:
            _playwright.stop()
        except Exception:
            logger.debug("render: error stopping cached Playwright instance", exc_info=True)
    _browser = None
    _playwright = None


def _render_task(html: str, width: int, height: int) -> tuple[dict[str, Any], bytes]:
    try:
        browser = _get_browser()
        page = browser.new_page(viewport={"width": width, "height": height})
        try:
            page.set_content(html, wait_until="load")
            metrics = page.evaluate(_METRICS_JS)
            png = page.screenshot(type="png")
        finally:
            page.close()
        return metrics, png
    except Exception:
        # A Playwright failure may leave the cached browser in a bad state
        # (crashed renderer, closed connection) — drop it so the next render
        # relaunches cleanly instead of failing on every subsequent call.
        _drop_browser()
        raise


def render_slide(html: str, *, ratio: str) -> tuple[dict[str, Any], bytes]:
    """Render ``html`` in the shared headless Chromium at ``ratio``'s viewport.

    Returns ``(metrics, png)``: layout metrics for
    ``verify.py::_layout_report``, and a PNG for a raster export fallback.
    An unrecognized ``ratio`` falls back to the 1280x720 16:9 viewport.
    Raises on a Playwright failure (the cached browser is dropped first so
    the next call relaunches) — callers are responsible for turning that
    into a tool-boundary ``"Error: ..."`` result.
    """
    width, height = _viewport_for(ratio)
    return _EXECUTOR.submit(_render_task, html, width, height).result()


def shutdown_browser() -> None:
    """Close the cached browser and stop Playwright, if either was launched.

    Safe to call even when nothing was ever rendered. Intended for a FastAPI
    lifespan shutdown hook so the reference server does not leak a Chromium
    process on exit.
    """
    _EXECUTOR.submit(_drop_browser).result()
