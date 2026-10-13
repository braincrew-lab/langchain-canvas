/**
 * Painting a read-only workbook's cells the way Excel shows them, where
 * Fortune-sheet has no field of its own.
 *
 * The host's reader (`xlsx_sheets_and_charts(..., read_only=True)`) puts these
 * on a cell under one key, `lcx`:
 *   - `fill`     a patterned fill (`{pattern, fg, bg}`) or a gradient
 *                (`{gradient: "linear"|"path", degree, stops: [[pos, "#hex"]]}`)
 *   - `bar`      a conditional-format data bar (`{ratio, color}`)
 *   - `icon`     a conditional-format icon (`{set, index}`)
 *   - `dropdown` a list-validation cell (the arrow Excel draws beside it)
 *   - `link`     a web link the cell opens (http, https or mailto only)
 * (`indent` is read by Fortune's text layout, patched in `patches/`.)
 *
 * Fortune calls `beforeRenderCell` with the background colour already in
 * `ctx.fillStyle`, right before it fills the cell, so a fill or a bar only
 * swaps that brush for a pattern or a gradient. `afterRenderCell` runs after
 * the text and draws the icon and the arrow on top.
 */

type CellBox = { row: number; column: number; startX: number; startY: number; endX: number; endY: number };
type Extension = {
  fill?: { pattern?: string; fg?: string; bg?: string; gradient?: "linear" | "path"; degree?: number; stops?: Array<[number, string]> };
  bar?: { ratio: number; color: string };
  icon?: { set: string; index: number };
  dropdown?: boolean;
  link?: string;
};
type Painted = { lcx?: Extension; bg?: string } | null | undefined;

const TILE = 8;

/** One 8x8 tile per Excel pattern: the ink pixels drawn in the foreground colour. */
function drawTile(ctx: CanvasRenderingContext2D, pattern: string): void {
  const dot = (x: number, y: number) => ctx.fillRect(x, y, 1, 1);
  const every = (step: number, test: (x: number, y: number) => boolean) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (test(x, y) && (x + y) % step === 0) dot(x, y);
  };
  switch (pattern) {
    case "gray0625": every(1, (x, y) => x % 4 === 0 && y % 4 === 0); break;
    case "gray125": every(1, (x, y) => (x % 4 === 0 && y % 4 === 0) || (x % 4 === 2 && y % 4 === 2)); break;
    case "lightGray": every(1, (x, y) => x % 2 === 0 && y % 2 === 0); break;
    case "mediumGray": every(2, () => true); break;
    case "darkGray": every(1, (x, y) => !(x % 2 === 1 && y % 2 === 1)); break;
    case "lightHorizontal": every(1, (_x, y) => y % 4 === 0); break;
    case "darkHorizontal": every(1, (_x, y) => y % 4 < 2); break;
    case "lightVertical": every(1, (x) => x % 4 === 0); break;
    case "darkVertical": every(1, (x) => x % 4 < 2); break;
    case "lightDown": every(1, (x, y) => (x - y + TILE) % 4 === 0); break;
    case "darkDown": every(1, (x, y) => (x - y + TILE) % 4 < 2); break;
    case "lightUp": every(1, (x, y) => (x + y) % 4 === 0); break;
    case "darkUp": every(1, (x, y) => (x + y) % 4 < 2); break;
    case "lightGrid": every(1, (x, y) => x % 4 === 0 || y % 4 === 0); break;
    case "darkGrid": every(1, (x, y) => x % 4 < 2 || y % 4 < 2); break;
    case "lightTrellis": every(1, (x, y) => (x + y) % 4 === 0 || (x - y + TILE) % 4 === 0); break;
    case "darkTrellis": every(1, (x, y) => (x + y) % 4 < 2 || (x - y + TILE) % 4 < 2); break;
    default: every(2, () => true);
  }
}

const patternCache = new Map<string, CanvasImageSource>();

/** The tile canvas for a pattern + colours, built once. */
export function patternTile(pattern: string, fg: string, bg: string, make = defaultCanvas): CanvasImageSource | null {
  const key = `${pattern}|${fg}|${bg}`;
  const cached = patternCache.get(key);
  if (cached) return cached;
  const tile = make(TILE, TILE);
  const tctx = tile?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
  if (!tile || !tctx) return null;
  tctx.fillStyle = bg;
  tctx.fillRect(0, 0, TILE, TILE);
  tctx.fillStyle = fg;
  drawTile(tctx, pattern);
  patternCache.set(key, tile as CanvasImageSource);
  return tile as CanvasImageSource;
}

function defaultCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** A gradient brush over the cell box, following Excel's angle (0 = left to right, 90 = top to bottom). */
function gradientBrush(ctx: CanvasRenderingContext2D, fill: NonNullable<Extension["fill"]>, box: CellBox): CanvasGradient | null {
  const stops = fill.stops ?? [];
  if (!stops.length) return null;
  const { startX: x0, startY: y0, endX: x1, endY: y1 } = box;
  let brush: CanvasGradient;
  if (fill.gradient === "path") {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    brush = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(x1 - x0, y1 - y0) / 2);
  } else {
    const radians = ((fill.degree ?? 0) * Math.PI) / 180;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const half = (Math.abs(Math.cos(radians)) * (x1 - x0) + Math.abs(Math.sin(radians)) * (y1 - y0)) / 2;
    brush = ctx.createLinearGradient(
      cx - Math.cos(radians) * half, cy - Math.sin(radians) * half,
      cx + Math.cos(radians) * half, cy + Math.sin(radians) * half,
    );
  }
  for (const [position, colour] of stops) brush.addColorStop(Math.max(0, Math.min(1, position)), colour);
  return brush;
}

