/**
 * A free-positioning slide canvas (the "blank" layout) — like PowerPoint's real
 * editing surface. Elements (text boxes, images) can be dragged to move,
 * dragged from the corner to resize, double-clicked to edit text, and deleted.
 * Selection is Figma-grade: shift+click and an empty-canvas marquee build a
 * multi-selection that moves, nudges, aligns, duplicates, and deletes as one;
 * ⌘G groups elements so they keep selecting together. Geometry is stored as
 * percentages (0–100) of the 16:9 slide, so it's resolution-independent and
 * exports cleanly to .pptx.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { SlideElement } from "../../protocol/artifacts";
import { useT } from "../../i18n/i18n";

/** CSS for a shape element's body — shared by the editor, thumbnails, present, and
 *  export so a rectangle/ellipse/line looks the same everywhere. */
export function shapeStyle(el: SlideElement): CSSProperties {
  const fill = el.fill ?? "currentColor";
  if (el.shape === "ellipse") return { width: "100%", height: "100%", background: fill, borderRadius: "50%" };
  if (el.shape === "line") return { width: "100%", height: "100%", background: fill, borderRadius: 2 };
  return { width: "100%", height: "100%", background: fill, borderRadius: el.radius ?? 8 };
}

/**
 * CSS transform for an element's rotation — shared by the editor, thumbnails,
 * present, and export paths so a rotated element looks the same everywhere.
 * Applied to the element wrapper with the default transform-origin (center).
 */
export function rotateStyle(el: SlideElement): CSSProperties {
  return el.rotate ? { transform: `rotate(${el.rotate}deg)` } : {};
}

/** Normalize a rotation to 0–359°, dropping 0 (no rotation stored). */
const normalizeDeg = (deg: number): number | undefined => {
  const d = ((deg % 360) + 360) % 360;
  return d === 0 ? undefined : d;
};

interface FreeSlideProps {
  elements: SlideElement[];
  onChange: (elements: SlideElement[]) => void;
  /** Content padding as a percent of the slide — insets the free canvas so
   *  element geometry maps into a safe margin. */
  padding?: number;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

let dupSeq = 0;
/** A collision-proof id for a duplicated element (array length isn't unique
 *  once elements have been deleted). */
const dupId = (base: string) => `${base}_c${Date.now().toString(36)}${dupSeq++}`;

let groupSeq = 0;
/** A fresh id for a ⌘G group (or for the copy of a group being duplicated). */
const newGroupId = () => `grp_${Date.now().toString(36)}${groupSeq++}`;

/**
 * In-memory element clipboard for ⌘C/⌘V. Module-level on purpose: it survives
 * slide switches and remounts, so elements copy across slides in the same deck.
 */
let elementClipboard: SlideElement[] = [];

/** Snap threshold in percent-of-slide; below this an anchor locks onto a guide. */
const SNAP = 1.2;

/** Arrow-key nudge distances in percent-of-slide. */
const NUDGE_STEP = 0.5;
const NUDGE_STEP_BIG = 2;

/**
 * Snap one axis of the dragged element to the slide (0 / 50 / 100) and to the
 * edges/centers of the other elements. Returns the adjusted coordinate and the
 * guide line to draw (in %), or null when nothing is within range.
 */
function snapAxis(pos: number, size: number, targets: number[]): { pos: number; guide: number | null } {
  const anchors = [pos, pos + size / 2, pos + size]; // start, center, end
  let best: { delta: number; guide: number } | null = null;
  for (const anchor of anchors) {
    for (const t of targets) {
      const delta = t - anchor;
      if (Math.abs(delta) <= SNAP && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, guide: t };
      }
    }
  }
  return best ? { pos: pos + best.delta, guide: best.guide } : { pos, guide: null };
}

/** Bounding box of a set of elements, in percent-of-slide. */
function boundsOf(els: SlideElement[]) {
  const x1 = Math.min(...els.map((el) => el.x));
  const y1 = Math.min(...els.map((el) => el.y));
  const x2 = Math.max(...els.map((el) => el.x + el.w));
  const y2 = Math.max(...els.map((el) => el.y + el.h));
  return { x1, y1, x2, y2 };
}

