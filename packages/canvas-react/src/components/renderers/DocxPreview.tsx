/**
 * Typeset preview of a Word file on the canvas — read it, point at it, say so.
 *
 * The stored `.docx` is the truth; this draws it as the user laid it out,
 * instead of the markdown approximation a text extract would give. It is
 * deliberately **not** an editor. A person points — clicking a paragraph or
 * selecting words puts that place in the selection bar as an address the
 * document tools accept — and the agent makes the change. Opening direct
 * editing here would put two writers on one file and bring back the conflict
 * and undo problems the store contract exists to avoid.
 *
 * The renderer is an optional peer (`docx-preview`): a canvas that never shows
 * a Word file does not pay for it, and a host that has not installed it falls
 * back to the file card rather than breaking.
 *
 * One thing is redrawn rather than shown as written: a list bullet the file
 * asks for by symbol-font slot has no glyph anywhere without that exact font,
 * so it is swapped for the standard character meaning the same mark (see
 * `symbolBullets`). The status line names the fonts that happened to, because
 * that is a place the screen and the file differ.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { useCanvasStore } from "../../hooks/useCanvasStore";
import {
  DOCX_ADDRESS_ATTRIBUTE,
  docxStats,
  fitToWidth,
  pickFromNode,
  pickFromSelection,
  stampDocxAddresses,
  type DocxPick,
  type DocxStats,
} from "../../io/docxAddress";
import { redrawnFonts, restoreSymbolBullets } from "../../io/symbolBullets";
import { loadOptional } from "../../optionalImport";

export interface DocxPreviewProps {
  /** The artifact the selection belongs to (the store path of the file). */
  artifactId: string;
  /** Resolved URL of the stored file. */
  href: string;
  name: string;
  /** Shown while loading, and instead of the preview if it cannot be drawn. */
  fallback: ReactNode;
}

type Status = "loading" | "ready" | "unavailable";

const BANNER = "Preview only — to change it, ask in chat or select some text.";

export function DocxPreview({
  artifactId,
  href,
  name,
  fallback,
}: DocxPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [stats, setStats] = useState<DocxStats | null>(null);
  const [redrawn, setRedrawn] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const setSelections = useCanvasStore((s) => s.setSelections);

  useEffect(() => {
    let live = true;
    let observer: ResizeObserver | null = null;
    const host = hostRef.current;
    if (!host) return;
    setStatus("loading");
    setStats(null);
    setRedrawn([]);
    setPicked(null);
    (async () => {
      const { renderAsync } = await loadOptional(
        "docx-preview",
        () => import("docx-preview"),
      );
      const response = await fetch(href);
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
      const data = await response.arrayBuffer();
      if (!live) return;
      host.replaceChildren();
      await renderAsync(data, host, undefined, {
        inWrapper: true,
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        useBase64URL: true,
      });
      if (!live) return;
      stampDocxAddresses(host);
      // Before measuring: the swap changes what the markers draw, and the
      // reader is told about it on the same line as the substituted fonts.
      setRedrawn(redrawnFonts(restoreSymbolBullets(host)));
      setStats(docxStats(host));
      setStatus("ready");
      let fittedFor = host.clientWidth;
      fitToWidth(host, fittedFor);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
          // Only on a real width change: scaling the page can add or remove a
          // scrollbar, which resizes the host again, which would loop.
          if (Math.abs(host.clientWidth - fittedFor) < 2) return;
          fittedFor = host.clientWidth;
          fitToWidth(host, fittedFor);
        });
        observer.observe(host);
      }
    })().catch(() => {
      if (live) setStatus("unavailable");
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [href]);

  const choose = (pick: DocxPick | null) => {
    const host = hostRef.current;
    if (!host) return;
    for (const marked of Array.from(host.querySelectorAll(".is-picked"))) {
      marked.classList.remove("is-picked");
    }
    if (!pick) {
      setPicked(null);
      setSelections([]);
      return;
    }
    host
      .querySelector(`[${DOCX_ADDRESS_ATTRIBUTE}="${pick.address}"]`)
      ?.classList.add("is-picked");
    setPicked(pick.address);
    setSelections([
      {
        artifactId,
        cid: pick.address,
        selector: pick.label,
        tag: pick.kind === "table" ? "table" : "p",
        text: pick.literal ?? pick.text,
      },
    ]);
  };

  const onMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (!host || status !== "ready") return;
    const dragged = pickFromSelection(host, window.getSelection?.() ?? null);
    choose(dragged ?? pickFromNode(host, event.target as Node));
  };

  if (status === "unavailable") return <>{fallback}</>;

  return (
    <div className="cv-docx">
      <div className="cv-docx__banner" role="note">
        {BANNER}
      </div>
      {status === "loading" && (
        <div className="cv-docx__loading">{fallback}</div>
      )}
      <div
        ref={hostRef}
        className="cv-docx__page"
        onMouseUp={onMouseUp}
        aria-label={`${name} preview`}
        hidden={status !== "ready"}
      />
      {stats && (
        <div
          className="cv-docx__status"
          title="The preview keeps the document's own page breaks; it does not repaginate, so it states no page number."
        >
          <span>{stats.words.toLocaleString()} words</span>
          {picked && (
            <span className="cv-docx__picked">pointing at [{picked}]</span>
          )}
          {stats.substitutedFonts.length > 0 && (
            <span className="cv-docx__fonts">
              substituted: {stats.substitutedFonts.join(", ")}
            </span>
          )}
          {redrawn.length > 0 && (
            <span
              className="cv-docx__redrawn"
              title="This document writes its list bullets as characters in a symbol font's own private area, which no other font can draw. They are shown here as the standard characters that mean the same mark; the stored file is unchanged."
            >
              bullets redrawn: {redrawn.join(", ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
