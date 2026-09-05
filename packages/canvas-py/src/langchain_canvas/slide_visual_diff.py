"""Pixel-level diff between two printed revisions of a deck.

The JSON diff (:mod:`langchain_canvas.slide_diff`) says what the *data*
changed; this says what the *page* changed — a shape that renders wrong even
though its JSON looks fine (a font that fell back, an overlap, a clip) only
shows up in pixels. The two run as tiers: the JSON diff is free and gates
which slides are worth rendering, this renders only those.

The pipeline expects both revisions as **PDF** (the printable form a host
gets from its ``.pptx`` converter, LibreOffice or otherwise — the SDK ships
no pptx rasteriser of its own) and compares them page by page:

* Workers are **processes**, never threads — PDFium is not thread-safe, so
  each worker opens its own document handles.
* Render and compare are **fused in the worker**: each worker renders slide
  *i* from both PDFs and diffs it in place, returning only ``(page, ratio,
  bbox)``. No image ever crosses the process boundary, which measured ~8x
  over the sequential pipeline on a 14-core machine (vs ~3.6x for
  stage-by-stage parallelism that ships PNGs between processes).
* Falls back to in-process sequential when a pool cannot be had (one page,
  ``workers=1``, or a sandbox that cannot spawn) — slower, never broken.

Like the deck check, a wrong finding is worse than a missing one: the
comparison runs with an anti-alias tolerance so a re-render of an unchanged
slide reads as unchanged, and anything unreadable raises rather than
guessing.
"""

from __future__ import annotations

import os
import tempfile
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from typing import Any

__all__ = [
    "PageDiff",
    "attribute_to_elements",
    "compare_images",
    "format_visual_diff",
    "visual_diff_pdfs",
]

#: Per-channel intensity delta below which a pixel counts as unchanged.
#: Anti-aliasing re-rasterises edges a few steps differently on every render;
#: without the tolerance an untouched slide reads as ~1% changed.
DEFAULT_TOLERANCE = 16

#: Render scale (multiples of the PDF's own point size). 2.0 is the quality
#: tier the page renderer uses for its largest inline images.
DEFAULT_SCALE = 2.0

#: Share of pixels that must differ before a page counts as changed. Kept
#: near zero — the tolerance above already absorbs raster noise, so anything
#: past it is a real difference.
MIN_CHANGED_RATIO = 0.0005


@dataclass(frozen=True)
class PageDiff:
    """What one page pair showed: 1-based page, the share of pixels that
    differ, the changed region (px at render scale, ``None`` when nothing
    changed or the page exists in only one revision), and the rendered page
    size the bbox is measured on."""

    page: int
    ratio: float
    bbox: tuple[int, int, int, int] | None
    size: tuple[int, int]

    @property
    def changed(self) -> bool:
        return self.ratio > MIN_CHANGED_RATIO


def compare_images(
    a: Any, b: Any, tolerance: int = DEFAULT_TOLERANCE
) -> tuple[float, tuple[int, int, int, int] | None]:
    """``(ratio, bbox)`` between two PIL images.

    ``b`` is resized to ``a``'s size first — two renders of the same page at
    slightly different scales must not read as a full-page change.
    """
    from PIL import ImageChops

    grey_a = a.convert("L")
    grey_b = b.convert("L")
    if grey_b.size != grey_a.size:
        grey_b = grey_b.resize(grey_a.size)
    mask = ImageChops.difference(grey_a, grey_b).point(
        lambda value: 255 if value > tolerance else 0
    )
    changed = mask.histogram()[255]
    return changed / (grey_a.width * grey_a.height), mask.getbbox()


def _fused_chunk(
    args: tuple[str, str, list[int], float, int],
) -> list[tuple[int, float, tuple[int, int, int, int] | None, tuple[int, int]]]:
    """One worker's share: open both documents once, then render slide *i*
    from each and compare in place. Module-level so the pool can pickle it."""
    import pypdfium2 as pdfium  # type: ignore[import-untyped]

    before_path, after_path, pages, scale, tolerance = args
    before = pdfium.PdfDocument(before_path)
    after = pdfium.PdfDocument(after_path)
    out: list[tuple[int, float, tuple[int, int, int, int] | None, tuple[int, int]]] = []
    try:
        for page in pages:
            image_a = before[page - 1].render(scale=scale).to_pil()
            image_b = after[page - 1].render(scale=scale).to_pil()
            ratio, bbox = compare_images(image_a, image_b, tolerance)
            out.append((page, ratio, bbox, image_a.size))
    finally:
        before.close()
        after.close()
    return out


