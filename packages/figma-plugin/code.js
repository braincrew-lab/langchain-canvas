/**
 * langchain-canvas Deck Import — Figma plugin.
 *
 * Reads a deck JSON exported from the canvas ("Figma (JSON)" export) and builds
 * real, editable Figma frames + text nodes from it. The JSON shape is:
 *
 *   { type: "langchain-canvas/figma-deck", version: 1,
 *     frames: [{ name, x, y, width, height, fill,
 *                nodes: [{ type: "text", x, y, width, characters,
 *                          fontSize, fontWeight, align, color }] }] }
 */

figma.showUI(__html__, { width: 340, height: 210 });

function hexToRgb(hex) {
  const h = String(hex || "#000000").replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

figma.ui.onmessage = async (msg) => {
  if (msg.type !== "import-deck") return;
  const deck = msg.deck;
  if (!deck || !Array.isArray(deck.frames)) {
    figma.notify("Invalid deck JSON");
    return;
  }

  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });

  const created = [];
  for (const f of deck.frames) {
    const frame = figma.createFrame();
    frame.name = f.name || "Slide";
    frame.resize(f.width || 1280, f.height || 720);
    frame.x = f.x || 0;
    frame.y = f.y || 0;
    frame.cornerRadius = 8;
    frame.fills = [{ type: "SOLID", color: hexToRgb(f.fill || "#FFFFFF") }];

    for (const n of f.nodes || []) {
      if (n.type !== "text") continue;
      const t = figma.createText();
      t.fontName = { family: "Inter", style: (n.fontWeight || 400) >= 600 ? "Bold" : "Regular" };
      t.fontSize = n.fontSize || 24;
      t.characters = n.characters || "";
      t.x = n.x || 0;
      t.y = n.y || 0;
      if (n.width) t.resize(n.width, t.height);
      t.textAlignHorizontal = n.align || "LEFT";
      t.fills = [{ type: "SOLID", color: hexToRgb(n.color || "#1F2328") }];
      frame.appendChild(t);
    }
    created.push(frame);
  }

  if (created.length) {
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
  }
  figma.notify(`Imported ${created.length} slide${created.length === 1 ? "" : "s"}`);
  figma.closePlugin();
};
