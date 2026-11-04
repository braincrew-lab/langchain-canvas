export type PageZoom = number | "width" | "page";
export interface ReadingAnchor { page: number; x: number; y: number }

export const PAGE_BASELINE_WIDTH = 1600;
export const MIN_PAGE_ZOOM = 0.1;
export const MAX_PAGE_ZOOM = 2;

export function pageDisplayWidth(zoom: PageZoom, width: number, height: number, aspectRatio: number): number {
  if (typeof zoom === "number") return PAGE_BASELINE_WIDTH * zoom;
  const availableWidth = Math.max(1, width);
  return zoom === "page" ? Math.min(availableWidth, Math.max(1, height) * aspectRatio) : availableWidth;
}

/** A page destination is a whole decimal number; valid out-of-range values clamp. */
export function parsePageDestination(value: string, count: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || count < 1) return null;
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number)) return null;
  return Math.max(1, Math.min(count, number));
}

export function readingScrollPosition(
  anchor: ReadingAnchor,
  sheet: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: Math.max(0, sheet.left + anchor.x * sheet.width - viewport.width / 2),
    top: Math.max(0, sheet.top + anchor.y * sheet.height - viewport.height / 2),
  };
}