/** A data bar as a hard-stop gradient over the cell background. */
function barBrush(ctx: CanvasRenderingContext2D, bar: NonNullable<Extension["bar"]>, box: CellBox, background: string): CanvasGradient {
  const brush = ctx.createLinearGradient(box.startX, 0, box.endX, 0);
  const ratio = Math.max(0, Math.min(1, bar.ratio));
  brush.addColorStop(0, bar.color);
  if (ratio > 0) brush.addColorStop(ratio, mix(bar.color, "#FFFFFF", 0.6));
  brush.addColorStop(ratio, background);
  brush.addColorStop(1, background);
  return brush;
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const channel = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => channel(s).toString(16).padStart(2, "0")).join("")}`;
}

/** Swap the background brush for a pattern, gradient or data bar. Always lets Fortune draw on. */
export function beforeRenderCell(cell: Painted, box: CellBox, ctx: CanvasRenderingContext2D): boolean {
  const lcx = cell?.lcx;
  if (!lcx) return true;
  if (lcx.fill?.pattern) {
    const tile = patternTile(lcx.fill.pattern, lcx.fill.fg ?? "#000000", lcx.fill.bg ?? "#FFFFFF");
    const brush = tile ? ctx.createPattern(tile, "repeat") : null;
    if (brush) ctx.fillStyle = brush;
  } else if (lcx.fill?.gradient) {
    const brush = gradientBrush(ctx, lcx.fill, box);
    if (brush) ctx.fillStyle = brush;
  }
  if (lcx.bar) {
    const background = typeof ctx.fillStyle === "string" ? ctx.fillStyle : cell?.bg ?? "#FFFFFF";
    ctx.fillStyle = barBrush(ctx, lcx.bar, box, background);
  }
  return true;
}

const BUCKET_COLOURS: Record<number, string[]> = {
  3: ["#E0453A", "#F2B42B", "#4CA64C"],
  4: ["#E0453A", "#F2B42B", "#9BC84B", "#4CA64C"],
  5: ["#E0453A", "#F28C28", "#F2B42B", "#9BC84B", "#4CA64C"],
};

function iconCount(set: string): number {
  const found = /^(\d)/.exec(set);
  return found ? Number(found[1]) : 3;
}

/** Arrow sets point down for the lowest bucket, sideways in the middle, up for the highest. */
function drawIcon(ctx: CanvasRenderingContext2D, icon: NonNullable<Extension["icon"]>, box: CellBox): void {
  const count = iconCount(icon.set);
  const colours = BUCKET_COLOURS[count] ?? BUCKET_COLOURS[3];
  const index = Math.max(0, Math.min(count - 1, icon.index));
  const size = Math.min(12, box.endY - box.startY - 4);
  const cx = box.startX + 3 + size / 2;
  const cy = (box.startY + box.endY) / 2;
  ctx.save();
  ctx.fillStyle = /gray/i.test(icon.set) ? "#808080" : colours[index];
  ctx.beginPath();
  if (/arrow/i.test(icon.set)) {
    const angle = count === 1 ? 0 : Math.PI / 2 - (index / (count - 1)) * Math.PI; // +90deg (down) .. -90deg (up)
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    const h = size / 2;
    ctx.moveTo(h, 0);
    ctx.lineTo(0, -h);
    ctx.lineTo(0, -h / 2.5);
    ctx.lineTo(-h, -h / 2.5);
    ctx.lineTo(-h, h / 2.5);
    ctx.lineTo(0, h / 2.5);
    ctx.lineTo(0, h);
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
}

function drawDropdown(ctx: CanvasRenderingContext2D, box: CellBox): void {
  const size = 7;
  const x = box.endX - size - 4;
  const y = (box.startY + box.endY) / 2 - size / 4;
  ctx.save();
  ctx.fillStyle = "#6B7280";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x + size / 2, y + size / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Icons and the list arrow, drawn over the finished cell. */
export function afterRenderCell(cell: Painted, box: CellBox, ctx: CanvasRenderingContext2D): void {
  const lcx = cell?.lcx;
  if (!lcx) return;
  if (lcx.icon) drawIcon(ctx, lcx.icon, box);
  if (lcx.dropdown) drawDropdown(ctx, box);
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** A web link opens in a new tab, never in the canvas's own window; other schemes are ignored. */
export function openWebLink(address: string, open: typeof window.open = window.open.bind(window)): boolean {
  if (!SAFE_LINK.test(address)) return false;
  open(address, "_blank", "noopener,noreferrer");
  return true;
}

/** A click on a linked cell opens its web link. */
export function afterCellMouseDown(cell: Painted): void {
  const link = cell?.lcx?.link;
  if (link) openWebLink(link);
}

/** Fortune `hooks` for a read-only workbook. */
export const SHEET_PAINT_HOOKS = { beforeRenderCell, afterRenderCell, afterCellMouseDown } as const;
