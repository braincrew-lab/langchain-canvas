/**
 * Renders a `type: "slides"` artifact as a real presentation editor. Every slide
 * is a free canvas (PowerPoint-style): every element can be dragged, resized,
 * edited, restyled, reordered, duplicated, or deleted. Agents may emit the
 * structured shape (title / bullets / layout); it's derived into movable elements
 * via `resolveElements`, so there is one editable model everywhere — canvas,
 * presenter, and export.
 */

import { useEffect, useRef, useState } from "react";

import type { Slide, SlideElement, SlidePage, SlidesData } from "../../protocol/artifacts";
import { defaultTextColor, resolveElements } from "../../client/slideElements";
import { useArtifactPatch } from "../../hooks/useArtifactPatch";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import type { RendererProps } from "../../registry/registry";
import { boxHeightPct } from "../../client/slideText";
import { FreeSlide, shapeStyle, SlideTable, textStyle } from "./FreeSlide";
import { deckPage, fontScaleFor, pageAspect } from "../../client/slidePage";

/** Track a slide box's width and derive the display font scale for `page`.
 *  Re-measures on resize so the panel, present view, and window drags all
 *  keep text proportional to the page. */
function useFontScale(page: SlidePage) {
  // Callback ref: the present-view box remounts on every slide advance
  // (key={index}), so an object ref would go stale — state-held nodes rerun
  // the effect on each mount.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!node) return;
    const measure = () => setScale(fontScaleFor(node.clientWidth, page));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, page.widthIn, page.heightIn]);
  return { ref: setNode, scale };
}

const THEMES: { id: string; label: string; bg: string; text: string }[] = [
  { id: "light", label: "Light", bg: "#ffffff", text: "#1f2328" },
  { id: "paper", label: "Paper", bg: "#f7f5ef", text: "#2b2a26" },
  { id: "dark", label: "Dark", bg: "#14171f", text: "#f0f2f5" },
  { id: "midnight", label: "Midnight", bg: "#0b1020", text: "#e6e8ef" },
  { id: "navy", label: "Navy", bg: "#0d1b3e", text: "#eef2ff" },
  { id: "forest", label: "Forest", bg: "#0f2a22", text: "#e6f2ec" },
  { id: "sunset", label: "Sunset", bg: "#2b1a2e", text: "#ffe8d6" },
  { id: "mint", label: "Mint", bg: "#0f2a24", text: "#d7f5ec" },
];

// Shapes a "+ Shape" click can drop onto the slide.
const SHAPES: { id: NonNullable<SlideElement["shape"]>; label: string; box: { w: number; h: number } }[] = [
  { id: "rect", label: "▭ Rectangle", box: { w: 30, h: 20 } },
  { id: "ellipse", label: "◯ Ellipse", box: { w: 24, h: 24 } },
  { id: "line", label: "— Line", box: { w: 40, h: 2 } },
];

// Quick slide layouts — each replaces the current slide's elements.
const LAYOUTS: Record<string, { label: string; els: Omit<SlideElement, "id">[] }> = {
  title: { label: "Title", els: [
    { type: "text", x: 12, y: 34, w: 76, h: 18, text: "Presentation title", fontSize: 54, bold: true, align: "center" },
    { type: "text", x: 20, y: 56, w: 60, h: 10, text: "Subtitle or one-line summary", fontSize: 24, align: "center" },
  ] },
  section: { label: "Section", els: [
    { type: "shape", shape: "rect", x: 10, y: 34, w: 8, h: 3, fill: "#5b5bd6" },
    { type: "text", x: 10, y: 40, w: 80, h: 16, text: "Section title", fontSize: 46, bold: true },
  ] },
  bullets: { label: "Bullets", els: [
    { type: "text", x: 10, y: 12, w: 80, h: 12, text: "Heading", fontSize: 36, bold: true },
    { type: "text", x: 10, y: 30, w: 80, h: 50, text: "• First key point\n• Second key point\n• Third key point", fontSize: 26 },
  ] },
  "two-column": { label: "Two column", els: [
    { type: "text", x: 8, y: 16, w: 40, h: 60, text: "Left column\n\n• point\n• point", fontSize: 24 },
    { type: "text", x: 52, y: 16, w: 40, h: 60, text: "Right column\n\n• point\n• point", fontSize: 24 },
  ] },
  quote: { label: "Quote", els: [
    { type: "text", x: 12, y: 30, w: 76, h: 30, text: "“A short, memorable quote.”", fontSize: 40, bold: true },
    { type: "text", x: 12, y: 62, w: 50, h: 8, text: "— Attribution", fontSize: 22 },
  ] },
};

let elementSeq = 0;
const newElementId = () => `el_${Date.now().toString(36)}_${elementSeq++}`;

