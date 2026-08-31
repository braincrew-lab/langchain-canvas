/**
 * The active slide's editing surface — an iframe rendering one deck slide.
 *
 * Deliberately does **not** mount `HtmlRenderer`: that component's `emitDoc`
 * path posts the *whole* iframe document and the host replaces the artifact's
 * entire `html` with it (`HtmlRenderer.tsx:423-434`, `reconcile.ts::mergePatch`
 * on a scalar). Reusing it here would let a slide-scoped structural edit
 * clobber every other slide in the deck with a single-slide document. Owning
 * the iframe/fit/postMessage wiring directly keeps every edit slide-scoped:
 * `node_edit` persists through `patchDeckNode` (byte range inside the slide's
 * own `<template>`), not a whole-document replace.
 *
 * `doc_edit` (structural edits — insert/duplicate/group) is routed through
 * `extractTemplateFromSlideDoc` + `patchDeckSlide` + `canvas.slide_patch`:
 * the edited slide document is turned back into a `<template>` fragment and
 * spliced into the deck's own slide span, so a structural edit is still
 * scoped to this one slide — never a whole-deck `html` replace.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { withInspector, INSPECTOR_MARK } from "../../client/inspector";
import { slideDocFor, extractTemplateFromSlideDoc, DeckParseError, type DeckSlideTemplate } from "../../client/deck";
import { useCanvasStore } from "../../hooks/useCanvasStore";

const SLIDE_DESIGN_WIDTH = 1280;

/** Fit the slide's design box into the available column, width AND height —
 *  the same calculation `HtmlRenderer.tsx::useSlideFit` performs, duplicated
 *  (not imported) per this component's "own the iframe" contract above. Like
 *  PowerPoint's canvas, the slide always fits entirely; the stage never
 *  scrolls. */
function useDeckStageFit(ratio: string, boxRef: React.RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(1);
  const [rw, rh] = ratio.split(/[:x/]/).map(Number);
  const height = rw && rh ? Math.round((SLIDE_DESIGN_WIDTH * rh) / rw) : 720;
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 40) return;
      const widthScale = (w - 32) / SLIDE_DESIGN_WIDTH;
      const heightScale = h > 40 ? (h - 32) / height : widthScale;
      setScale(Math.min(1, widthScale, heightScale));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratio, height]);
  return { scale, width: SLIDE_DESIGN_WIDTH, height };
}

export interface DeckStageProps {
  artifactId: string;
  slide: DeckSlideTemplate;
  ratio: string;
}

/** Extract `data-node-id` from a `node_edit` fragment's opening tag, or `null`
 *  when the edited element carries none (content authored before node ids
 *  existed on it — nothing to persist per-node yet). */
function nodeIdOf(fragmentHtml: string): string | null {
  const match = fragmentHtml.match(/^<[a-zA-Z][a-zA-Z0-9-]*\b([^>]*)>/);
  if (!match) return null;
  const attrMatch = match[1].match(/(?:^|\s)data-node-id\s*=\s*("([^"]*)"|'([^']*)')/i);
  return attrMatch ? (attrMatch[2] ?? attrMatch[3] ?? null) : null;
}

export function DeckStage({ artifactId, slide, ratio }: DeckStageProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const applyEvent = useCanvasStore((s) => s.applyUserEvent);
  const setSelections = useCanvasStore((s) => s.setSelections);
  const assetBaseUrl = useCanvasStore((s) => s.assetBaseUrl);
  const iframeCommand = useCanvasStore((s) => s.iframeCommand);
  const selections = useCanvasStore((s) => s.selections);
  const lastCommand = useRef(iframeCommand);
  const fit = useDeckStageFit(ratio, stageRef);

  const srcDoc = useMemo(
    () => withInspector(slideDocFor(slide, ratio, assetBaseUrl ?? undefined), undefined, slide.slideId),
    [slide, ratio, assetBaseUrl],
  );

  // DeckStage owns its iframe instead of mounting HtmlRenderer, so it must
  // also forward the StylePanel/selection commands to that editing surface.
  useEffect(() => {
    if (iframeCommand === lastCommand.current) return;
    lastCommand.current = iframeCommand;
    if (!iframeCommand || iframeCommand.artifactId !== artifactId) return;
    iframeRef.current?.contentWindow?.postMessage({ source: INSPECTOR_MARK, ...iframeCommand }, "*");
  }, [iframeCommand, artifactId]);

  useEffect(() => {
    if (!selections.some((selection) => selection.artifactId === artifactId)) {
      iframeRef.current?.contentWindow?.postMessage({ source: INSPECTOR_MARK, type: "clear" }, "*");
    }
  }, [selections, artifactId]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (data?.source !== INSPECTOR_MARK) return;

      if (data.type === "select") {
        setSelections([
          {
            artifactId,
            cid: data.cid,
            selector: data.selector,
            tag: data.tag,
            text: data.text,
            outerHtml: data.outerHtml,
            styles: data.styles,
            isGroup: data.isGroup,
          },
        ]);
      } else if (data.type === "multi_select") {
        setSelections(
          (data.items ?? []).map((it: { cid: string; selector: string; tag: string; text?: string; outerHtml?: string }) => ({
            artifactId,
            cid: it.cid,
            selector: it.selector,
            tag: it.tag,
            text: it.text,
            outerHtml: it.outerHtml,
          })),
        );
      } else if (data.type === "node_edit") {
        const nodeId = nodeIdOf(data.html);
        if (!nodeId) return; // no per-node address on this element yet — nothing to persist
        // The reducer (reconcile.ts::applyDeckNodePatch, delegating to
        // patchDeckNode) does the actual byte-range replacement and safely
        // no-ops a stale id — this component only addresses the edit.
        applyEvent({
          type: "canvas.node_patch",
          id: artifactId,
          cid: data.cid,
          html: data.html,
          slideId: slide.slideId,
          nodeId,
        });
      } else if (data.type === "doc_edit") {
        // Structural edit inside the slide iframe: turn the edited slide
        // document back into a `<template>` fragment and persist it as a
        // single-slide patch (never the whole deck's `html`). A malformed
        // extraction (e.g. a slide-id mismatch) is dropped rather than
        // crashing the panel — the reducer's own `applyDeckSlidePatch` has
        // the same no-crash-on-a-bad-patch contract.
        try {
          const templateHtml = extractTemplateFromSlideDoc(data.html, slide.slideId);
          applyEvent({
            type: "canvas.slide_patch",
            id: artifactId,
            slideId: slide.slideId,
            templateHtml,
          });
        } catch (err) {
          if (!(err instanceof DeckParseError)) throw err;
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifactId, slide.slideId, applyEvent, setSelections]);

  return (
    <div className="cv-html-stage cv-html-stage--slide" ref={stageRef}>
      <div style={{ width: fit.width * fit.scale, height: fit.height * fit.scale, flex: "0 0 auto", position: "relative" }}>
        <iframe
          ref={iframeRef}
          className="cv-html"
          title={slide.title ?? slide.slideId}
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-popups allow-modals"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: fit.width,
            height: fit.height,
            transform: `scale(${fit.scale})`,
            transformOrigin: "top left",
          }}
        />
      </div>
    </div>
  );
}
