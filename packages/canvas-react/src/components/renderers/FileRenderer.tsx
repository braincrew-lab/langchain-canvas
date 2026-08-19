/**
 * Renders a `type: "file"` artifact — a stored canvas file shown as itself.
 *
 * The data is a *reference* (`path` into the store), not a copy: images draw
 * the original bytes through the host's asset endpoint, page-renderable
 * sources show a derived page-one cover, text-extractable ones a short
 * excerpt — and everything gets the file card (name · size · type ·
 * download), so a file the canvas cannot preview is still honestly present.
 * Read-only by design: `sources/` uploads are the user's originals.
 */

import type { FileData } from "../../protocol/artifacts";
import { isAssetReference, resolveAssetUrl } from "../../io/canvasAssets";
import { useCanvasStore } from "../../hooks/useCanvasStore";
import type { RendererProps } from "../../registry/registry";

/** Human-readable byte size ("3.7 KB", "1.2 MB"). */
function formatSize(size: number | undefined): string | null {
  if (typeof size !== "number") return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

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
  // Without an asset endpoint the card still states the file's facts —
  // only the live image and the download link need the URL.
  const href = assetBaseUrl && isAssetReference(path) ? resolveAssetUrl(path, assetBaseUrl) : null;
  const isImage = Boolean(mediaType?.startsWith("image/"));

  const facts = [mediaType, formatSize(size), detail].filter(Boolean).join(" · ");

  return (
    <div className="cv-file">
      {isImage && href ? (
        <img className="cv-file__image" src={href} alt={name} />
      ) : cover ? (
        <img className="cv-file__cover" src={cover} alt={`${name} — first page`} />
      ) : excerpt ? (
        <pre className="cv-file__excerpt">{excerpt}</pre>
      ) : null}
      <div className="cv-file__card">
        <span className="cv-file__icon" aria-hidden>
          {iconFor(mediaType, name)}
        </span>
        <span className="cv-file__meta">
          <b>{name}</b>
          {facts && <span className="cv-file__facts">{facts}</span>}
        </span>
        {href && (
          <a className="cv-file__download" href={href} download={name}>
            Download
          </a>
        )}
      </div>
    </div>
  );
}
