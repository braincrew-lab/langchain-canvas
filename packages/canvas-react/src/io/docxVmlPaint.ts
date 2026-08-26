/**
 * Putting the colour back on a Word shape the preview drew empty.
 *
 * A circle round an answer arrives on the page in the right place and the
 * right size, and then paints nothing: the renderer reads a legacy shape's
 * position and its fill colour, and stops there. It never reads `strokecolor`,
 * `strokeweight`, `filled` or `stroked`, so a shape drawn as an outline — the
 * common way to ring an answer — has no outline to draw, and its own
 * stylesheet paints the inside transparent. The shape is present, correct and
 * invisible.
 *
 * This reads those four straight from the stored XML and paints what the file
 * states. Deliberately only that:
 *
 * - **Only ovals and rectangles.** A line, a group, a text box or a picture is
 *   left as the renderer drew it.
 * - **Only what the file says.** A shape that states no fill keeps the
 *   renderer's; a colour is never invented for one. The single default taken
 *   is the outline width a file may omit, which VML fixes at 0.75pt.
 * - **Only a plain colour.** A gradient or a pattern fill is left alone rather
 *   than flattened to one of its colours.
 *
 * A shape on the page is matched to its shape in the file by where it sits and
 * how big it is, not by the order it appears in: the renderer drops the shape
 * kinds it does not know, so counting through both lists in step would put the
 * wrong colour on the wrong shape. Shapes that share a place and a size are
 * paired in the order they appear, which is the only order they can be in.
 *
 * The stored file is not written to; this changes what is drawn.
 */

const VML_NS = "urn:schemas-microsoft-com:vml";

/** VML shapes this paints. Anything else keeps what the renderer gave it. */
const PAINTED = new Set(["oval", "rect"]);

/** The rendered element each of those becomes. */
const RENDERED: Readonly<Record<string, string>> = { oval: "ellipse", rect: "rect" };

/** Style properties that say where a shape is and how big. */
const GEOMETRY = ["margin-left", "margin-top", "left", "top", "width", "height"] as const;

/** Points per unit, for the units a Word file and a browser write. */
const IN_POINTS: Readonly<Record<string, number>> = {
  pt: 1,
  px: 0.75,
  in: 72,
  cm: 28.3465,
  mm: 2.83465,
  pc: 12,
};

/** What to paint on one shape. An absent side is left as the renderer had it. */
interface Paint {
  fill?: string;
  stroke?: string;
  strokeWidth?: string;
}

/** VML's own outline width when a shape states a colour but no weight. */
const DEFAULT_STROKE_WIDTH = "0.75pt";

/** True when a VML boolean attribute says no. */
function saysNo(value: string | null): boolean {
  return value === "f" || value === "false" || value === "0";
}

/**
 * A colour a browser can draw, or null.
 *
 * Word writes a theme colour as `black [3213]` — the name it resolves to,
 * then the slot it came from. The name is the part a page can use.
 */
function colour(value: string | null): string | null {
  const named = (value ?? "").split("[")[0].trim();
  return named || null;
}

/** One length in points, however the file or the browser spelled it. */
function points(value: string): number | null {
  const parsed = /^(-?[\d.]+)\s*([a-z%]*)$/.exec(value.trim());
  if (!parsed) return null;
  const size = Number(parsed[1]);
  if (!Number.isFinite(size)) return null;
  if (size === 0) return 0;
  const unit = IN_POINTS[parsed[2] || "px"];
  return unit === undefined ? null : Math.round(size * unit * 100) / 100;
}

/**
 * Where a shape sits and how big it is, as one comparable string.
 *
 * Read from style text on both sides, so the file's `margin-left:0` and the
 * page's `margin-left: 0px` come out the same.
 */
function place(styleText: string): string {
  const found = new Map<string, string>();
  for (const declaration of styleText.split(";")) {
    const at = declaration.indexOf(":");
    if (at < 0) continue;
    const name = declaration.slice(0, at).trim().toLowerCase();
    if (!(GEOMETRY as readonly string[]).includes(name)) continue;
    const size = points(declaration.slice(at + 1));
    if (size !== null) found.set(name, String(size));
  }
  return GEOMETRY.map((name) => `${name}=${found.get(name) ?? ""}`).join("|");
}

/** What one VML shape says to paint, or null when it says nothing usable. */
function statedPaint(shape: Element): Paint | null {
  const paint: Paint = {};
  const fill = Array.from(shape.children).find(
    (child) => child.localName === "fill" && child.namespaceURI === VML_NS,
  );
  const gradient = fill?.getAttribute("type");
  if (saysNo(shape.getAttribute("filled"))) {
    paint.fill = "none";
  } else if (!gradient || gradient === "solid") {
    const stated = colour(shape.getAttribute("fillcolor") ?? fill?.getAttribute("color") ?? null);
    if (stated) paint.fill = stated;
  }
  if (saysNo(shape.getAttribute("stroked"))) {
    paint.stroke = "none";
  } else {
    const stated = colour(shape.getAttribute("strokecolor"));
    if (stated) {
      paint.stroke = stated;
      paint.strokeWidth = shape.getAttribute("strokeweight") ?? DEFAULT_STROKE_WIDTH;
    }
  }
  return paint.fill || paint.stroke ? paint : null;
}

/** Every paintable VML shape in a stored part, by where it sits. */
function statedByPlace(xml: Document): Map<string, Paint[]> {
  const stated = new Map<string, Paint[]>();
  for (const shape of Array.from(xml.getElementsByTagName("*"))) {
    if (shape.namespaceURI !== VML_NS || !PAINTED.has(shape.localName)) continue;
    const style = shape.getAttribute("style");
    const paint = style && statedPaint(shape);
    if (!paint) continue;
    const key = `${RENDERED[shape.localName]}@${place(style)}`;
    const queue = stated.get(key);
    if (queue) queue.push(paint);
    else stated.set(key, [paint]);
  }
  return stated;
}

/**
 * Paint the shapes on a rendered page with the colours their file states.
 *
 * Written as inline style rather than as attributes: the renderer ships a rule
 * that paints every shape's inside transparent, and an attribute loses to it.
 *
 * Returns how many shapes were painted.
 */
export function paintVmlShapes(root: HTMLElement, xmls: readonly Document[]): number {
  const stated = new Map<string, Paint[]>();
  for (const xml of xmls) {
    for (const [key, queue] of statedByPlace(xml)) {
      const existing = stated.get(key);
      if (existing) existing.push(...queue);
      else stated.set(key, [...queue]);
    }
  }
  if (stated.size === 0) return 0;
  let painted = 0;
  for (const svg of Array.from(root.querySelectorAll("svg"))) {
    const shape = svg.firstElementChild as SVGElement | null;
    const tag = shape?.tagName.toLowerCase();
    if (!shape || (tag !== "ellipse" && tag !== "rect")) continue;
    const queue = stated.get(`${tag}@${place(svg.getAttribute("style") ?? "")}`);
    const paint = queue?.shift();
    if (!paint) continue;
    if (paint.fill) shape.style.fill = paint.fill;
    if (paint.stroke) shape.style.stroke = paint.stroke;
    if (paint.strokeWidth) shape.style.strokeWidth = paint.strokeWidth;
    painted += 1;
  }
  return painted;
}
