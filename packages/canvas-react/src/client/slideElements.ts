/**
 * Slides are always a free canvas of positioned elements. Agents may still emit
 * the structured shape (title / bullets / layout); `toElements` derives movable
 * elements from it (with *deterministic* ids so React keys stay stable across
 * renders), and `resolveElements` prefers an explicit `elements` array once the
 * user has edited. The renderer, presenter, and every exporter go through
 * `resolveElements`, so there is one source of truth for what's on a slide.
 */

import type { Slide, SlideElement } from "../protocol/artifacts";

export function toElements(s: Slide): SlideElement[] {
  const layout = s.layout ?? "content";
  const els: SlideElement[] = [];
  const push = (id: string, e: Omit<SlideElement, "id" | "color"> & { color?: string }) =>
    els.push({ color: s.textColor, ...e, id });

  if (layout === "title" || layout === "section") {
    if (s.title) push("title", { type: "text", x: 10, y: 34, w: 80, h: 18, text: s.title, fontSize: layout === "title" ? 54 : 40, bold: true, align: "center" });
    if (s.subtitle) push("subtitle", { type: "text", x: 10, y: 58, w: 80, h: 8, text: s.subtitle, fontSize: 24, align: "center" });
  } else if (layout === "image") {
    if (s.title) push("title", { type: "text", x: 6, y: 6, w: 88, h: 10, text: s.title, fontSize: 28, bold: true });
    if (s.image) els.push({ id: "img", type: "image", x: 14, y: 20, w: 72, h: 66, src: s.image });
  } else if (layout === "two-column") {
    if (s.title) push("title", { type: "text", x: 6, y: 6, w: 88, h: 10, text: s.title, fontSize: 28, bold: true });
    (s.bullets ?? []).forEach((b, i) => push(`bul_${i}`, { type: "text", x: 6, y: 24 + i * 8, w: 42, h: 7, text: `• ${b}`, fontSize: 18 }));
    (s.bullets2 ?? []).forEach((b, i) => push(`bul2_${i}`, { type: "text", x: 52, y: 24 + i * 8, w: 42, h: 7, text: `• ${b}`, fontSize: 18 }));
  } else {
    if (s.title) push("title", { type: "text", x: 6, y: 8, w: 88, h: 10, text: s.title, fontSize: 32, bold: true });
    (s.bullets ?? []).forEach((b, i) => push(`bul_${i}`, { type: "text", x: 8, y: 28 + i * 9, w: 84, h: 8, text: `• ${b}`, fontSize: 20 }));
  }
  return els;
}

/** The elements actually on a slide: explicit edits win; otherwise derive. */
export const resolveElements = (s: Slide): SlideElement[] => (s.elements?.length ? s.elements : toElements(s));
