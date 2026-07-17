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
import { FreeSlide } from "./FreeSlide";

const THEMES: { id: string; label: string; bg: string; text: string }[] = [
  { id: "light", label: "Light", bg: "#ffffff", text: "#1f2328" },
  { id: "dark", label: "Dark", bg: "#14171f", text: "#f0f2f5" },
  { id: "midnight", label: "Midnight", bg: "#0b1020", text: "#e6e8ef" },
  { id: "sunset", label: "Sunset", bg: "#2b1a2e", text: "#ffe8d6" },
  { id: "mint", label: "Mint", bg: "#0f2a24", text: "#d7f5ec" },
];

let elementSeq = 0;
const newElementId = () => `el_${Date.now().toString(36)}_${elementSeq++}`;

export function SlidesRenderer({ artifact }: RendererProps<SlidesData>) {
  const slides = artifact.data.slides ?? [];
  const patch = useArtifactPatch(artifact.id);
  const [index, setIndex] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [presenting, setPresenting] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);

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
  };

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
              <div className="cv-deck__thumb-slide" style={s.background ? { background: s.background } : undefined}>
                {resolveElements(s).map((el) =>
                  el.type === "text" ? (
                    <span
                      key={el.id}
                      style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, fontSize: (el.fontSize ?? 24) * 0.12, fontWeight: el.bold ? 700 : 400, color: el.color ?? s.textColor, overflow: "hidden" }}
                    >
                      {el.text}
                    </span>
                  ) : (
                    <img key={el.id} src={el.src} alt="" style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, objectFit: "contain" }} />
                  ),
                )}
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
          <select
            className="cv-deck__theme"
            value=""
            title="Theme"
            onChange={(e) => {
              const t = THEMES.find((x) => x.id === e.target.value);
              if (t) update({ background: t.bg, textColor: t.text });
            }}
          >
            <option value="" disabled>Theme</option>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <label className="cv-deck__bg" title="Background color">
            <input type="color" value={slide.background ?? "#ffffff"} onChange={(e) => update({ background: e.target.value })} />
          </label>
          <span className="cv-deck__spacer" />
          <button className="cv-deck__present" onClick={() => setPresenting(true)} title="Present (full screen)">▶ Present</button>
          <button onClick={() => moveSlide(-1)} title="Move up" disabled={at === 0}>▲</button>
          <button onClick={() => moveSlide(1)} title="Move down" disabled={at === slides.length - 1}>▼</button>
          <button onClick={duplicateSlide} title="Duplicate slide">⧉</button>
          <button onClick={deleteSlide} title="Delete slide" disabled={slides.length === 1}>🗑</button>
        </div>

        <div className="cv-slide cv-slide--blank" style={slideStyle}>
          <FreeSlide elements={resolveElements(slide)} onChange={(elements) => update({ elements })} />
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
          <div className="cv-present__slide cv-slide cv-slide--blank" style={slideStyle}>
            <div className="cv-free">
              {resolveElements(slide).map((el) =>
                el.type === "text" ? (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%` }}>
                    <div className="cv-free__text" style={{ fontSize: el.fontSize ?? 24, fontWeight: el.bold ? 700 : 400, color: el.color, textAlign: el.align ?? "left" }}>
                      {el.text}
                    </div>
                  </div>
                ) : (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%` }}>
                    <img className="cv-free__img" src={el.src} alt="" />
                  </div>
                ),
              )}
            </div>
          </div>
          <div className="cv-present__hint">
            {at + 1} / {slides.length} · ← → to navigate · Esc to exit
          </div>
        </div>
      )}
    </div>
  );
}
