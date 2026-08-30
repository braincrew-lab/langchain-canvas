/**
 * A free-positioning slide canvas (the "blank" layout) — like PowerPoint's real
 * editing surface. Elements (text boxes, images) can be dragged to move,
 * dragged from the corner to resize, double-clicked to edit text, and deleted.
 * Geometry is stored as percentages (0–100) of the deck page (`data.page`,
 * classic 16:9 when absent), so it's resolution-independent and exports
 * cleanly to .pptx.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { SlideElement } from "../../protocol/artifacts";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import { CELL_PAD_X, CELL_PAD_Y, cellKey, cellLook, tableGrid } from "../../client/slideTable";
import { boxHeightPct, textFitScale } from "../../client/slideText";

/** CSS for a shape element's body — shared by the editor, thumbnails, present, and
 *  export so a rectangle/ellipse/line looks the same everywhere. */
export function shapeStyle(el: SlideElement, scale = 1): CSSProperties {
  // A box drawn by its outline alone carries no fill: painting `currentColor`
  // in that case would hide what the border is meant to frame.
  const fill = el.fill ?? (el.stroke ? "transparent" : "currentColor");
  const border = el.stroke
    ? { border: `${Math.max(1, (el.strokeWidth ?? 1) * scale)}px solid ${el.stroke}`, boxSizing: "border-box" as const }
    : {};
  if (el.shape === "ellipse")
    return { width: "100%", height: "100%", background: fill, borderRadius: "50%", ...border };
  if (el.shape === "line") {
    // A line is drawn by its stroke, not its fill — the deck reader and the
    // pptx exporter both put its colour in `stroke`. It also keeps a visible
    // thickness however thin its box is (a 0.2%-tall box is one pixel).
    const colour = el.fill ?? el.stroke ?? "currentColor";
    return {
      width: "100%",
      height: "100%",
      minHeight: `${Math.max(1, (el.strokeWidth ?? 1) * scale)}px`,
      background: colour,
      borderRadius: 2,
    };
  }
  return { width: "100%", height: "100%", background: fill, borderRadius: 8, ...border };
}

/** CSS for a text element's body — shared by the editor, thumbnails and the
 *  present view. Every length the model stores in px (the font, the space
 *  above and below) is drawn at the same `scale` as the box it sits in, so a
 *  thumbnail is the slide made smaller rather than the slide with its
 *  paragraph spacing left at full size. */
export function textStyle(el: SlideElement, scale = 1): CSSProperties {
  return {
    fontSize: (el.fontSize ?? 24) * scale * textFitScale(el),
    fontWeight: el.bold ? 700 : 400,
    color: el.color,
    // A text outline (WordArt) rides the element's stroke fields.
    ...(el.stroke ? { WebkitTextStroke: `${Math.max(0.5, (el.strokeWidth ?? 1) * scale)}px ${el.stroke}` } : {}),
    textAlign: el.align ?? "left",
    whiteSpace: "pre-wrap",
    ...(el.fontFamily ? { fontFamily: el.fontFamily } : {}),
    ...(el.lineHeight ? { lineHeight: el.lineHeight } : {}),
    ...(el.highlight
      ? {
          background: el.highlight,
          boxDecorationBreak: "clone" as const,
          WebkitBoxDecorationBreak: "clone" as const,
        }
      : {}),
    ...(el.spaceBefore ? { paddingTop: el.spaceBefore * scale } : {}),
    ...(el.spaceAfter ? { paddingBottom: el.spaceAfter * scale } : {}),
    ...(el.verticalAlign
      ? {
          display: "flex",
          flexDirection: "column" as const,
          justifyContent:
            el.verticalAlign === "middle" ? "center" : el.verticalAlign === "bottom" ? "flex-end" : "flex-start",
          height: "100%",
        }
      : {}),
  };
}

