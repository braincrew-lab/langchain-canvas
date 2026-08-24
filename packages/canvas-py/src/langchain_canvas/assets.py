"""Canvas asset references — relative paths that point at files on the canvas.

The reference contract: inside canvas content, a relative path starting with
``assets/`` (files the agent brought in through ``write_canvas_asset``) or
``sources/`` (the user's uploads — read-only, so referencing beats copying)
points at a file on the *same* canvas:

- an ``.html`` page embeds one as ``<img src="assets/logo.png">``
- a document embeds one as ``![logo](assets/logo.png)``
- a slide image element sets ``src: "assets/logo.png"``

The canvas displays such a reference live (the client resolves it against the
host's file endpoint), and exports restore self-containment at the door:
:func:`inline_canvas_assets` replaces every reference with a ``data:`` URI so
the exported file carries its images. The unit of self-containment is the
canvas folder while collaborating, and the single file once exported.

The TypeScript twin lives in ``canvas-react/src/io/canvasAssets.ts``; the
prefix list below is compared against it by the protocol parity tests.
"""

from __future__ import annotations

import base64
import json
import re

from .exporters import PPTX_MIME
from .store import CanvasStore, CanvasStoreError

ASSET_REFERENCE_PREFIXES: tuple[str, ...] = ("assets/", "sources/")
"""Path prefixes that count as canvas-asset references (parity-pinned with TS)."""

ASSETS_PREFIX = "assets/"
"""Where ``write_canvas_asset`` lands files (``sources/`` stays upload-only)."""

ASSET_IMAGE_MIME: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}
"""Embeddable image types: what the asset tool accepts and the inliner encodes."""

# src="assets/..." / src='sources/...' — the prefixes come from the constant
# above so the regex can never drift from the published contract. Leading ./
# and ../ segments are tolerated (see normalize_asset_reference).
_REF_ALTERNATION = "|".join(re.escape(p.rstrip("/")) for p in ASSET_REFERENCE_PREFIXES)
_SRC_ATTR_PATTERN = re.compile(
    rf"""(src=(["']))((?:\.\.?/)*(?:{_REF_ALTERNATION})/[^"']+)(\2)"""
)


def normalize_asset_reference(src: str) -> str | None:
    """The canvas-root-relative path ``src`` refers to, or ``None``.

    References are root-relative by contract, but a model writing a page that
    lives in a folder often produces the document-relative form
    (``../sources/photo.png``). Store paths can never contain ``..`` (the
    store contract rejects them), and ``assets/`` / ``sources/`` exist only at
    the root — so folding leading ``./`` / ``../`` segments onto the root
    reading is lossless tolerance, not guesswork. Stored content is never
    rewritten; only consumers (display, export inlining) interpret leniently.
    """
    folded = src
    while folded.startswith(("./", "../")):
        folded = folded[2:] if folded.startswith("./") else folded[3:]
    return folded if folded.startswith(ASSET_REFERENCE_PREFIXES) else None


def is_asset_reference(src: str) -> bool:
    """Whether ``src`` is a relative reference to a canvas asset."""
    return normalize_asset_reference(src) is not None


def asset_mime(path: str) -> str | None:
    """The image media type for a canvas path, or ``None`` when not an image."""
    dot = path.rfind(".")
    return ASSET_IMAGE_MIME.get(path[dot:].lower()) if dot != -1 else None


def inline_canvas_assets(html: str, store: CanvasStore, canvas_id: str) -> str:
    """Replace relative asset references in ``html`` with ``data:`` URIs.

    Applied by the export tool right before an exporter runs, so exporters keep
    their one-method contract and every exported file leaves self-contained.
    A reference that cannot be inlined (file missing, not an image type) is
    left untouched — the exporter then skips it, which is honest: the export
    shows exactly what could be resolved. Only ``src`` attributes are
    rewritten; CSS ``url(...)`` references are out of contract.
    """

    def _sub(match: re.Match[str]) -> str:
        path = normalize_asset_reference(match.group(3))
        if path is None:
            return match.group(0)
        mime = asset_mime(path)
        if mime is None:
            return match.group(0)
        try:
            data = store.read_bytes(canvas_id, path).data
        except CanvasStoreError:
            return match.group(0)
        encoded = base64.b64encode(data).decode()
        return f"{match.group(1)}data:{mime};base64,{encoded}{match.group(4)}"

    return _SRC_ATTR_PATTERN.sub(_sub, html)


def inline_slides_assets(content: str, store: CanvasStore, canvas_id: str) -> str:
    """Replace asset references in a ``.slides.json`` envelope with ``data:`` URIs.

    The slides twin of :func:`inline_canvas_assets`: slide decks carry their
    image references in JSON fields (each element's ``src`` and a structured
    slide's ``image``), not in HTML attributes, so the export tool inlines
    them here before the pptx exporter runs. The deck's ``template`` skin
    reference (a ``sources/*.pptx`` path) is inlined the same way, so the
    exporter receives the skin bytes without touching the store. The same
    honesty applies — a reference that cannot be inlined (file missing, not
    an image type) is left untouched and the exporter skips it. Content that
    does not parse as an envelope is returned unchanged so the exporter can
    raise its own honest error.
    """
    try:
        envelope = json.loads(content)
    except json.JSONDecodeError:
        return content
    data = envelope.get("data") if isinstance(envelope, dict) else None
    slides = data.get("slides") if isinstance(data, dict) else None
    if not isinstance(slides, list):
        return content

    def _inlined(src: object) -> str | None:
        if not isinstance(src, str):
            return None
        path = normalize_asset_reference(src)
        if path is None:
            return None
        mime = asset_mime(path)
        if mime is None:
            return None
        try:
            raw = store.read_bytes(canvas_id, path).data
        except CanvasStoreError:
            return None
        return f"data:{mime};base64,{base64.b64encode(raw).decode()}"

    def _inlined_template(src: object) -> str | None:
        # The skin is a pptx, not an image, so it bypasses the image-mime
        # gate — same store read, same honest None on any miss.
        if not isinstance(src, str) or not src.lower().endswith(".pptx"):
            return None
        path = normalize_asset_reference(src)
        if path is None:
            return None
        try:
            raw = store.read_bytes(canvas_id, path).data
        except CanvasStoreError:
            return None
        return f"data:{PPTX_MIME};base64,{base64.b64encode(raw).decode()}"

    changed = False
    if isinstance(data, dict):
        uri = _inlined_template(data.get("template"))
        if uri is not None:
            data["template"] = uri
            changed = True
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        elements = slide.get("elements")
        if isinstance(elements, list):
            for element in elements:
                if not isinstance(element, dict):
                    continue
                uri = _inlined(element.get("src"))
                if uri is not None:
                    element["src"] = uri
                    changed = True
        uri = _inlined(slide.get("image"))
        if uri is not None:
            slide["image"] = uri
            changed = True
    return json.dumps(envelope, ensure_ascii=False) if changed else content