def visual_diff_pdfs(
    before_pdf: bytes,
    after_pdf: bytes,
    pages: list[int] | None = None,
    *,
    scale: float = DEFAULT_SCALE,
    tolerance: int = DEFAULT_TOLERANCE,
    workers: int | None = None,
) -> list[PageDiff]:
    """Per-page pixel diffs between two printed deck revisions.

    ``pages`` is 1-based; ``None`` compares every page both revisions have.
    A page present in only one revision — a slide added or removed, which is
    the JSON diff's finding to name — is reported as fully changed
    (``ratio=1.0, bbox=None``) so the visual report never silently skips it.

    Raises :class:`~langchain_canvas.converters.MissingConverterDependencyError`
    when ``pypdfium2``/``pillow`` are absent — same contract as the page
    renderer they power.
    """
    try:
        import pypdfium2 as pdfium  # type: ignore[import-untyped]
        from PIL import Image  # noqa: F401
    except ImportError as exc:
        from .converters import MissingConverterDependencyError

        raise MissingConverterDependencyError(
            "the visual deck diff needs pypdfium2 and pillow — install "
            "langchain-canvas[pdf-images]"
        ) from exc

    count_before = len(pdfium.PdfDocument(before_pdf))
    count_after = len(pdfium.PdfDocument(after_pdf))
    common = min(count_before, count_after)
    highest = max(count_before, count_after)
    wanted = pages if pages is not None else list(range(1, highest + 1))
    comparable = sorted({p for p in wanted if 1 <= p <= common})
    # Slides that exist on one side only: fully changed by definition.
    one_sided = [
        PageDiff(page=p, ratio=1.0, bbox=None, size=(0, 0))
        for p in wanted
        if common < p <= highest
    ]
    if not comparable:
        return sorted(one_sided, key=lambda d: d.page)

    # The documents go to the workers as paths, not bytes — pickling the PDFs
    # into every worker duplicates them per process for nothing.
    with tempfile.TemporaryDirectory(prefix="cv-visual-diff-") as folder:
        before_path = os.path.join(folder, "before.pdf")
        after_path = os.path.join(folder, "after.pdf")
        with open(before_path, "wb") as handle:
            handle.write(before_pdf)
        with open(after_path, "wb") as handle:
            handle.write(after_pdf)

        pool_size = min(workers or (os.cpu_count() or 2), len(comparable), 8)
        rows: list[tuple[int, float, tuple[int, int, int, int] | None, tuple[int, int]]]
        if pool_size <= 1:
            rows = _fused_chunk((before_path, after_path, comparable, scale, tolerance))
        else:
            chunks = [comparable[i::pool_size] for i in range(pool_size)]
            jobs = [(before_path, after_path, chunk, scale, tolerance) for chunk in chunks if chunk]
            try:
                with ProcessPoolExecutor(pool_size) as pool:
                    rows = [row for result in pool.map(_fused_chunk, jobs) for row in result]
            except (OSError, RuntimeError):
                # A sandbox that cannot spawn still gets its diff, just slower.
                rows = _fused_chunk((before_path, after_path, comparable, scale, tolerance))

    diffs = [PageDiff(page=p, ratio=round(r, 4), bbox=b, size=s) for p, r, b, s in rows]
    return sorted(diffs + one_sided, key=lambda d: d.page)


def _rotated_bounds(
    x: float, y: float, w: float, h: float, rotation: float
) -> tuple[float, float, float, float]:
    """The axis-aligned bounds (percent) of a box turned about its centre —
    the region a rotated element can actually paint."""
    import math

    if not rotation:
        return x, y, x + w, y + h
    angle = math.radians(rotation)
    cx, cy = x + w / 2.0, y + h / 2.0
    half_w = (abs(w * math.cos(angle)) + abs(h * math.sin(angle))) / 2.0
    half_h = (abs(w * math.sin(angle)) + abs(h * math.cos(angle))) / 2.0
    return cx - half_w, cy - half_h, cx + half_w, cy + half_h


def attribute_to_elements(
    diff: PageDiff, elements: list[dict[str, Any]]
) -> list[str]:
    """The ids of the elements whose box intersects the changed region.

    Joins the pixel layer back to the shape layer: geometry is percent of the
    page, the bbox is px on the rendered page, and a rotated element counts
    by the bounds it can actually paint. No bbox (or no size) attributes to
    nothing — a full-page change already says everything.
    """
    if diff.bbox is None or diff.size == (0, 0):
        return []
    width, height = diff.size
    left, top, right, bottom = diff.bbox
    changed = (
        100.0 * left / width,
        100.0 * top / height,
        100.0 * right / width,
        100.0 * bottom / height,
    )
    hits: list[str] = []
    for element in elements:
        if not isinstance(element, dict) or "id" not in element:
            continue
        try:
            bounds = _rotated_bounds(
                float(element["x"]), float(element["y"]),
                float(element["w"]), float(element["h"]),
                float(element.get("rotation") or 0),
            )
        except (KeyError, TypeError, ValueError):
            continue
        overlaps_x = bounds[0] < changed[2] and bounds[2] > changed[0]
        overlaps_y = bounds[1] < changed[3] and bounds[3] > changed[1]
        if overlaps_x and overlaps_y:
            hits.append(str(element["id"]))
    return hits


def format_visual_diff(
    diffs: list[PageDiff], attribution: dict[int, list[str]] | None = None
) -> str:
    """The changed pages as report lines, or ``''`` when every page held.

    Mirrors the voice of the JSON diff so the two read as one report:
    ``visual: slide 2 changed 6.6% (elements "title", "e3")``.
    """
    lines: list[str] = []
    for diff in diffs:
        if not diff.changed:
            continue
        names = (attribution or {}).get(diff.page) or []
        suffix = " (elements " + ", ".join(f'"{n}"' for n in names) + ")" if names else ""
        lines.append(f"visual: slide {diff.page} changed {diff.ratio:.1%}{suffix}")
    if not lines:
        return ""
    return "\n".join(lines)
