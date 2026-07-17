# langchain-canvas Deck Import (Figma plugin)

Turns a deck exported from the canvas into **real, editable Figma frames** — not
a flattened image. Each slide becomes a 1280×720 frame with live text nodes.

## Use it

1. In the canvas, open a **PowerPoint** artifact → **Export → Figma (JSON)**.
   You get a `*.json` file (shape: `{ type: "langchain-canvas/figma-deck", frames: [...] }`).
2. In Figma: **Menu → Plugins → Development → Import plugin from manifest…** and
   pick this folder's `manifest.json` (one-time).
3. Run **Plugins → Development → langchain-canvas Deck Import**, choose the
   `.json`, and click **Import slides**. The frames appear on the canvas,
   selected and zoomed to fit.

## Why a plugin?

Figma has no public "upload this JSON to create a file" endpoint — a JSON file
alone can't import. A plugin is the supported way to build native nodes
programmatically. This one maps the export's frames/text directly onto
`figma.createFrame()` / `figma.createText()`.

## Files

- `manifest.json` — plugin manifest
- `code.js` — builds frames + text from the deck JSON
- `ui.html` — file picker

No build step; it's plain plugin JS.
