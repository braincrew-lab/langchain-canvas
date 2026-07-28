/**
 * Renders a `type: "slides"` artifact as a real presentation editor. Every slide
 * is a free canvas (PowerPoint-style): every element can be dragged, resized,
 * edited, restyled, reordered, duplicated, or deleted. Agents may emit the
 * structured shape (title / bullets / layout); it's derived into movable elements
 * via `resolveElements`, so there is one editable model everywhere — canvas,
 * presenter, and export.
 */

import { useEffect, useRef, useState } from "react";

import type { Slide, SlideElement, SlidesData } from "../../protocol/artifacts";
import { resolveElements } from "../../client/slideElements";
import { useArtifactPatch } from "../../hooks/useArtifactPatch";
import type { RendererProps } from "../../registry/registry";
import { FreeSlide, shapeStyle } from "./FreeSlide";

/**
 * Theme presets. Each is a complete art direction — background, ink, one accent,
 * and a system font stack (no external loads) — rather than just a background
 * swap. The accent feeds the quick layouts (rules, section numbers, stats) and
 * new shapes; the font cascades from the slide container to every element.
 */
const THEMES: { id: string; label: string; bg: string; text: string; accent: string; font: string }[] = [
  // Light — warm white + crimson serif, magazine front-of-book.
  { id: "editorial", label: "Editorial", bg: "#f9f8f4", text: "#1c1a17", accent: "#a51c30", font: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' },
  // Light — pure white, pure black, no color at all: gallery-catalog restraint.
  { id: "gallery", label: "Gallery", bg: "#ffffff", text: "#111111", accent: "#111111", font: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  // Light — cool paper + navy ink + cobalt, the quiet corporate default.
  { id: "boardroom", label: "Boardroom", bg: "#f3f5f8", text: "#142743", accent: "#1f56c9", font: 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif' },
  // Light — sage paper + moss ink + fern, humanist and unhurried.
  { id: "sage", label: "Sage", bg: "#edf0e8", text: "#273428", accent: "#4c7a4f", font: 'Seravek, "Gill Sans", "Trebuchet MS", Verdana, sans-serif' },
  // Dark — soft charcoal + amber, geometric grotesque; studio pitch deck.
  { id: "graphite", label: "Graphite", bg: "#1e1f21", text: "#f1f0ed", accent: "#ecb22e", font: '"Avenir Next", Avenir, Futura, "Century Gothic", sans-serif' },
  // Dark — midnight blue + starlight gold, high-contrast didone serif.
  { id: "observatory", label: "Observatory", bg: "#0d1526", text: "#e2e8f4", accent: "#d4af6a", font: 'Didot, "Bodoni MT", "Bodoni 72", Georgia, serif' },
  // Mid — Klein blue + signal yellow, Swiss poster energy.
  { id: "ultramarine", label: "Ultramarine", bg: "#002fa7", text: "#f2f5ff", accent: "#ffd02f", font: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  // Dark — wine-cellar aubergine + rosé, old-style serif; dinner-party keynote.
  { id: "bordeaux", label: "Bordeaux", bg: "#241722", text: "#f0e8ee", accent: "#d98ca0", font: '"Hoefler Text", Baskerville, "Baskerville Old Face", Georgia, serif' },
];

/** Accent used by layouts/shapes when the slide has no theme accent yet. */
const FALLBACK_ACCENT = "#5b5bd6";

// Shapes a "+ Shape" click can drop onto the slide.
const SHAPES: { id: NonNullable<SlideElement["shape"]>; label: string; box: { w: number; h: number } }[] = [
  { id: "rect", label: "▭ Rectangle", box: { w: 30, h: 20 } },
  { id: "ellipse", label: "◯ Ellipse", box: { w: 24, h: 24 } },
  { id: "line", label: "— Line", box: { w: 40, h: 2 } },
];

/**
 * Quick slide layouts — each replaces the current slide's elements. Factories
 * take the slide's theme accent so rules, section numbers, and stats pick up
 * the active palette. Geometry is percent-of-slide; everything hangs off a
 * left margin at 8% so slides share one grid instead of centering everything.
 */
const LAYOUTS: Record<string, { label: string; els: (accent: string) => Omit<SlideElement, "id">[] }> = {
  title: { label: "Title", els: (accent) => [
    { type: "shape", shape: "rect", x: 8, y: 30, w: 7, h: 1.4, fill: accent },
    { type: "text", x: 8, y: 35, w: 72, h: 20, text: "Presentation title", fontSize: 52, bold: true },
    { type: "text", x: 8, y: 57, w: 56, h: 8, text: "A one-line summary of the story", fontSize: 22 },
    { type: "text", x: 8, y: 86, w: 50, h: 5, text: "Team name · Date", fontSize: 14 },
  ] },
  section: { label: "Section divider", els: (accent) => [
    { type: "text", x: 8, y: 12, w: 26, h: 26, text: "01", fontSize: 104, bold: true, color: accent },
    { type: "shape", shape: "rect", x: 8, y: 50, w: 84, h: 0.5, fill: accent },
    { type: "text", x: 8, y: 55, w: 76, h: 14, text: "Section title", fontSize: 44, bold: true },
    { type: "text", x: 8, y: 71, w: 60, h: 7, text: "What this chapter covers, in one line", fontSize: 20 },
  ] },
  agenda: { label: "Agenda", els: (accent) => [
    { type: "text", x: 8, y: 10, w: 40, h: 10, text: "Agenda", fontSize: 40, bold: true },
    { type: "shape", shape: "rect", x: 8, y: 22, w: 7, h: 1.2, fill: accent },
    { type: "text", x: 8, y: 32, w: 7, h: 8, text: "01", fontSize: 20, bold: true, color: accent },
    { type: "text", x: 17, y: 32, w: 66, h: 8, text: "First topic", fontSize: 24 },
    { type: "text", x: 8, y: 46, w: 7, h: 8, text: "02", fontSize: 20, bold: true, color: accent },
    { type: "text", x: 17, y: 46, w: 66, h: 8, text: "Second topic", fontSize: 24 },
    { type: "text", x: 8, y: 60, w: 7, h: 8, text: "03", fontSize: 20, bold: true, color: accent },
    { type: "text", x: 17, y: 60, w: 66, h: 8, text: "Third topic", fontSize: 24 },
    { type: "text", x: 8, y: 74, w: 7, h: 8, text: "04", fontSize: 20, bold: true, color: accent },
    { type: "text", x: 17, y: 74, w: 66, h: 8, text: "Fourth topic", fontSize: 24 },
  ] },
  bullets: { label: "Bullets", els: (accent) => [
    { type: "text", x: 8, y: 9, w: 60, h: 5, text: "Where we are", fontSize: 14, bold: true, color: accent },
    { type: "text", x: 8, y: 16, w: 80, h: 12, text: "Heading that states the takeaway", fontSize: 38, bold: true },
    { type: "text", x: 8, y: 34, w: 78, h: 54, text: "•  First key point, one line each\n\n•  Second key point\n\n•  Third key point", fontSize: 22 },
  ] },
  "two-column": { label: "Two column", els: (accent) => [
    { type: "text", x: 8, y: 10, w: 84, h: 10, text: "Two sides of the argument", fontSize: 36, bold: true },
    { type: "shape", shape: "rect", x: 49.9, y: 28, w: 0.2, h: 54, fill: accent },
    { type: "text", x: 8, y: 28, w: 36, h: 6, text: "Before", fontSize: 20, bold: true, color: accent },
    { type: "text", x: 8, y: 37, w: 36, h: 45, text: "•  point\n\n•  point\n\n•  point", fontSize: 20 },
    { type: "text", x: 56, y: 28, w: 36, h: 6, text: "After", fontSize: 20, bold: true, color: accent },
    { type: "text", x: 56, y: 37, w: 36, h: 45, text: "•  point\n\n•  point\n\n•  point", fontSize: 20 },
  ] },
  stat: { label: "Big stat", els: (accent) => [
    { type: "text", x: 8, y: 14, w: 60, h: 6, text: "The number that matters", fontSize: 14, bold: true },
    { type: "text", x: 8, y: 24, w: 66, h: 32, text: "3.4×", fontSize: 116, bold: true, color: accent },
    { type: "shape", shape: "rect", x: 8, y: 64, w: 10, h: 0.8, fill: accent },
    { type: "text", x: 8, y: 69, w: 62, h: 12, text: "One line explaining what the number means and why it matters", fontSize: 24 },
  ] },
  quote: { label: "Quote", els: (accent) => [
    { type: "text", x: 6, y: 6, w: 12, h: 18, text: "“", fontSize: 120, bold: true, color: accent },
    { type: "text", x: 14, y: 28, w: 72, h: 30, text: "The quote — one strong sentence people will remember.", fontSize: 36, bold: true },
    { type: "shape", shape: "rect", x: 14, y: 64, w: 8, h: 0.8, fill: accent },
    { type: "text", x: 14, y: 68, w: 56, h: 7, text: "Name Surname — Role, Company", fontSize: 18 },
  ] },
};

let elementSeq = 0;
const newElementId = () => `el_${Date.now().toString(36)}_${elementSeq++}`;

export function SlidesRenderer({ artifact }: RendererProps<SlidesData>) {
  const slides = artifact.data.slides ?? [];
  const patch = useArtifactPatch(artifact.id);
  const [index, setIndex] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [presenting, setPresenting] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") setIndex((i) => Math.min(i + 1, slides.length - 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
      else if (e.key === "Escape") setPresenting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting]);

  if (slides.length === 0) {
    return <div className="cv-deck cv-deck--empty">No slides yet…</div>;
  }

  const at = Math.min(index, slides.length - 1);
  const slide = slides[at];
  const slideStyle = {
    ...(slide.background ? { background: slide.background } : {}),
    ...(slide.textColor ? { color: slide.textColor } : {}),
    ...(slide.fontFamily ? { fontFamily: slide.fontFamily } : {}),
  };
  const accent = slide.accent ?? FALLBACK_ACCENT;

  const setSlides = (next: Slide[]) => patch({ slides: next });
  const update = (partial: Partial<Slide>) => setSlides(slides.map((s, i) => (i === at ? { ...s, ...partial } : s)));

  const addSlide = () => {
    const next = [...slides];
    next.splice(at + 1, 0, { elements: [{ id: newElementId(), type: "text", x: 8, y: 10, w: 80, h: 14, text: "New slide", fontSize: 36, bold: true }] });
    setSlides(next);
    setIndex(at + 1);
  };
  const duplicateSlide = () => {
    const next = [...slides];
    next.splice(at + 1, 0, { ...slide, elements: resolveElements(slide).map((e) => ({ ...e })) });
    setSlides(next);
    setIndex(at + 1);
  };
  const deleteSlide = () => {
    if (slides.length === 1) return;
    setSlides(slides.filter((_, i) => i !== at));
    setIndex(Math.max(0, at - 1));
  };
  const moveSlide = (dir: -1 | 1) => {
    const j = at + dir;
    if (j < 0 || j >= slides.length) return;
    const next = [...slides];
    [next[at], next[j]] = [next[j], next[at]];
    setSlides(next);
    setIndex(j);
  };
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = [...slides];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setSlides(next);
    setIndex(to);
  };

  const addElement = (el: Omit<SlideElement, "id">) =>
    update({ elements: [...resolveElements(slide), { ...el, id: newElementId() }] });
  const addTextEl = () => addElement({ type: "text", x: 12, y: 16, w: 45, h: 16, text: "Text", fontSize: 24 });
  const addImageEl = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addElement({ type: "image", x: 22, y: 22, w: 40, h: 34, src: String(reader.result) });
    reader.readAsDataURL(file);
  };
  const addShapeEl = (shape: NonNullable<SlideElement["shape"]>) => {
    const s = SHAPES.find((x) => x.id === shape);
    if (s) addElement({ type: "shape", shape, x: 20, y: 20, w: s.box.w, h: s.box.h, fill: accent });
  };
  const applyLayout = (key: string) => {
    const l = LAYOUTS[key];
    if (l) update({ elements: l.els(accent).map((e) => ({ ...e, id: newElementId() })) });
  };
  const setSlideBgImage = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => update({ background: `#000 url("${String(reader.result)}") center/cover no-repeat` });
    reader.readAsDataURL(file);
  };

  // Figma-style auto layout: tidy every element on the slide into an evenly-spaced
  // vertical/horizontal stack, snap them to a shared edge, or distribute the gaps.
  const arrange = (op: string) => {
    const els = resolveElements(slide);
    if (els.length === 0) return;
    const GAP = 4;
    const M = 6; // safe margin from the slide edge (percent)
    let next: SlideElement[];
    if (op === "stack-v") {
      let y = M;
      next = [...els].sort((a, b) => a.y - b.y).map((el) => {
        const placed = { ...el, x: (100 - el.w) / 2, y };
        y += el.h + GAP;
        return placed;
      });
    } else if (op === "stack-h") {
      let x = M;
      next = [...els].sort((a, b) => a.x - b.x).map((el) => {
        const placed = { ...el, x, y: (100 - el.h) / 2 };
        x += el.w + GAP;
        return placed;
      });
    } else if (op === "align-left") next = els.map((el) => ({ ...el, x: M }));
    else if (op === "align-center") next = els.map((el) => ({ ...el, x: (100 - el.w) / 2 }));
    else if (op === "align-right") next = els.map((el) => ({ ...el, x: 100 - M - el.w }));
    else if (op === "align-top") next = els.map((el) => ({ ...el, y: M }));
    else if (op === "align-middle") next = els.map((el) => ({ ...el, y: (100 - el.h) / 2 }));
    else if (op === "align-bottom") next = els.map((el) => ({ ...el, y: 100 - M - el.h }));
    else if (op === "dist-v" || op === "dist-h") {
      if (els.length < 3) return;
      const k: "x" | "y" = op === "dist-v" ? "y" : "x";
      const sk: "w" | "h" = op === "dist-v" ? "h" : "w";
      const sorted = [...els].sort((a, b) => a[k] - b[k]);
      const start = sorted[0][k];
      const end = sorted[sorted.length - 1][k] + sorted[sorted.length - 1][sk];
      const total = sorted.reduce((acc, e) => acc + e[sk], 0);
      const g = (end - start - total) / (sorted.length - 1);
      let pos = start;
      const placed = new Map<string, SlideElement>();
      for (const el of sorted) {
        placed.set(el.id, { ...el, [k]: pos });
        pos += el[sk] + g;
      }
      next = els.map((e) => placed.get(e.id) ?? e);
    } else return;
    update({ elements: next });
  };

  return (
    <div className="cv-deck">
      <aside className="cv-deck__rail cv-chrome">
        {slides.map((s, i) => (
          <div
            key={i}
            className={`cv-deck__thumb-wrap ${i === at ? "is-active" : ""} ${dragIndex === i ? "is-dragging" : ""}`}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex !== null) reorder(dragIndex, i);
              setDragIndex(null);
            }}
            onDragEnd={() => setDragIndex(null)}
          >
            <button className="cv-deck__thumb" onClick={() => setIndex(i)}>
              <span className="cv-deck__thumb-n">{i + 1}</span>
              <div
                className="cv-deck__thumb-slide"
                style={{
                  ...(s.background ? { background: s.background } : {}),
                  ...(s.fontFamily ? { fontFamily: s.fontFamily } : {}),
                }}
              >
                <div style={{ position: "absolute", inset: `${s.padding ?? 0}%` }}>
                {resolveElements(s).map((el) =>
                  el.type === "text" ? (
                    <span
                      key={el.id}
                      style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, fontSize: (el.fontSize ?? 24) * 0.12, fontWeight: el.bold ? 700 : 400, color: el.color ?? s.textColor, overflow: "hidden", whiteSpace: "pre-wrap" }}
                    >
                      {el.text}
                    </span>
                  ) : el.type === "shape" ? (
                    <div key={el.id} style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, color: s.textColor, ...shapeStyle(el) }} />
                  ) : (
                    <img key={el.id} src={el.src} alt="" style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, objectFit: "contain" }} />
                  ),
                )}
                </div>
              </div>
            </button>
          </div>
        ))}
        <button className="cv-deck__addslide" onClick={addSlide}>+ Add slide</button>
      </aside>

      <div className="cv-deck__main">
        <div className="cv-deck__toolbar cv-chrome">
          <button onClick={addTextEl} title="Add text box">+ Text</button>
          <button onClick={() => imgRef.current?.click()} title="Add image">+ Image</button>
          <input ref={imgRef} type="file" accept="image/*" hidden onChange={(e) => addImageEl(e.target.files?.[0])} />
          <input ref={bgRef} type="file" accept="image/*" hidden onChange={(e) => setSlideBgImage(e.target.files?.[0])} />
          <select className="cv-deck__theme" value="" title="Add a shape"
            onChange={(e) => { if (e.target.value) addShapeEl(e.target.value as NonNullable<SlideElement["shape"]>); e.currentTarget.value = ""; }}>
            <option value="">+ Shape</option>
            {SHAPES.map((s) => (<option key={s.id} value={s.id}>{s.label}</option>))}
          </select>
          <select className="cv-deck__theme" value="" title="Apply a layout"
            onChange={(e) => { if (e.target.value) applyLayout(e.target.value); e.currentTarget.value = ""; }}>
            <option value="">Layout…</option>
            {Object.entries(LAYOUTS).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
          </select>
          <select className="cv-deck__theme" value="" title="Auto layout — align & distribute elements"
            onChange={(e) => { if (e.target.value) arrange(e.target.value); e.currentTarget.value = ""; }}>
            <option value="">⤢ Arrange…</option>
            <optgroup label="Auto layout">
              <option value="stack-v">Stack vertical</option>
              <option value="stack-h">Stack horizontal</option>
            </optgroup>
            <optgroup label="Align">
              <option value="align-left">Left</option>
              <option value="align-center">Center</option>
              <option value="align-right">Right</option>
              <option value="align-top">Top</option>
              <option value="align-middle">Middle</option>
              <option value="align-bottom">Bottom</option>
            </optgroup>
            <optgroup label="Distribute">
              <option value="dist-v">Vertical gaps</option>
              <option value="dist-h">Horizontal gaps</option>
            </optgroup>
          </select>
          <select
            className="cv-deck__theme"
            value=""
            title="Theme"
            onChange={(e) => {
              const t = THEMES.find((x) => x.id === e.target.value);
              if (t) update({ background: t.bg, textColor: t.text, accent: t.accent, fontFamily: t.font });
              e.currentTarget.value = "";
            }}
          >
            <option value="">Theme…</option>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <label className="cv-deck__bg" title="Background color">
            <input type="color" value={/^#/.test(slide.background ?? "") ? slide.background : "#ffffff"} onChange={(e) => update({ background: e.target.value })} />
          </label>
          <button onClick={() => bgRef.current?.click()} title="Background image">🖼 BG</button>
          <label className="cv-deck__pad" title="Content padding (% of slide)">
            Pad
            <input type="number" min={0} max={20} value={slide.padding ?? 0} onChange={(e) => update({ padding: Number(e.target.value) || undefined })} />
          </label>
          <span className="cv-deck__spacer" />
          <button className="cv-deck__present" onClick={() => setPresenting(true)} title="Present (full screen)">▶ Present</button>
          <button onClick={() => moveSlide(-1)} title="Move up" disabled={at === 0}>▲</button>
          <button onClick={() => moveSlide(1)} title="Move down" disabled={at === slides.length - 1}>▼</button>
          <button onClick={duplicateSlide} title="Duplicate slide">⧉</button>
          <button onClick={deleteSlide} title="Delete slide" disabled={slides.length === 1}>🗑</button>
        </div>

        <div className="cv-slide cv-slide--blank" style={slideStyle}>
          <FreeSlide elements={resolveElements(slide)} onChange={(elements) => update({ elements })} padding={slide.padding} />
        </div>

        <div className="cv-deck__nav cv-chrome">
          <button disabled={at === 0} onClick={() => setIndex(at - 1)} aria-label="Previous slide">‹</button>
          <span>{at + 1} / {slides.length}</span>
          <button disabled={at === slides.length - 1} onClick={() => setIndex(at + 1)} aria-label="Next slide">›</button>
        </div>

        <textarea
          className="cv-deck__notes cv-chrome"
          value={slide.notes ?? ""}
          placeholder="Speaker notes…"
          onChange={(e) => update({ notes: e.target.value })}
        />
      </div>

      {presenting && (
        <div className="cv-present" onClick={() => setIndex(Math.min(at + 1, slides.length - 1))}>
          {/* key on the slide index so each advance re-triggers the fade-in. */}
          <div key={at} className="cv-present__slide cv-present__fade cv-slide cv-slide--blank" style={slideStyle}>
            <div className="cv-free" style={slide.padding ? { inset: `${slide.padding}%` } : undefined}>
              {resolveElements(slide).map((el) =>
                el.type === "text" ? (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%` }}>
                    <div className="cv-free__text" style={{ fontSize: el.fontSize ?? 24, fontWeight: el.bold ? 700 : 400, color: el.color, textAlign: el.align ?? "left", whiteSpace: "pre-wrap" }}>
                      {el.text}
                    </div>
                  </div>
                ) : el.type === "shape" ? (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, color: slide.textColor }}>
                    <div style={shapeStyle(el)} />
                  </div>
                ) : (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%` }}>
                    <img className="cv-free__img" src={el.src} alt="" />
                  </div>
                ),
              )}
            </div>
          </div>
          {slide.notes ? (
            <div className="cv-present__notes" onClick={(e) => e.stopPropagation()}>{slide.notes}</div>
          ) : null}
          {/* Slim deck progress along the bottom edge; the fill width is the only
              dynamic bit (fade/reduced-motion handled by the CSS on __fade). */}
          <div className="cv-present__progress">
            <span className="cv-present__progress-fill" style={{ width: `${((at + 1) / slides.length) * 100}%` }} />
          </div>
          <div className="cv-present__count">{at + 1} / {slides.length}</div>
          <div className="cv-present__hint">← → to navigate · Esc to exit</div>
        </div>
      )}
    </div>
  );
}
