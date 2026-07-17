/**
 * A free-positioning slide canvas (the "blank" layout) — like PowerPoint's real
 * editing surface. Elements (text boxes, images) can be dragged to move,
 * dragged from the corner to resize, double-clicked to edit text, and deleted.
 * Geometry is stored as percentages (0–100) of the 16:9 slide, so it's
 * resolution-independent and exports cleanly to .pptx.
 */

import { useEffect, useRef, useState } from "react";

import type { SlideElement } from "../../protocol/artifacts";

interface FreeSlideProps {
  elements: SlideElement[];
  onChange: (elements: SlideElement[]) => void;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

let dupSeq = 0;
/** A collision-proof id for a duplicated element (array length isn't unique
 *  once elements have been deleted). */
const dupId = (base: string) => `${base}_c${Date.now().toString(36)}${dupSeq++}`;

/** Snap threshold in percent-of-slide; below this an anchor locks onto a guide. */
const SNAP = 1.2;

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

export function FreeSlide({ elements, onChange }: FreeSlideProps) {
  const slideRef = useRef<HTMLDivElement>(null);
  const [els, setEls] = useState(elements);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; orig: SlideElement } | null>(null);

  // Sync from props except while a drag is in flight (don't clobber live edits).
  useEffect(() => {
    if (!drag.current) setEls(elements);
  }, [elements]);

  const commit = (next: SlideElement[]) => {
    setEls(next);
    onChange(next);
  };
  const updateEl = (id: string, partial: Partial<SlideElement>) =>
    commit(els.map((el) => (el.id === id ? { ...el, ...partial } : el)));

  const duplicate = (el: SlideElement) => {
    const copy: SlideElement = {
      ...el,
      id: dupId(el.id),
      x: Math.min(el.x + 4, 100 - el.w),
      y: Math.min(el.y + 4, 100 - el.h),
    };
    commit([...els, copy]);
    setSelected(copy.id);
  };
  /** Reorder in the paint order (array end = front). dir +1 = forward, -1 = back. */
  const zorder = (id: string, dir: 1 | -1) => {
    const i = els.findIndex((e) => e.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= els.length) return;
    const next = [...els];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  };

  const onDown = (e: React.PointerEvent, el: SlideElement, mode: "move" | "resize") => {
    if (editingId === el.id && mode === "move") return; // let text editing interact
    e.preventDefault();
    e.stopPropagation();
    setSelected(el.id);
    drag.current = { id: el.id, mode, sx: e.clientX, sy: e.clientY, orig: { ...el } };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const rect = slideRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = ((e.clientX - d.sx) / rect.width) * 100;
    const dy = ((e.clientY - d.sy) / rect.height) * 100;

    if (d.mode === "resize") {
      setGuides({ x: null, y: null });
      setEls((prev) => prev.map((el) => (el.id === d.id ? { ...el, w: clamp(d.orig.w + dx, 6, 100 - el.x), h: clamp(d.orig.h + dy, 5, 100 - el.y) } : el)));
      return;
    }

    // Move + snap: align this element's edges/center to the slide and its peers.
    const others = els.filter((el) => el.id !== d.id);
    const xTargets = [0, 50, 100, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
    const yTargets = [0, 50, 100, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
    const rawX = clamp(d.orig.x + dx, 0, 100 - d.orig.w);
    const rawY = clamp(d.orig.y + dy, 0, 100 - d.orig.h);
    const sx = snapAxis(rawX, d.orig.w, xTargets);
    const sy = snapAxis(rawY, d.orig.h, yTargets);
    setGuides({ x: sx.guide, y: sy.guide });
    setEls((prev) =>
      prev.map((el) =>
        el.id === d.id ? { ...el, x: clamp(sx.pos, 0, 100 - el.w), y: clamp(sy.pos, 0, 100 - el.h) } : el,
      ),
    );
  };
  const onUp = () => {
    if (drag.current) {
      drag.current = null;
      setGuides({ x: null, y: null });
      onChange(els);
    }
  };

  // Keyboard: nudge / delete / duplicate / deselect the selected element.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (editingId) return; // typing inside a text box
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae as HTMLElement).isContentEditable)) return;
      const el = els.find((x) => x.id === selected);
      if (!el) return;

      const step = e.shiftKey ? 5 : 1;
      const nudge = (ddx: number, ddy: number) => {
        e.preventDefault();
        commit(els.map((x) => (x.id === selected ? { ...x, x: clamp(x.x + ddx, 0, 100 - x.w), y: clamp(x.y + ddy, 0, 100 - x.h) } : x)));
      };
      if (e.key === "ArrowLeft") nudge(-step, 0);
      else if (e.key === "ArrowRight") nudge(step, 0);
      else if (e.key === "ArrowUp") nudge(0, -step);
      else if (e.key === "ArrowDown") nudge(0, step);
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        commit(els.filter((x) => x.id !== selected));
        setSelected(null);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicate(el);
      } else if (e.key === "Escape") {
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, editingId, els]);

  return (
    <div
      className="cv-free"
      ref={slideRef}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onClick={() => {
        setSelected(null);
        setEditingId(null);
      }}
    >
      {guides.x !== null && <span className="cv-free__guide cv-free__guide--v" style={{ left: `${guides.x}%` }} />}
      {guides.y !== null && <span className="cv-free__guide cv-free__guide--h" style={{ top: `${guides.y}%` }} />}
      {els.map((el) => (
        <div
          key={el.id}
          className={`cv-free__el ${selected === el.id ? "is-selected" : ""}`}
          style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%` }}
          onPointerDown={(e) => onDown(e, el, "move")}
          onDoubleClick={(e) => {
            if (el.type === "text") {
              e.stopPropagation();
              setEditingId(el.id);
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            setSelected(el.id);
          }}
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
          ) : (
            <img className="cv-free__img" src={el.src} alt="" draggable={false} />
          )}

          {selected === el.id && el.type === "text" && (
            <div className={`cv-free__fmt ${el.y < 16 ? "cv-free__fmt--below" : ""}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <button className={el.bold ? "is-on" : ""} onClick={() => updateEl(el.id, { bold: !el.bold })} title="Bold">
                <b>B</b>
              </button>
              <input
                type="number"
                min={8}
                max={120}
                value={el.fontSize ?? 24}
                onChange={(e) => updateEl(el.id, { fontSize: Number(e.target.value) })}
                title="Font size"
              />
              <input type="color" value={el.color ?? "#1f2328"} onChange={(e) => updateEl(el.id, { color: e.target.value })} title="Text color" />
              <button onClick={() => updateEl(el.id, { align: "left" })} title="Align left">⟸</button>
              <button onClick={() => updateEl(el.id, { align: "center" })} title="Align center">≡</button>
              <button onClick={() => updateEl(el.id, { align: "right" })} title="Align right">⟹</button>
            </div>
          )}

          {selected === el.id && (
            <>
              <span className="cv-free__resize" onPointerDown={(e) => onDown(e, el, "resize")} />
              <div className={`cv-free__ctl ${el.y < 16 ? "cv-free__ctl--below" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
                <button onClick={(e) => { e.stopPropagation(); duplicate(el); }} title="Duplicate">⧉</button>
                <button onClick={(e) => { e.stopPropagation(); zorder(el.id, 1); }} title="Bring forward">↑</button>
                <button onClick={(e) => { e.stopPropagation(); zorder(el.id, -1); }} title="Send back">↓</button>
                <button className="cv-free__ctl-del" onClick={(e) => { e.stopPropagation(); commit(els.filter((x) => x.id !== el.id)); }} title="Delete">×</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
