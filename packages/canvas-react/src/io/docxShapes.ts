/**
 * Shapes a Word file draws, and whether the reader can see them.
 *
 * A Word document can carry drawn shapes — a circle round an answer, a box
 * behind a note — in two forms at once: the modern one (`w:drawing`) and a
 * legacy twin (`w:pict`) kept for older readers. The preview draws some of
 * them and silently drops others, and a shape that vanishes without a word is
 * the worst outcome of the three: the reader sees a document that looks whole
 * and is not. That circle is not decoration; it is the answer.
 *
 * So this counts. It reads the shapes the file asks for straight from the
 * stored XML, counts the ones that ended up on the page with ink in them, and
 * reports the difference. Nothing here draws anything or changes the file — it
 * is the honest ledger the status line reads from.
 *
 * The two sides are counted so they can be compared:
 *
 * - **Asked for** — every shape in the document's own XML, each object counted
 *   once. A modern shape and its legacy twin are one object, not two, and a
 *   shape the file itself says has neither fill nor outline is not counted at
 *   all: it is invisible in Word too, so the preview showing nothing is right.
 *   Pictures are not shapes; they have their own path and are left out.
 * - **Shown** — every shape on the page that actually paints. A shape that was
 *   rendered but comes out with no fill and no outline is *not* shown, however
 *   present it is in the markup; the reader cannot see it, and that is the
 *   only question being asked here.
 */

/** What the file asks for, what the reader gets, and the gap. */
export interface ShapeTally {
  /** Shapes the file asks for, each object counted once. */
  askedFor: number;
  /** Shapes on the page with ink in them. */
  shown: number;
  /** Shapes the reader cannot see. Never below zero. */
  missing: number;
}

const VML_NS = "urn:schemas-microsoft-com:vml";

/** VML elements that are drawn shapes rather than containers or pictures. */
const VML_SHAPES = new Set([
  "oval",
  "rect",
  "roundrect",
  "line",
  "polyline",
  "arc",
  "curve",
  "shape",
  "group",
]);

/** SVG elements that can carry ink. */
const PAINTABLE = "ellipse,rect,circle,path,line,polygon,polyline,image,foreignObject";

function isVml(node: Element): boolean {
  return node.namespaceURI === VML_NS || node.tagName.startsWith("v:");
}

/**
 * The alpha a resolved colour carries, or null when it carries none.
 *
 * Read by counting components rather than by pattern: `rgb(192, 0, 0)` ends in
 * a zero that is the blue channel, and treating it as alpha would call a solid
 * red shape invisible.
 */
function alphaOf(paint: string): number | null {
  const inside = /^rgba?\(([^)]*)\)$/.exec(paint);
  if (!inside) return null;
  const [channels, slashAlpha] = inside[1].split("/");
  const raw =
    slashAlpha !== undefined
      ? slashAlpha
      : (() => {
          const parts = channels.split(",").map((part) => part.trim());
          return parts.length === 4 ? parts[3] : undefined;
        })();
  if (raw === undefined) return null;
  const value = raw.trim();
  const number = value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** True for a colour that paints nothing — `none`, or fully transparent. */
function invisible(paint: string): boolean {
  const value = paint.trim();
  if (!value || value === "none" || value === "transparent") return true;
  return alphaOf(value) === 0;
}

/**
 * True when this rendered shape puts ink on the page.
 *
 * The resolved value is what counts, not the attribute: a stylesheet can paint
 * a shape transparent whatever its markup says, and the reader sees the
 * result. The attribute is read only where a resolved value is not on offer.
 */
export function paints(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "image" || tag === "foreignobject") return true;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const resolved = (name: "fill" | "stroke") =>
    style?.getPropertyValue(name) || element.getAttribute(name) || "";
  return !invisible(resolved("fill")) || !invisible(resolved("stroke"));
}

/**
 * True when a VML shape says outright that it has neither fill nor outline.
 *
 * Word draws nothing for one of these either, so a preview that shows nothing
 * is not missing anything and must not say it is.
 */
function drawsNothing(shape: Element): boolean {
  return shape.getAttribute("filled") === "f" && shape.getAttribute("stroked") === "f";
}

/** The VML shape a legacy twin holds, if it holds one. */
function vmlShapeIn(node: Element): Element | null {
  if (isVml(node) && VML_SHAPES.has(node.localName)) return node;
  for (const child of Array.from(node.children)) {
    const found = vmlShapeIn(child);
    if (found) return found;
  }
  return null;
}

/** True when a `w:drawing` holds a shape rather than a picture. */
function drawingIsShape(drawing: Element): boolean {
  const data = drawing.getElementsByTagName("*");
  for (const node of Array.from(data)) {
    if (node.localName === "graphicData") {
      return !Array.from(node.children).some((child) => child.localName === "pic");
    }
  }
  return false;
}

/** Whether an ancestor is the wrapper that pairs a shape with its legacy twin. */
function insideAlternateContent(node: Element): boolean {
  let parent = node.parentElement;
  while (parent) {
    if (parent.localName === "AlternateContent") return true;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Shapes one part's XML asks for, each object counted once.
 *
 * The pairing wrapper is counted first and its contents skipped afterwards, so
 * a shape written twice for two generations of reader is still one shape.
 */
export function shapesAskedFor(xml: Document): number {
  let count = 0;
  const seenTwins = new Set<Element>();
  for (const node of Array.from(xml.getElementsByTagName("*"))) {
    if (node.localName !== "AlternateContent") continue;
    const twin = vmlShapeIn(node);
    const drawing = Array.from(node.getElementsByTagName("*")).find(
      (child) => child.localName === "drawing",
    );
    const isShape = twin !== null || (drawing ? drawingIsShape(drawing) : false);
    if (isShape && !(twin && drawsNothing(twin))) count += 1;
    seenTwins.add(node);
  }
  for (const node of Array.from(xml.getElementsByTagName("*"))) {
    if (insideAlternateContent(node)) continue;
    if (isVml(node) && VML_SHAPES.has(node.localName)) {
      // A group is one object; the shapes inside it travel with it.
      if (node.parentElement && vmlShapeIn(node.parentElement) === node.parentElement) continue;
      if (!drawsNothing(node)) count += 1;
      continue;
    }
    if (node.localName === "drawing" && drawingIsShape(node)) count += 1;
  }
  return count;
}

/** Shapes on the page the reader can actually see. */
export function shapesShown(root: HTMLElement): number {
  let count = 0;
  for (const svg of Array.from(root.querySelectorAll("svg"))) {
    if (Array.from(svg.querySelectorAll(PAINTABLE)).some(paints)) count += 1;
  }
  return count;
}

/**
 * Count both sides and report the gap.
 *
 * `xmls` are the stored parts to read — the document and, where the host has
 * them, its headers and footers. Without them nothing can be claimed, so the
 * tally comes back empty rather than guessing.
 */
export function tallyShapes(root: HTMLElement, xmls: Document[]): ShapeTally {
  if (xmls.length === 0) return { askedFor: 0, shown: 0, missing: 0 };
  const askedFor = xmls.reduce((total, xml) => total + shapesAskedFor(xml), 0);
  const shown = shapesShown(root);
  return { askedFor, shown, missing: Math.max(0, askedFor - shown) };
}
