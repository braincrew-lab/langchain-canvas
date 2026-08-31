"""Reference render adapter: shared headless-Chromium screenshot plus layout metrics.

This is the reference implementation of the SDK's ``RenderSlideAdapter``
protocol (``render_slide(html, *, ratio) -> tuple[metrics, png]``), ported
from ``verify.py::_render`` and parameterized by ``ratio`` instead of the
scratch-authoring pipeline's fixed 1280x720 slide viewport. ``convert_slide``
consumes the metrics half of the return value (feeding
``verify.py::_layout_report``). Visual QA consumes the PNG bytes; PPTX export
uses DOM measurements from ``measure_slide`` and never a page screenshot. ``verify.py``'s own
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

import base64
import logging
import math
import re
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

# Keep the same 1280px design width as the stage, including portrait PDFs.
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
  const visibleText = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, el = node.parentElement;
    if (!el || el.closest('style,script')) continue;
    const r = document.createRange(); r.selectNodeContents(node);
    const bounds = r.getBoundingClientRect();
    let shown = bounds.width > 0 && bounds.height > 0;
    for (let parent = el; parent && shown; parent = parent.parentElement) {
      const s = getComputedStyle(parent);
      shown = s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
    }
    if (shown) visibleText.push(node.textContent);
  }
  return {
    visibleText: visibleText.join(''),
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
    try:
        width, height = map(float, re.split(r"[:x/]", ratio))
        if width > 0 and height > 0 and math.isfinite(width) and math.isfinite(height):
            return 1280, max(1, round(1280 * height / width))
    except ValueError:
        pass
    return _DEFAULT_VIEWPORT


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
            logger.debug(
                "render: error stopping cached Playwright instance", exc_info=True
            )
    _browser = None
    _playwright = None


def _render_task(html: str, width: int, height: int) -> tuple[dict[str, Any], bytes]:
    try:
        browser = _get_browser()
        page = browser.new_page(
            viewport={"width": width, "height": height}, java_script_enabled=False
        )
        try:
            # Inputs must be self-contained. Never let uploaded HTML fetch a
            # server-local URL or execute scripts during visual QA.
            page.route("**/*", lambda route: route.abort())
            page.set_content(html, wait_until="load")
            page.evaluate("() => document.fonts.ready")
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
    ``verify.py::_layout_report``, and a PNG for visual QA only.
    An invalid ``ratio`` falls back to the 1280x720 16:9 viewport.
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


def _measure_task(html: str, width: int, height: int) -> dict[str, Any]:
    from .html_layout import LAYOUT_JS
    from .semantic_layout import SEMANTIC_LAYOUT_JS, TEXT_OWNER_JS

    page = _get_browser().new_page(
        viewport={"width": width, "height": height}, java_script_enabled=False
    )
    try:
        page.route("**/*", lambda route: route.abort())
        page.set_content(html, wait_until="load")
        page.evaluate("() => document.fonts.ready")
        return page.evaluate(
            "() => {"
            + TEXT_OWNER_JS
            + "const painted=("
            + LAYOUT_JS
            + ")();"
            + "const semantic=("
            + SEMANTIC_LAYOUT_JS
            + ")();"
            + "return {...painted,...semantic};}"
        )
    finally:
        page.close()


def measure_slide(html: str, *, ratio: str) -> dict[str, Any]:
    """Read native DOM text/shape/image geometry without taking a screenshot."""
    width, height = _viewport_for(ratio)
    return _EXECUTOR.submit(_measure_task, html, width, height).result()


def _font_styles_task(
    texts: list[dict], reference_png: bytes | None, font_face_css: str | None = None
) -> list[dict]:
    page = _get_browser().new_page(java_script_enabled=False)
    try:
        # The document now loads real font faces, so the same guard
        # ``_render_task`` installs must keep any external ``src`` off the
        # network. The ``data:`` reference image is not a network request.
        page.route("**/*", lambda route: route.abort())
        page.set_content(
            f"<html><head><style>{font_face_css or ''}</style></head><body></body></html>"
        )
        return page.evaluate(
            """async ({texts, reference}) => {
          await document.fonts.ready;
          const c=document.createElement('canvas').getContext('2d');
          let pixels, image;
          if(reference) {
            image=new Image(); image.src=reference; await image.decode();
            const scene=document.createElement('canvas'); scene.width=image.width; scene.height=image.height;
            const sc=scene.getContext('2d'); sc.drawImage(image,0,0);
            pixels=sc.getImageData(0,0,scene.width,scene.height).data;
          }
          return texts.map(t => {
            c.font=`${t.weight} ${t.size}px ${JSON.stringify(t.font)}, sans-serif`;
            const display=t.display_text ?? t.text;
            const m=c.measureText(display);
            const baseline=(t.size-m.fontBoundingBoxAscent-m.fontBoundingBoxDescent)/2+m.fontBoundingBoxAscent;
            const style={css_left:t.x+m.actualBoundingBoxLeft,css_top:t.y-baseline+m.actualBoundingBoxAscent,css_width:Math.max(t.w,m.width)+4,line_height:t.size};
            if(pixels && !/^\\p{Mark}+$/u.test(display.trim())) {
              // A glyph mask samples the original PDF's visible foreground,
              // including text painted by transparency/gradient groups. This
              // is reference analysis; the mask is never an output asset.
              const mask=document.createElement('canvas');
              mask.width=Math.ceil(Math.max(t.w,m.width)+8); mask.height=Math.ceil(Math.max(t.h,t.size*2)+8);
              const mc=mask.getContext('2d');mc.font=c.font;
              mc.fillText(display,m.actualBoundingBoxLeft+4,m.actualBoundingBoxAscent+4);
              const alpha=mc.getImageData(0,0,mask.width,mask.height).data, samples=[];
              const bx=Math.max(0,Math.min(image.width-1,Math.round(t.x-2)));
              const by=Math.max(0,Math.min(image.height-1,Math.round(t.y-2)));
              const background=Array.from(pixels.slice((by*image.width+bx)*4,(by*image.width+bx)*4+3));
              for(let y=0;y<mask.height;y++)for(let x=0;x<mask.width;x++) {
                if(alpha[(y*mask.width+x)*4+3]<245)continue;
                const sx=Math.round(t.x+x-4),sy=Math.round(t.y+y-4);
                if(sx<0||sx>=image.width||sy<0||sy>=image.height)continue;
                const offset=(sy*image.width+sx)*4;
                const color=Array.from(pixels.slice(offset,offset+3));
                samples.push({color,contrast:color.reduce((sum,v,k)=>sum+(v-background[k])**2,0)});
              }
              // Font rasterizers place edge pixels differently. Retain solid
              // foreground samples rather than mistaking antialiasing for gray text.
              samples.sort((a,b)=>b.contrast-a.contrast);
              const ink=samples.slice(0,Math.max(1,Math.ceil(samples.length*0.2)));
              if(samples.length>3) style.reference_color='#'+[0,1,2].map(k=>{
                const values=ink.map(sample=>sample.color[k]);
                values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)].toString(16).padStart(2,'0');
              }).join('');
            }
            return style;
          });
        }""",
            {
                "texts": texts,
                "reference": "data:image/png;base64,"
                + base64.b64encode(reference_png).decode()
                if reference_png
                else None,
            },
        )
    finally:
        page.close()


def pdf_text_styles(
    texts: list[dict],
    reference_png: bytes | None = None,
    *,
    font_face_css: str | None = None,
) -> list[dict]:
    """Suggested CSS boxes computed from PDF glyph bounds and actual font metrics.

    ``font_face_css`` carries ``@font-face`` blocks for the source page's
    embedded fonts (see ``pdf_fonts.py::build_font_face_css``) so the
    measurement uses the original faces instead of a substitute.
    """
    return _EXECUTOR.submit(
        _font_styles_task, texts, reference_png, font_face_css
    ).result()