export function FreeSlide({ elements, onChange, padding }: FreeSlideProps) {
  const t = useT();
  const slideRef = useRef<HTMLDivElement>(null);
  const [els, setEls] = useState(elements);
  const [selected, setSelected] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const drag = useRef<{
    /** All elements the gesture moves (the whole selection for "move"). */
    ids: string[];
    /** The element under the pointer — snap reference and resize target. */
    id: string;
    mode: "move" | "resize";
    sx: number;
    sy: number;
    origs: Map<string, SlideElement>;
    moved: boolean;
    /** Pointer went down on an already-selected element — a motionless click
     *  then collapses the multi-selection down to that element('s group). */
    wasSelected: boolean;
  } | null>(null);
  // Marquee lives in a ref (pointermove logic) mirrored into state (render).
  const marquee = useRef<{ x0: number; y0: number; x1: number; y1: number; moved: boolean } | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // A marquee release bubbles a click to the canvas; don't let it clear the fresh selection.
  const suppressCanvasClick = useRef(false);

  // Sync from props except while a drag is in flight (don't clobber live edits),
  // and drop selected ids that no longer exist (slide switched, element removed).
  useEffect(() => {
    if (!drag.current) setEls(elements);
    setSelected((prev) => prev.filter((id) => elements.some((el) => el.id === id)));
  }, [elements]);

  const selectedSet = new Set(selected);
  const selEls = els.filter((el) => selectedSet.has(el.id));
  const soloId = selEls.length === 1 ? selEls[0].id : null;

  const commit = (next: SlideElement[]) => {
    setEls(next);
    onChange(next);
  };
  const updateEl = (id: string, partial: Partial<SlideElement>) =>
    commit(els.map((el) => (el.id === id ? { ...el, ...partial } : el)));

  /** The selection unit for an element: its whole group, or just itself. */
  const groupOf = (id: string): string[] => {
    const el = els.find((x) => x.id === id);
    if (!el?.group) return [id];
    const gid = el.group;
    return els.filter((x) => x.group === gid).map((x) => x.id);
  };
  /** Expand a set of ids so every represented group is fully included. */
  const expandGroups = (ids: string[]): string[] => {
    const out = new Set<string>();
    for (const id of ids) for (const member of groupOf(id)) out.add(member);
    return [...out];
  };

  /** Clone elements with fresh ids (fresh — but still shared — group ids) and a
   *  small offset, for duplicate and paste. */
  const cloneElements = (source: SlideElement[], offset: number): SlideElement[] => {
    const groupMap = new Map<string, string>();
    return source.map((el) => {
      const copy: SlideElement = {
        ...el,
        id: dupId(el.id),
        x: clamp(el.x + offset, 0, 100 - el.w),
        y: clamp(el.y + offset, 0, 100 - el.h),
      };
      if (el.group) {
        if (!groupMap.has(el.group)) groupMap.set(el.group, newGroupId());
        copy.group = groupMap.get(el.group)!;
      }
      return copy;
    });
  };

  const duplicateSelection = () => {
    if (selEls.length === 0) return;
    const copies = cloneElements(selEls, 4);
    commit([...els, ...copies]);
    setSelected(copies.map((c) => c.id));
  };
  const copySelection = () => {
    if (selEls.length > 0) elementClipboard = selEls.map((el) => ({ ...el }));
  };
  const pasteClipboard = () => {
    if (elementClipboard.length === 0) return;
    const pasted = cloneElements(elementClipboard, 3);
    commit([...els, ...pasted]);
    setSelected(pasted.map((p) => p.id));
  };
  const deleteSelection = () => {
    if (selEls.length === 0) return;
    commit(els.filter((el) => !selectedSet.has(el.id)));
    setSelected([]);
  };

  const groupSelection = () => {
    if (selEls.length < 2) return;
    const gid = newGroupId();
    commit(els.map((el) => (selectedSet.has(el.id) ? { ...el, group: gid } : el)));
  };
  const ungroupSelection = () => {
    if (!selEls.some((el) => el.group)) return;
    commit(
      els.map((el) => {
        if (!selectedSet.has(el.id) || !el.group) return el;
        const { group: _group, ...rest } = el;
        return rest;
      }),
    );
  };

  /**
   * Move the whole selection through the paint order (array end = front) — one
   * step for forward/backward, all the way for front/back. Relative order
   * inside the selection is preserved.
   */
  const reorderSelection = (dir: 1 | -1, extreme = false) => {
    if (selEls.length === 0) return;
    if (extreme) {
      const sel = els.filter((el) => selectedSet.has(el.id));
      const rest = els.filter((el) => !selectedSet.has(el.id));
      commit(dir === 1 ? [...rest, ...sel] : [...sel, ...rest]);
      return;
    }
    const next = [...els];
    if (dir === 1) {
      for (let i = next.length - 2; i >= 0; i--) {
        if (selectedSet.has(next[i].id) && !selectedSet.has(next[i + 1].id)) [next[i], next[i + 1]] = [next[i + 1], next[i]];
      }
    } else {
      for (let i = 1; i < next.length; i++) {
        if (selectedSet.has(next[i].id) && !selectedSet.has(next[i - 1].id)) [next[i], next[i - 1]] = [next[i - 1], next[i]];
      }
    }
    commit(next);
  };

  /** Joint clamp for moving the selection as one: the delta every selected
   *  element can absorb without leaving the slide. */
  const clampDelta = (dx: number, dy: number, targets: SlideElement[]) => {
    let loX = -100, hiX = 100, loY = -100, hiY = 100;
    for (const el of targets) {
      loX = Math.max(loX, -el.x);
      hiX = Math.min(hiX, 100 - el.w - el.x);
      loY = Math.max(loY, -el.y);
      hiY = Math.min(hiY, 100 - el.h - el.y);
    }
    return { dx: clamp(dx, loX, hiX), dy: clamp(dy, loY, hiY) };
  };

  /** Arrow-key nudge: move every selected element by one step, kept on-slide. */
  const nudgeSelection = (ddx: number, ddy: number) => {
    const { dx, dy } = clampDelta(ddx, ddy, selEls);
    if (dx === 0 && dy === 0) return;
    commit(els.map((el) => (selectedSet.has(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el)));
  };

  /** Align the selected elements to the selection's own bounding box. */
  const alignSelection = (op: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    if (selEls.length < 2) return;
    const b = boundsOf(selEls);
    commit(
      els.map((el) => {
        if (!selectedSet.has(el.id)) return el;
        if (op === "left") return { ...el, x: b.x1 };
        if (op === "center") return { ...el, x: b.x1 + (b.x2 - b.x1 - el.w) / 2 };
        if (op === "right") return { ...el, x: b.x2 - el.w };
        if (op === "top") return { ...el, y: b.y1 };
        if (op === "middle") return { ...el, y: b.y1 + (b.y2 - b.y1 - el.h) / 2 };
        return { ...el, y: b.y2 - el.h };
      }),
    );
  };

  const toPct = (e: { clientX: number; clientY: number }) => {
    const rect = slideRef.current!.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100),
    };
  };

  const onDown = (e: React.PointerEvent, el: SlideElement, mode: "move" | "resize") => {
    if (editingId === el.id && mode === "move") return; // let text editing interact
    e.preventDefault();
    e.stopPropagation();
    slideRef.current?.focus(); // route keyboard shortcuts to the canvas

    if (mode === "move" && e.shiftKey) {
      // Shift+click toggles the element (or its whole group) in/out of the selection.
      const unit = groupOf(el.id);
      setSelected((prev) =>
        prev.some((id) => unit.includes(id))
          ? prev.filter((id) => !unit.includes(id))
          : [...prev, ...unit.filter((id) => !prev.includes(id))],
      );
      return;
    }

    const wasSelected = selectedSet.has(el.id);
    // Dragging any selected element moves the whole selection; an unselected
    // element first becomes the selection (with its group).
    const ids = mode === "resize" ? [el.id] : wasSelected ? selected : groupOf(el.id);
    if (!wasSelected) setSelected(mode === "resize" ? [el.id] : groupOf(el.id));
    drag.current = {
      ids,
      id: el.id,
      mode,
      sx: e.clientX,
      sy: e.clientY,
      origs: new Map(els.filter((x) => ids.includes(x.id)).map((x) => [x.id, { ...x }])),
      moved: false,
      wasSelected,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onCanvasDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return; // only the empty canvas starts a marquee
    e.preventDefault();
    slideRef.current?.focus();
    const p = toPct(e);
    marquee.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const rect = slideRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Marquee in flight: live-update the box and select every intersecting element.
    const mq = marquee.current;
    if (mq) {
      const p = toPct(e);
      mq.x1 = p.x;
      mq.y1 = p.y;
      mq.moved = true;
      setMarqueeBox({ x0: mq.x0, y0: mq.y0, x1: mq.x1, y1: mq.y1 });
      const rx1 = Math.min(mq.x0, mq.x1), rx2 = Math.max(mq.x0, mq.x1);
      const ry1 = Math.min(mq.y0, mq.y1), ry2 = Math.max(mq.y0, mq.y1);
      const hits = els
        .filter((el) => el.x < rx2 && el.x + el.w > rx1 && el.y < ry2 && el.y + el.h > ry1)
        .map((el) => el.id);
      setSelected(expandGroups(hits));
      return;
    }

    const d = drag.current;
    if (!d) return;
    const dx = ((e.clientX - d.sx) / rect.width) * 100;
    const dy = ((e.clientY - d.sy) / rect.height) * 100;
    if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) d.moved = true;
    const orig = d.origs.get(d.id);
    if (!orig) return;

    // Guide targets shared by move and resize: the slide's edges and center
    // lines plus every element outside the gesture.
    const others = els.filter((el) => !d.ids.includes(el.id));
    const xTargets = [0, 50, 100, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
    const yTargets = [0, 50, 100, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];

    if (d.mode === "resize") {
      if (e.shiftKey) {
        // Aspect lock: scale both axes from the dominant one, no snapping (a
        // one-axis snap would break the locked ratio).
        const scale = Math.abs(dx) / orig.w > Math.abs(dy) / orig.h ? (orig.w + dx) / orig.w : (orig.h + dy) / orig.h;
        const sMin = Math.max(6 / orig.w, 5 / orig.h);
        const sMax = Math.min((100 - orig.x) / orig.w, (100 - orig.y) / orig.h);
        const s = clamp(scale, sMin, sMax);
        setGuides({ x: null, y: null });
        setEls((prev) => prev.map((el) => (el.id === d.id ? { ...el, w: orig.w * s, h: orig.h * s } : el)));
        return;
      }
      // Resize + snap: only the right/bottom edge moves, so snap that edge
      // (size 0 → the lone anchor is the edge itself), then re-clamp. Drop the
      // guide if clamping pulled the edge off the matched line.
      const gx = snapAxis(orig.x + clamp(orig.w + dx, 6, 100 - orig.x), 0, xTargets);
      const gy = snapAxis(orig.y + clamp(orig.h + dy, 5, 100 - orig.y), 0, yTargets);
      const w = clamp(gx.pos - orig.x, 6, 100 - orig.x);
      const h = clamp(gy.pos - orig.y, 5, 100 - orig.y);
      setGuides({
        x: gx.guide !== null && Math.abs(orig.x + w - gx.guide) < 0.01 ? gx.guide : null,
        y: gy.guide !== null && Math.abs(orig.y + h - gy.guide) < 0.01 ? gy.guide : null,
      });
      setEls((prev) => prev.map((el) => (el.id === d.id ? { ...el, w, h } : el)));
      return;
    }

    // Move + snap: the whole selection shifts by one delta, jointly clamped so
    // nothing leaves the slide; guides come off the dragged element only.
    const origs = [...d.origs.values()];
    const c = clampDelta(dx, dy, origs);
    const sx = snapAxis(orig.x + c.dx, orig.w, xTargets);
    const sy = snapAxis(orig.y + c.dy, orig.h, yTargets);
    const snapped = clampDelta(sx.pos - orig.x, sy.pos - orig.y, origs);
    setGuides({
      x: sx.guide !== null && Math.abs(snapped.dx - (sx.pos - orig.x)) < 0.01 ? sx.guide : null,
      y: sy.guide !== null && Math.abs(snapped.dy - (sy.pos - orig.y)) < 0.01 ? sy.guide : null,
    });
    setEls((prev) =>
      prev.map((el) => {
        const o = d.origs.get(el.id);
        return o ? { ...el, x: o.x + snapped.dx, y: o.y + snapped.dy } : el;
      }),
    );
  };

  const onUp = () => {
    if (marquee.current) {
      if (marquee.current.moved) suppressCanvasClick.current = true;
      marquee.current = null;
      setMarqueeBox(null);
      return;
    }
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setGuides({ x: null, y: null });
    if (d.moved) {
      onChange(els); // one commit per gesture
      return;
    }
    // Motionless click on an already-selected element: collapse the
    // multi-selection down to that element (or its whole group).
    if (d.mode === "move" && d.wasSelected) setSelected(groupOf(d.id));
  };

  // Keyboard shortcuts, scoped to the canvas (it's focusable and pointer-downs
  // focus it) — typing in text elements and toolbar inputs is never intercepted.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editingId) return; // typing inside a text box
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    const meta = e.metaKey || e.ctrlKey;

    if (e.key === "Escape") {
      setSelected([]);
      setEditingId(null);
      return;
    }
    if (meta && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      pasteClipboard();
      return;
    }
    if (selEls.length === 0) return;

    const step = e.shiftKey ? NUDGE_STEP_BIG : NUDGE_STEP;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (e.key === "ArrowLeft") nudgeSelection(-step, 0);
      else if (e.key === "ArrowRight") nudgeSelection(step, 0);
      else if (e.key === "ArrowUp") nudgeSelection(0, -step);
      else nudgeSelection(0, step);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelection();
    } else if (meta && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      duplicateSelection();
    } else if (meta && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      copySelection();
    } else if (meta && (e.key === "g" || e.key === "G")) {
      e.preventDefault();
      if (e.shiftKey) ungroupSelection();
      else groupSelection();
    } else if (meta && e.key === "]") {
      e.preventDefault();
      reorderSelection(1);
    } else if (meta && e.key === "[") {
      e.preventDefault();
      reorderSelection(-1);
    }
  };

  const multiBounds = selEls.length >= 2 ? boundsOf(selEls) : null;
  const multibarBelow = multiBounds !== null && multiBounds.y1 < 16;

  return (
    <div
      className="cv-free"
      ref={slideRef}
      tabIndex={0}
      style={padding ? { inset: `${padding}%` } : undefined}
      onPointerDown={onCanvasDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (suppressCanvasClick.current) {
          suppressCanvasClick.current = false;
          return;
        }
        setSelected([]);
        setEditingId(null);
      }}
    >
      {guides.x !== null && <span className="cv-free__guide cv-free__guide--v" style={{ left: `${guides.x}%` }} />}
      {guides.y !== null && <span className="cv-free__guide cv-free__guide--h" style={{ top: `${guides.y}%` }} />}
      {marqueeBox && (
        <span
          className="cv-free__marquee"
          style={{
            left: `${Math.min(marqueeBox.x0, marqueeBox.x1)}%`,
            top: `${Math.min(marqueeBox.y0, marqueeBox.y1)}%`,
            width: `${Math.abs(marqueeBox.x1 - marqueeBox.x0)}%`,
            height: `${Math.abs(marqueeBox.y1 - marqueeBox.y0)}%`,
          }}
        />
      )}
      {/* Rotation is a visual transform on the wrapper only: drag, nudge, snap
          guides, marquee hit-testing, and resize all keep operating on the
          stored (unrotated) x/y/w/h box, so the pointer math above needs no
          angle awareness. Note the selection chrome rotates with the element. */}
      {els.map((el) => (
        <div
          key={el.id}
          className={`cv-free__el ${selectedSet.has(el.id) ? "is-selected cv-free__el--selected" : ""}`}
          style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, ...rotateStyle(el) }}
          onPointerDown={(e) => onDown(e, el, "move")}
          onDoubleClick={(e) => {
            if (el.type === "text") {
              e.stopPropagation();
              setEditingId(el.id);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {el.type === "text" ? (
            <div
              className="cv-free__text"
              contentEditable={editingId === el.id}
              suppressContentEditableWarning
              style={{
                fontSize: el.fontSize ?? 24,
                fontWeight: el.bold ? 700 : 400,
                color: el.color,
                textAlign: el.align ?? "left",
              }}
              onBlur={(e) => {
                setEditingId(null);
                updateEl(el.id, { text: e.currentTarget.textContent ?? "" });
              }}
            >
              {el.text}
            </div>
          ) : el.type === "shape" ? (
            <div style={shapeStyle(el)} />
          ) : (
            <img
              className="cv-free__img"
              src={el.src}
              alt=""
              draggable={false}
              style={{ objectFit: el.fit ?? "contain", ...(el.radius ? { borderRadius: el.radius } : {}) }}
            />
          )}

          {soloId === el.id && el.type === "text" && (
            <div className={`cv-free__fmt ${el.y < 16 ? "cv-free__fmt--below" : ""}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <button className={el.bold ? "is-on" : ""} onClick={() => updateEl(el.id, { bold: !el.bold })} title={t("bold")}>
                <b>B</b>
              </button>
              <input
                type="number"
                min={8}
                max={120}
                value={el.fontSize ?? 24}
                onChange={(e) => updateEl(el.id, { fontSize: Number(e.target.value) })}
                title={t("fontSize")}
              />
              <input type="color" value={el.color ?? "#1f2328"} onChange={(e) => updateEl(el.id, { color: e.target.value })} title={t("textColor")} />
              <button onClick={() => updateEl(el.id, { align: "left" })} title={t("alignLeft")}>⟸</button>
              <button onClick={() => updateEl(el.id, { align: "center" })} title={t("alignCenter")}>≡</button>
              <button onClick={() => updateEl(el.id, { align: "right" })} title={t("alignRight")}>⟹</button>
            </div>
          )}

          {soloId === el.id && (
            <>
              <span className="cv-free__resize" title={t("resizeTip")} onPointerDown={(e) => onDown(e, el, "resize")} />
              <div className={`cv-free__ctl ${el.y < 16 ? "cv-free__ctl--below" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
                {el.type === "shape" && (
                  <input className="cv-free__ctl-fill" type="color" value={el.fill ?? "#5b5bd6"} onChange={(e) => updateEl(el.id, { fill: e.target.value })} onClick={(e) => e.stopPropagation()} title={t("fillColor")} />
                )}
                {el.type === "image" && (
                  <button
                    className={el.fit === "cover" ? "is-on" : ""}
                    onClick={(e) => { e.stopPropagation(); updateEl(el.id, { fit: el.fit === "cover" ? undefined : "cover" }); }}
                    title={t("fitToggle")}
                  >⛶</button>
                )}
                {(el.type === "image" || el.shape === "rect") && (
                  <input
                    className="cv-free__ctl-radius"
                    type="number"
                    min={0}
                    max={32}
                    value={el.radius ?? (el.type === "shape" ? 8 : 0)}
                    onChange={(e) => updateEl(el.id, { radius: clamp(Number(e.target.value) || 0, 0, 32) })}
                    onClick={(e) => e.stopPropagation()}
                    title={t("cornerRadius")}
                  />
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); updateEl(el.id, { rotate: normalizeDeg((el.rotate ?? 0) + (e.shiftKey ? -15 : 15)) }); }}
                  title={t("rotateStep")}
                >⟳</button>
                <input
                  className="cv-free__ctl-rot"
                  type="number"
                  min={-360}
                  max={360}
                  value={Math.round(el.rotate ?? 0)}
                  onChange={(e) => {
                    const deg = Number(e.target.value);
                    updateEl(el.id, { rotate: Number.isFinite(deg) && deg !== 0 ? clamp(deg, -360, 360) : undefined });
                  }}
                  onClick={(e) => e.stopPropagation()}
                  title={t("rotationDeg")}
                />
                <button onClick={(e) => { e.stopPropagation(); duplicateSelection(); }} title={t("duplicateShort")}>⧉</button>
                <button onClick={(e) => { e.stopPropagation(); reorderSelection(1, true); }} title={t("bringToFront")}>⤒</button>
                <button onClick={(e) => { e.stopPropagation(); reorderSelection(1); }} title={t("bringForward")}>↑</button>
                <button onClick={(e) => { e.stopPropagation(); reorderSelection(-1); }} title={t("sendBackward")}>↓</button>
                <button onClick={(e) => { e.stopPropagation(); reorderSelection(-1, true); }} title={t("sendToBack")}>⤓</button>
                <button className="cv-free__ctl-del" onClick={(e) => { e.stopPropagation(); deleteSelection(); }} title={t("delete")}>×</button>
              </div>
            </>
          )}
        </div>
      ))}

      {multiBounds && !marqueeBox && (
        <div
          className={`cv-free__multibar ${multibarBelow ? "cv-free__multibar--below" : ""}`}
          style={{
            left: `${(multiBounds.x1 + multiBounds.x2) / 2}%`,
            top: multibarBelow ? `${multiBounds.y2}%` : `${multiBounds.y1}%`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={groupSelection} title={t("groupShort")}>⊞</button>
          <button onClick={ungroupSelection} disabled={!selEls.some((el) => el.group)} title={t("ungroupShort")}>⊟</button>
          <button onClick={() => alignSelection("left")} title={t("alignLeftEdges")}>⇤</button>
          <button onClick={() => alignSelection("center")} title={t("alignHCenters")}>↔</button>
          <button onClick={() => alignSelection("right")} title={t("alignRightEdges")}>⇥</button>
          <button onClick={() => alignSelection("top")} title={t("alignTopEdges")}>⤒</button>
          <button onClick={() => alignSelection("middle")} title={t("alignVCenters")}>↕</button>
          <button onClick={() => alignSelection("bottom")} title={t("alignBottomEdges")}>⤓</button>
          <button onClick={duplicateSelection} title={t("duplicateShort")}>⧉</button>
          <button className="cv-free__multibar-del" onClick={deleteSelection} title={t("deleteSelection")}>×</button>
        </div>
      )}
    </div>
  );
}