export function SlidesRenderer({ artifact }: RendererProps<SlidesData>) {
  const slides = artifact.data.slides ?? [];
  const patch = useArtifactPatch(artifact.id);
  // Display-only resolution of canvas-asset image srcs (stored data stays relative).
  const assetUrl = useAssetUrl();
  const [index, setIndex] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [presenting, setPresenting] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLInputElement>(null);
  // The deck's page decides the box shape and the font scale, so the editor
  // shows what the export writes (a 4:3 skin renders as a 4:3 box).
  const page = deckPage(artifact.data);
  const aspect = pageAspect(page);
  const editBox = useFontScale(page);
  const presentBox = useFontScale(page);
  // Thumbnails measure like the editor does. A tuned constant read right on
  // the classic page and wrong everywhere else — a 13.3in deck came out a
  // quarter too small, so its text piled up and the thumbs looked broken.
  const thumbBox = useFontScale(page);

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
    color: slide.textColor ?? defaultTextColor(slide.background),
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
    next.splice(at + 1, 0, { ...slide, elements: resolveElements(slide, page).map((e) => ({ ...e })) });
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
    update({ elements: [...resolveElements(slide, page), { ...el, id: newElementId() }] });
  const addTextEl = () => addElement({ type: "text", x: 12, y: 16, w: 45, h: 16, text: "Text", fontSize: 24 });
  const addTableEl = () =>
    addElement({
      type: "table", x: 10, y: 25, w: 80, h: 40,
      rows: [["Column 1", "Column 2", "Column 3"], ["", "", ""], ["", "", ""]],
      header: true, stroke: "#9e9e9e", strokeWidth: 1, fontSize: 18,
    });
  const addImageEl = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addElement({ type: "image", x: 22, y: 22, w: 40, h: 34, src: String(reader.result) });
    reader.readAsDataURL(file);
  };
  const addShapeEl = (shape: NonNullable<SlideElement["shape"]>) => {
    const s = SHAPES.find((x) => x.id === shape);
    if (s) addElement({ type: "shape", shape, x: 20, y: 20, w: s.box.w, h: s.box.h, fill: "#5b5bd6" });
  };
  const applyLayout = (key: string) => {
    const l = LAYOUTS[key];
    if (l) update({ elements: l.els.map((e) => ({ ...e, id: newElementId() })) });
  };
  const setSlideBgImage = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => update({ background: `#000 url("${String(reader.result)}") center/cover no-repeat` });
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
              <div ref={i === 0 ? thumbBox.ref : undefined} className="cv-deck__thumb-slide" style={{ aspectRatio: aspect, ...(s.background ? { background: s.background } : {}) }}>
                <div style={{ position: "absolute", inset: `${s.padding ?? 0}%` }}>
                {resolveElements(s, page).map((el) =>
                  el.type === "text" ? (
                    <div
                      key={el.id}
                      style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${boxHeightPct(el)}%`, overflow: "hidden", ...textStyle(el, thumbBox.scale), ...(el.color ? null : { color: s.textColor ?? defaultTextColor(s.background) }) }}
                    >
                      {el.text}
                    </div>
                  ) : el.type === "shape" ? (
                    <div key={el.id} style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, color: s.textColor ?? defaultTextColor(s.background), ...shapeStyle(el, thumbBox.scale) }} />
                  ) : el.type === "table" ? (
                    <div key={el.id} style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, overflow: "hidden", color: s.textColor ?? defaultTextColor(s.background) }}>
                      <SlideTable el={el} scale={thumbBox.scale} />
                    </div>
                  ) : (
                    <img key={el.id} src={assetUrl(el.src)} alt="" style={{ position: "absolute", left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, objectFit: "contain" }} />
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
          <button onClick={addTableEl} title="Add table">+ Table</button>
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
          <select
            className="cv-deck__theme"
            value=""
            title="Theme"
            onChange={(e) => {
              const t = THEMES.find((x) => x.id === e.target.value);
              if (t) update({ background: t.bg, textColor: t.text });
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

        <div className="cv-slide cv-slide--blank" ref={editBox.ref} style={{ aspectRatio: aspect, ...slideStyle }}>
          <FreeSlide elements={resolveElements(slide, page)} onChange={(elements) => update({ elements })} padding={slide.padding} fontScale={editBox.scale} />
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
          <div key={at} ref={presentBox.ref} className="cv-present__slide cv-present__fade cv-slide cv-slide--blank" style={{ aspectRatio: aspect, ...slideStyle }}>
            <div className="cv-free" style={slide.padding ? { inset: `${slide.padding}%` } : undefined}>
              {resolveElements(slide, page).map((el) =>
                el.type === "text" ? (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${boxHeightPct(el)}%` }}>
                    <div className="cv-free__text" style={textStyle(el, presentBox.scale)}>
                      {el.text}
                    </div>
                  </div>
                ) : el.type === "shape" ? (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, color: slide.textColor ?? defaultTextColor(slide.background) }}>
                    <div style={shapeStyle(el, presentBox.scale)} />
                  </div>
                ) : el.type === "table" ? (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, overflow: "hidden" }}>
                    <SlideTable el={el} scale={presentBox.scale} />
                  </div>
                ) : (
                  <div key={el.id} className="cv-free__el" style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%` }}>
                    <img className="cv-free__img" src={assetUrl(el.src)} alt="" />
                  </div>
                ),
              )}
            </div>
          </div>
          {slide.notes ? (
            <div className="cv-present__notes" onClick={(e) => e.stopPropagation()}>{slide.notes}</div>
          ) : null}
          <div className="cv-present__hint">
            {at + 1} / {slides.length} · ← → to navigate · Esc to exit
          </div>
        </div>
      )}
    </div>
  );
}