interface SlideTableProps {
  el: SlideElement;
  /** Display scale for stored px (see `textStyle`). */
  scale?: number;
  /** Let columns be resized by their edge and cells be typed in. */
  editable?: boolean;
  onChange?: (partial: Partial<SlideElement>) => void;
  /** The cell (`"r,c"`) being typed in, owned by the parent: the box drag
   *  captures the pointer, so a double-click lands on the box, not the cell,
   *  and the parent has to say which cell it meant. */
  editingKey?: string | null;
  onEditingKey?: (key: string | null) => void;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
/** The narrowest a dragged column may get, in percent of the table. */
const MIN_COL = 5;

/** A table element as a real `<table>` — shared by the editor, thumbnails and
 *  the present view. The grid line, fills and text come from the element (and
 *  its `cells`), the way the pptx exporter writes them. In the editor a cell
 *  edits on double-click and a column's right edge drags its width. */
export function SlideTable({ el, scale = 1, editable = false, onChange, editingKey, onEditingKey }: SlideTableProps) {
  const grid = tableGrid(el);
  const tableRef = useRef<HTMLTableElement>(null);
  const editing = editable ? (editingKey ?? null) : null;
  const [live, setLive] = useState<number[] | null>(null);
  const grip = useRef<{ c: number; sx: number; widths: number[] } | null>(null);
  useEffect(() => {
    if (editing) focusEnd(tableRef.current?.querySelector<HTMLElement>(`td[data-cell="${editing}"]`));
  }, [editing]);
  // Rows are as tall as their text needs, the way PowerPoint grows them;
  // when that is more than the box, the box takes the table's height, so the
  // selection frame, the deck check and the exported file all agree.
  useEffect(() => {
    const table = tableRef.current;
    const box = table?.parentElement;
    if (!editable || !table || !box || !onChange) return;
    const observer = new ResizeObserver(() => {
      const need = table.offsetHeight;
      const have = box.offsetHeight;
      if (have > 0 && need > have * 1.02) onChange({ h: round3((el.h * need) / have) });
    });
    observer.observe(table);
    return () => observer.disconnect();
  }, [editable, onChange, el.h]);
  if (!grid) return <div className="cv-free__table-empty">table: no rows</div>;
  const widths = live ?? grid.colWidths;
  const border = el.stroke ? `${Math.max(1, (el.strokeWidth ?? 1) * scale)}px solid ${el.stroke}` : "none";
  const vAlign = el.verticalAlign === "middle" ? "middle" : el.verticalAlign === "bottom" ? "bottom" : "top";

  // A column drag listens on the window for as long as the button is down:
  // an 8px grip loses a fast pointer, and a drag that ends outside the
  // canvas must still land.
  const onGripDown = (e: React.PointerEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { c, sx: e.clientX, widths: grid.colWidths };
    grip.current = start;
    let latest: number[] | null = null;
    const move = (ev: PointerEvent) => {
      const rect = tableRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = ((ev.clientX - start.sx) / rect.width) * 100;
      // The two columns either side of the edge trade width; the rest keep theirs.
      const pair = start.widths[start.c] + start.widths[start.c + 1];
      const left = clamp(start.widths[start.c] + dx, MIN_COL, pair - MIN_COL);
      const next = [...start.widths];
      next[start.c] = round3(left);
      next[start.c + 1] = round3(pair - left);
      latest = next;
      setLive(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      grip.current = null;
      if (latest) onChange?.({ colWidths: latest });
      setLive(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const endEdit = (r: number, c: number, text: string) => {
    onEditingKey?.(null);
    if (text === grid.rows[r][c]) return;
    const rows = grid.rows.map((row) => [...row]);
    rows[r][c] = text;
    onChange?.({ rows });
  };

  // Column edges, as percent of the table width — where the grips sit.
  const edges: number[] = [];
  for (let i = 0; i < widths.length - 1; i++) edges.push((edges[i - 1] ?? 0) + widths[i]);
  return (
    <div className="cv-free__tablebox">
    <table
      ref={tableRef}
      className="cv-free__table"
      style={{ width: "100%", height: "100%", tableLayout: "fixed", borderCollapse: "collapse" }}
    >
      <colgroup>
        {widths.map((w, i) => (
          <col key={i} style={{ width: `${w}%` }} />
        ))}
      </colgroup>
      <tbody>
        {grid.rows.map((row, r) => (
          <tr key={r} style={{ height: `${grid.rowHeights[r]}%` }}>
            {row.map((text, c) => {
              const key = cellKey(r, c);
              if (grid.covered.has(key)) return null;
              const span = grid.spans.get(key);
              const look = cellLook(el, r, grid.styles.get(key));
              return (
                <td
                  key={c}
                  data-cell={key}
                  rowSpan={span?.[0]}
                  colSpan={span?.[1]}
                  contentEditable={editing === key}
                  suppressContentEditableWarning
                  style={{
                    border,
                    padding: `${CELL_PAD_Y * scale}px ${CELL_PAD_X * scale}px`,
                    verticalAlign: vAlign,
                    overflow: "hidden",
                    whiteSpace: "pre-wrap",
                    fontSize: look.fontSize * scale,
                    fontWeight: look.bold ? 700 : 400,
                    color: look.color,
                    textAlign: look.align,
                    background: look.fill,
                    ...(el.fontFamily ? { fontFamily: el.fontFamily } : {}),
                    // The host page's own leading (1.5 in a Tailwind app) made
                    // every row taller than the file says; the exporter and the
                    // deck check both assume 1.2.
                    lineHeight: el.lineHeight ?? 1.2,
                  }}
                  onPointerDown={(e) => {
                    if (editing === key) e.stopPropagation(); // let the caret move
                  }}
                  onBlur={(e) => {
                    if (editing === key) endEdit(r, c, e.currentTarget.textContent ?? "");
                  }}
                  onKeyDown={(e) => {
                    if (editing !== key) return;
                    e.stopPropagation(); // typing, not nudging the box
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.currentTarget.textContent = grid.rows[r][c];
                      e.currentTarget.blur();
                    } else if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault(); // Enter commits; Shift+Enter breaks the line
                      e.currentTarget.blur();
                    }
                  }}
                >
                  {text}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
    {editable &&
      edges.map((left, c) => (
        <span
          key={c}
          className="cv-free__colgrip"
          style={{ left: `calc(${left}% - 5px)` }}
          title="Drag to resize the column"
          onPointerDown={(e) => onGripDown(e, c)}
        />
      ))}
    </div>
  );
}

interface FreeSlideProps {
  elements: SlideElement[];
  onChange: (elements: SlideElement[]) => void;
  /** Content padding as a percent of the slide — insets the free canvas so
   *  element geometry maps into a safe margin. */
  padding?: number;
  /** Display-only multiplier for stored font px (box width over the page
   *  width at 96dpi) so on-screen text matches the exported file. Stored
   *  fontSize values and the size input stay in page px. */
  fontScale?: number;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Put the caret at the end of an editable node. Starting an edit on
 *  double-click leaves the box without focus (the drag handler cancels the
 *  pointer-down that would have given it), so nothing visibly happens until
 *  a person clicks a third time; focusing here is what makes the caret appear. */
function focusEnd(node: HTMLElement | null | undefined) {
  if (!node) return;
  node.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

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

export function FreeSlide({ elements, onChange, padding, fontScale = 1 }: FreeSlideProps) {
  const slideRef = useRef<HTMLDivElement>(null);
  // Display-only: a canvas-asset src resolves to a URL; stored elements keep
  // the relative reference (onChange never touches src).
  const assetUrl = useAssetUrl();
  const [els, setEls] = useState(elements);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; orig: SlideElement; moved: boolean } | null>(null);

  // Sync from props except while a drag is in flight (don't clobber live edits).
  useEffect(() => {
    if (!drag.current) setEls(elements);
  }, [elements]);
  // A text box being edited gets the caret (see focusEnd); a table places it itself.
  useEffect(() => {
    if (!editingId) return;
    focusEnd(slideRef.current?.querySelector<HTMLElement>(`[data-el-id="${editingId}"] .cv-free__text`));
  }, [editingId]);

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
    drag.current = { id: el.id, mode, sx: e.clientX, sy: e.clientY, orig: { ...el }, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const rect = slideRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = ((e.clientX - d.sx) / rect.width) * 100;
    const dy = ((e.clientY - d.sy) / rect.height) * 100;
    if (dx !== 0 || dy !== 0) d.moved = true;

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
      // A click that moved nothing is a selection, not an edit: recording it
      // put empty steps on the undo stack and a save on the wire.
      const { moved } = drag.current;
      drag.current = null;
      setGuides({ x: null, y: null });
      if (moved) onChange(els);
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
      style={padding ? { inset: `${padding}%` } : undefined}
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
          data-el-id={el.id}
          className={`cv-free__el ${selected === el.id ? "is-selected" : ""}`}
          style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${boxHeightPct(el)}%` }}
          onPointerDown={(e) => onDown(e, el, "move")}
          onDoubleClick={(e) => {
            if (el.type === "text") {
              e.stopPropagation();
              setEditingId(el.id);
            } else if (el.type === "table") {
              // The box captured the pointer on the first click, so this
              // event is addressed to the box; the cell is whatever sits
              // under the pointer.
              const cell = document
                .elementFromPoint(e.clientX, e.clientY)
                ?.closest<HTMLElement>("td[data-cell]")
                ?.getAttribute("data-cell");
              if (!cell) return;
              e.stopPropagation();
              setEditingId(el.id);
              setEditingCell(cell);
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
              style={textStyle(el, fontScale)}
              onBlur={(e) => {
                setEditingId(null);
                updateEl(el.id, { text: e.currentTarget.textContent ?? "" });
              }}
            >
              {el.text}
            </div>
          ) : el.type === "shape" ? (
            <div style={shapeStyle(el, fontScale)} />
          ) : el.type === "table" ? (
            <SlideTable
              el={el}
              scale={fontScale}
              editable
              onChange={(partial) => updateEl(el.id, partial)}
              editingKey={editingId === el.id ? editingCell : null}
              onEditingKey={(key) => {
                setEditingCell(key);
                setEditingId(key ? el.id : null);
              }}
            />
          ) : (
            <img className="cv-free__img" src={assetUrl(el.src)} alt="" draggable={false} />
          )}

          {selected === el.id && (el.type === "text" || el.type === "table") && (
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
                {el.type === "shape" && (
                  <input className="cv-free__ctl-fill" type="color" value={el.fill ?? "#5b5bd6"} onChange={(e) => updateEl(el.id, { fill: e.target.value })} onClick={(e) => e.stopPropagation()} title="Fill color" />
                )}
                {el.type === "table" && (
                  <input className="cv-free__ctl-fill" type="color" value={el.stroke ?? "#9e9e9e"} onChange={(e) => updateEl(el.id, { stroke: e.target.value, strokeWidth: el.strokeWidth ?? 1 })} onClick={(e) => e.stopPropagation()} title="Grid line color" />
                )}
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
