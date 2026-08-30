/**
 * The slide rail — one non-interactive thumbnail iframe per slide, reused
 * layout classes from the pre-deck PowerPoint viewer (`cv-deck__rail`,
 * `cv-deck__thumb*`, styles/canvas.css:479-535).
 *
 * Thumbnails mount their iframe only once visible (IntersectionObserver) and
 * only up to `MAX_CONCURRENT_IFRAMES` at a time — a full deck's rail would
 * otherwise spin up one live iframe document per slide simultaneously.
 */

import { useEffect, useRef, useState } from "react";

import { slideDocFor, type DeckSlideTemplate } from "../../client/deck";
import type { DeckSlideStatus } from "../../client/reconcile";

const MAX_CONCURRENT_IFRAMES = 6;

export interface DeckThumbRailProps {
  slides: DeckSlideTemplate[];
  ratio: string;
  assetBaseUrl?: string;
  activeSlideId: string;
  slideStatus?: Record<string, DeckSlideStatus>;
  onSelect: (slideId: string) => void;
  onReorder: (orderedIds: string[]) => void;
}

export function DeckThumbRail({
  slides,
  ratio,
  assetBaseUrl,
  activeSlideId,
  slideStatus,
  onSelect,
  onReorder,
}: DeckThumbRailProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [visible, setVisible] = useState<Set<string>>(new Set());

  const markVisible = (slideId: string, isVisible: boolean) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (isVisible) next.add(slideId);
      else next.delete(slideId);
      return next;
    });
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const ids = slides.map((s) => s.slideId);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    onReorder(ids);
  };

  // The first N slides (in deck order) among those currently visible get a
  // live iframe; further visible slides fall back to a placeholder box.
  const mountBudget = new Set<string>();
  for (const s of slides) {
    if (mountBudget.size >= MAX_CONCURRENT_IFRAMES) break;
    if (visible.has(s.slideId)) mountBudget.add(s.slideId);
  }

  return (
    <aside className="cv-deck__rail cv-chrome">
      {slides.map((slide, i) => (
        <div
          key={slide.slideId}
          className={`cv-deck__thumb-wrap ${slide.slideId === activeSlideId ? "is-active" : ""} ${dragIndex === i ? "is-dragging" : ""}`}
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragIndex !== null) reorder(dragIndex, i);
            setDragIndex(null);
          }}
          onDragEnd={() => setDragIndex(null)}
        >
          <button className="cv-deck__thumb" onClick={() => onSelect(slide.slideId)}>
            <span className="cv-deck__thumb-n">{i + 1}</span>
            <DeckThumb
              slide={slide}
              ratio={ratio}
              assetBaseUrl={assetBaseUrl}
              mounted={mountBudget.has(slide.slideId)}
              status={slideStatus?.[slide.slideId]}
              onVisibilityChange={(isVisible) => markVisible(slide.slideId, isVisible)}
            />
          </button>
        </div>
      ))}
    </aside>
  );
}

interface DeckThumbProps {
  slide: DeckSlideTemplate;
  ratio: string;
  assetBaseUrl?: string;
  mounted: boolean;
  status?: DeckSlideStatus;
  onVisibilityChange: (isVisible: boolean) => void;
}

function DeckThumb({ slide, ratio, assetBaseUrl, mounted, status, onVisibilityChange }: DeckThumbProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      onVisibilityChange(true); // no observer support (e.g. jsdom) — mount unconditionally
      return;
    }
    const observer = new IntersectionObserver((entries) => onVisibilityChange(entries[0]?.isIntersecting ?? false));
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={boxRef} className="cv-deck__thumb-slide">
      {mounted ? (
        <iframe
          className="cv-deck__thumb-frame"
          title={slide.title ?? slide.slideId}
          srcDoc={slideDocFor(slide, ratio, assetBaseUrl)}
          sandbox="allow-scripts"
          tabIndex={-1}
          style={{ width: "100%", height: "100%", border: 0, pointerEvents: "none" }}
        />
      ) : null}
      {status && status.stage !== "complete" ? (
        <span className={`cv-deck__thumb-badge cv-deck__thumb-badge--${status.stage}`} title={status.detail}>
          {status.stage === "degraded" ? "!" : "…"}
        </span>
      ) : null}
    </div>
  );
}
