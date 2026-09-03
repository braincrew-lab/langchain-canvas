/**
 * Renders a `type: "file"` artifact — a stored canvas file shown as itself.
 *
 * The data is a *reference* (`path` into the store), not a copy: images draw
 * the original bytes through the host's asset endpoint, page-renderable
 * sources show a derived page-one cover, text-extractable ones a short
 * excerpt — and everything gets the file card (name · size · type ·
 * download), so a file the canvas cannot preview is still honestly present.
 * Read-only by design: `sources/` uploads are the user's originals.
 *
 * A Word file gets its own preview instead of a cover: `DocxPreview` draws the
 * real layout and lets the user point at a paragraph, which the card cannot.
 * That component is split out and optional — without its renderer installed,
 * or before it loads, this card is what shows.
 */

import { Suspense, lazy } from "react";

import type { FileData } from "../../protocol/artifacts";
import { resolveCanvasFileUrl } from "../../io/canvasAssets";
import { useCanvasStore } from "../../hooks/useCanvasStore";
import { useChrome, useLabels } from "../chrome";
import type { RendererProps } from "../../registry/registry";

/** Human-readable byte size ("3.7 KB", "1.2 MB"). */
function formatSize(size: number | undefined): string | null {
  if (typeof size !== "number") return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const DocxPreview = lazy(() =>
  import("./DocxPreview").then((m) => ({ default: m.DocxPreview })),
);

function iconFor(mediaType: string | undefined, name: string): string {
  if (mediaType?.startsWith("image/")) return "🖼️";
  if (mediaType === "application/pdf") return "📕";
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "📄";
  if (lower.endsWith(".xlsx") || lower.endsWith(".csv")) return "🔢";
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) return "📽️";
  return "📎";
}

export function FileRenderer({ artifact }: RendererProps<FileData>) {
  const { path, name, mediaType, size, cover, excerpt, detail } = artifact.data;
  const assetBaseUrl = useCanvasStore((s) => s.assetBaseUrl);
  const labels = useLabels();
  const chrome = useChrome();
  // Without an asset endpoint the card still states the file's facts —
  // only the live image, the preview and the download link need the URL.
  const href = assetBaseUrl && path ? resolveCanvasFileUrl(path, assetBaseUrl) : null;
  const isImage = Boolean(mediaType?.startsWith("image/"));
  const isWord = `${path} ${name}`.toLowerCase().includes(".docx");

  const facts = [mediaType, formatSize(size), detail]
    .filter(Boolean)
    .join(" · ");

  const preview =
    isImage && href ? (
      <img className="cv-file__image" src={href} alt={name} />
    ) : cover ? (
      <img
        className="cv-file__cover"
        src={cover}
        alt={labels.firstPage(name)}
      />
    ) : excerpt ? (
      <pre className="cv-file__excerpt">{excerpt}</pre>
    ) : null;

  return (
    <div className="cv-file">
      {isWord && href ? (
        <Suspense fallback={preview}>
          <DocxPreview
            artifactId={artifact.id}
            href={href}
            name={name}
            fallback={preview}
          />
        </Suspense>
      ) : (
        preview
      )}
      <div className="cv-file__card">
        <span className="cv-file__icon" aria-hidden>
          {iconFor(mediaType, name)}
        </span>
        <span className="cv-file__meta">
          <b>{name}</b>
          {chrome.fileFacts && facts && <span className="cv-file__facts">{facts}</span>}
        </span>
        {href && (
          <a className="cv-file__download" href={href} download={name}>
            {labels.download}
          </a>
        )}
      </div>
    </div>
  );
}
