/**
 * Renders a `type: "pdf"` artifact in the browser's built-in PDF viewer — zero
 * dependencies, full fidelity (text selection, search, zoom, page navigation all
 * come from the browser for free).
 *
 * The only wrinkle is the source URL. Agents and file imports deliver PDFs as
 * `data:` URLs (self-contained, serializable artifact data), but Chromium blocks
 * `data:` navigations in frames — so a data URL is decoded into a Blob and
 * viewed through a short-lived `blob:` object URL instead. `blob:`/`https:`
 * sources pass straight through.
 */

import { useEffect, useMemo, useState } from "react";

import type { PdfData } from "../../protocol/artifacts";
import type { RendererProps } from "../../registry/registry";

/**
 * Decode a data: URL into a Blob (handles base64 and percent-encoded bodies).
 * The MIME is pinned to application/pdf regardless of what the URL claims —
 * a `blob:` URL is same-origin with the host app, so honoring an attacker's
 * `data:text/html;…` here would hand artifact content a scriptable same-origin
 * frame. Pinned to PDF, the worst case is a viewer error on a non-PDF body.
 */
function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    if (m[1]) {
      const bin = atob(m[2]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: "application/pdf" });
    }
    return new Blob([decodeURIComponent(m[2])], { type: "application/pdf" });
  } catch {
    return null; // malformed base64/percent body — surface the empty state below
  }
}

export function PdfRenderer({ artifact }: RendererProps<PdfData>) {
  const src = artifact.data.src;
  const isData = typeof src === "string" && src.startsWith("data:");

  // data: → blob: object URL, revoked when the source changes or on unmount.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (!isData) {
      setBlobUrl(null);
      return;
    }
    const blob = dataUrlToBlob(src);
    if (!blob) {
      setBroken(true);
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [src, isData]);

  const viewUrl = isData ? blobUrl : src;
  const filename = useMemo(
    () => artifact.data.filename || `${artifact.title || "document"}.pdf`,
    [artifact.data.filename, artifact.title],
  );

  // The browser viewer's own chrome is hidden (`#toolbar=0`): it duplicates our
  // Download/Open controls and titles the document with the blob URL's UUID.
  // Zoom lives in our toolbar instead — changing the fragment re-fits the view.
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const zoomOut = () => setZoom((z) => Math.max(50, (z === "fit" ? 100 : z) - 25));
  const zoomIn = () => setZoom((z) => Math.min(300, (z === "fit" ? 100 : z) + 25));
  const frameSrc = viewUrl
    ? `${viewUrl}#toolbar=0&navpanes=0&zoom=${zoom === "fit" ? "page-width" : zoom}`
    : null;

  const download = () => {
    if (!viewUrl) return;
    const a = document.createElement("a");
    a.href = viewUrl;
    a.download = filename;
    a.click();
  };

  if (!src || broken) {
    return <div className="cv-pdf cv-pdf--empty">Waiting for PDF…</div>;
  }
  if (!viewUrl) {
    return <div className="cv-pdf cv-pdf--empty">Loading PDF…</div>;
  }

  return (
    <div className="cv-pdf-panel">
      <div className="cv-pdf-tools">
        <span className="cv-pdf-tools__name" title={filename}>{filename}</span>
        <span className="cv-pdf-tools__spacer" />
        <span className="cv-pdf-tools__zoom">
          <button type="button" onClick={zoomOut} title="Zoom out">−</button>
          <button
            type="button"
            className="cv-pdf-tools__zoom-label"
            onClick={() => setZoom("fit")}
            title="Fit to width"
          >
            {zoom === "fit" ? "Fit" : `${zoom}%`}
          </button>
          <button type="button" onClick={zoomIn} title="Zoom in">＋</button>
        </span>
        <span className="cv-pdf-tools__sep" />
        <button type="button" onClick={download} title="Download PDF">⤓ Download</button>
        <button
          type="button"
          onClick={() => window.open(viewUrl, "_blank", "noopener")}
          title="Open in a new tab"
        >
          ↗ Open
        </button>
      </div>
      <div className="cv-pdf">
        {/* The browser's own viewer. `title` for a11y; no sandbox — same-origin
            blob: content is the PDF bytes themselves, there is no script surface.
            Keyed by the fragment so a zoom change reloads with the new fit. */}
        <iframe key={frameSrc!} className="cv-pdf__frame" src={frameSrc!} title={filename} />
      </div>
    </div>
  );
}
