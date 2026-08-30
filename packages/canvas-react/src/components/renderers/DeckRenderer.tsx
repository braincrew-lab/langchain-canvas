/**
 * Renders a `type: "slides"` artifact backed by the canonical `.slides.html`
 * deck dialect (`client/deck.ts::parseDeckHtml`). Composes the thumbnail rail
 * (`DeckThumbRail`) and the active-slide editing surface (`DeckStage`);
 * neither mounts `HtmlRenderer` (see `DeckStage`'s module doc for why).
 *
 * A legacy `{ slides: [...] }` artifact (the pre-deck structured-elements
 * shape — `isLegacySlidesData`) renders as a read-only info card instead of
 * crashing on `parseDeckHtml`, which expects an HTML string.
 */

import { useEffect, useMemo, useState } from "react";

import { isLegacySlidesData, type SlidesData } from "../../protocol/artifacts";
import { parseDeckHtml, reorderDeck, type Deck } from "../../client/deck";
import type { DeckSlideStatus } from "../../client/reconcile";
import { useCanvasStore } from "../../hooks/useCanvasStore";
import type { RendererProps } from "../../registry/registry";
import { DeckThumbRail } from "./DeckThumbRail";
import { DeckStage } from "./DeckStage";

function LegacyDeckCard() {
  return (
    <div className="cv-deck cv-deck--empty" role="status">
      <p>This deck was saved in an older format and can no longer be edited here.</p>
      <p>Ask the agent to recreate it as a new deck to resume editing.</p>
    </div>
  );
}

export function DeckRenderer({ artifact }: RendererProps<SlidesData>) {
  const legacy = isLegacySlidesData(artifact.data);
  const html = legacy ? "" : (artifact.data as { html: string }).html;
  const deck: Deck | null = useMemo(() => (legacy ? null : parseDeckHtml(html)), [legacy, html]);

  const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const applyEvent = useCanvasStore((s) => s.applyUserEvent);
  const assetBaseUrl = useCanvasStore((s) => s.assetBaseUrl);
  const slideStatus = artifact.meta?.slideStatus as Record<string, DeckSlideStatus> | undefined;

  const slides = deck?.slides ?? [];
  const activeId =
    activeSlideId && slides.some((s) => s.slideId === activeSlideId) ? activeSlideId : (slides[0]?.slideId ?? null);
  const activeIndex = activeId ? slides.findIndex((s) => s.slideId === activeId) : -1;
  const activeSlide = activeIndex >= 0 ? slides[activeIndex] : null;

  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        const next = slides[Math.min(activeIndex + 1, slides.length - 1)];
        if (next) setActiveSlideId(next.slideId);
      } else if (e.key === "ArrowLeft") {
        const prev = slides[Math.max(activeIndex - 1, 0)];
        if (prev) setActiveSlideId(prev.slideId);
      } else if (e.key === "Escape") {
        setPresenting(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting, activeIndex, slides.length]);

  if (legacy || !deck) {
    return <LegacyDeckCard />;
  }

  if (slides.length === 0) {
    return <div className="cv-deck cv-deck--empty">No slides yet…</div>;
  }

  const reorder = (orderedIds: string[]) => {
    const nextHtml = reorderDeck(html, orderedIds);
    applyEvent({ type: "canvas.patch", id: artifact.id, patch: { html: nextHtml } });
  };

  const activeStatus = activeSlide ? slideStatus?.[activeSlide.slideId] : undefined;

  return (
    <div className="cv-deck">
      <DeckThumbRail
        slides={slides}
        ratio={deck.ratio}
        assetBaseUrl={assetBaseUrl ?? undefined}
        activeSlideId={activeId ?? slides[0].slideId}
        slideStatus={slideStatus}
        onSelect={setActiveSlideId}
        onReorder={reorder}
      />

      <div className="cv-deck__main">
        <div className="cv-deck__toolbar cv-chrome">
          {activeStatus && activeStatus.stage !== "complete" ? (
            <span className={`cv-deck__thumb-badge cv-deck__thumb-badge--${activeStatus.stage}`} title={activeStatus.detail}>
              {activeStatus.stage === "degraded" ? "Degraded" : "Generating…"}
            </span>
          ) : null}
          <span className="cv-deck__spacer" />
          <button className="cv-deck__present" onClick={() => setPresenting(true)} title="Present (full screen)">
            ▶ Present
          </button>
        </div>

        {activeSlide ? <DeckStage artifactId={artifact.id} slide={activeSlide} ratio={deck.ratio} /> : null}

        <div className="cv-deck__nav cv-chrome">
          <button
            disabled={activeIndex <= 0}
            onClick={() => setActiveSlideId(slides[Math.max(activeIndex - 1, 0)].slideId)}
            aria-label="Previous slide"
          >
            ‹
          </button>
          <span>
            {activeIndex + 1} / {slides.length}
          </span>
          <button
            disabled={activeIndex >= slides.length - 1}
            onClick={() => setActiveSlideId(slides[Math.min(activeIndex + 1, slides.length - 1)].slideId)}
            aria-label="Next slide"
          >
            ›
          </button>
        </div>
      </div>

      {presenting && activeSlide ? (
        <div className="cv-present" onClick={() => setPresenting(false)}>
          <div key={activeSlide.slideId} className="cv-present__slide cv-present__fade">
            <DeckStage artifactId={artifact.id} slide={activeSlide} ratio={deck.ratio} />
          </div>
          <span className="cv-present__hint">Esc to exit · ← → to navigate</span>
        </div>
      ) : null}
    </div>
  );
}
