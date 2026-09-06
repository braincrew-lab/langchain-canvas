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
 *
 * Any other paged file (a deck, a PDF) whose `pageCount` is known opens as a
 * `PageViewer` when the host provides a page endpoint (`pageBaseUrl`): pages
 * are fetched one at a time at reading size instead of tiled into a sheet.
 * The viewer is the whole tab: the file card below it only stays when it has
 * a download link to offer.
 */

import { Suspense, lazy } from "react";

import type { FileData } from "../../protocol/artifacts";
import { resolveCanvasFileUrl, resolveCanvasPageUrl } from "../../io/canvasAssets";
import { PageViewer } from "./PageViewer";
import { TableRenderer } from "./TableRenderer";
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
  const { path, name, mediaType, size, cover, grids, pageCount, workbook, chartPages, excerpt, detail } =
    artifact.data;
  const assetBaseUrl = useCanvasStore((s) => s.assetBaseUrl);
  const pageBaseUrl = useCanvasStore((s) => s.pageBaseUrl);
  const labels = useLabels();
  const chrome = useChrome();
  // Without an asset endpoint the card still states the file's facts —
  // only the live image, the preview and the download link need the URL.
  const href = assetBaseUrl && path ? resolveCanvasFileUrl(path, assetBaseUrl) : null;
  // Every commit re-stamps the artifact (store revision, else the version
  // counter); the previews carry it in their URL so a new commit refetches
  // at once instead of showing the bytes the browser already holds. The
  // download link stays plain — it always serves the head.
  const stamp = (artifact.meta as { revision?: string } | undefined)?.revision ?? artifact.version;
  const previewHref = href ? `${href}&v=${encodeURIComponent(String(stamp))}` : null;
  const isImage = Boolean(mediaType?.startsWith("image/"));
  const isWord = `${path} ${name}`.toLowerCase().includes(".docx");
  const isWorkbook = Boolean(workbook);
  const paged =
    !isImage &&
    !isWord &&
    !isWorkbook &&
    Boolean(pageBaseUrl) &&
    typeof pageCount === "number" &&
    pageCount > 0;

  const facts = [mediaType, formatSize(size), detail]
    .filter(Boolean)
    .join(" · ");

  const preview =
    isImage && href ? (
      <img className="cv-file__image" src={previewHref ?? undefined} alt={name} />
    ) : isWorkbook && workbook ? (
      // A workbook reads as a spreadsheet: the sheets in a read-only grid,
      // and the rendered pages that carry charts underneath.
      <div className="cv-file__workbook">
        <TableRenderer
          artifact={{ ...artifact, type: "table", data: workbook } as never}
          readOnly
        />
        {pageBaseUrl && chartPages && chartPages.length > 0 && (
          <div className="cv-file__charts">
            {chartPages.map((n) => (
              <img
                key={n}
                className="cv-file__chart"
                src={resolveCanvasPageUrl(path, n, 1200, pageBaseUrl, stamp)}
                alt={`${name} chart ${n}`}
                loading="lazy"
              />
            ))}
          </div>
        )}
      </div>
    ) : paged && pageBaseUrl ? (
      <PageViewer
        path={path}
        name={name}
        pageCount={pageCount as number}
        pageBaseUrl={pageBaseUrl}
        version={stamp}
      />
    ) : grids && grids.length > 0 ? (
      // Every page at a glance — the same grid sheets the agent reads.
      <div className="cv-file__grids">
        {grids.map((sheet, index) => (
          <img key={index} className="cv-file__grid" src={sheet} alt={`${name} ${index + 1}`} />
        ))}
      </div>
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
    <div className={"cv-file" + (paged || isWorkbook ? " cv-file--pages" : "")}>
      {isWord && previewHref ? (
        <Suspense fallback={preview}>
          <DocxPreview
            artifactId={artifact.id}
            href={previewHref}
            name={name}
            fallback={preview}
          />
        </Suspense>
      ) : (
        preview
      )}
      {(!(paged || isWorkbook) || (chrome.fileDownload && href)) && (
      <div className="cv-file__card">
        <span className="cv-file__icon" aria-hidden>
          {iconFor(mediaType, name)}
        </span>
        <span className="cv-file__meta">
          <b>{name}</b>
          {chrome.fileFacts && facts && <span className="cv-file__facts">{facts}</span>}
        </span>
        {chrome.fileDownload && href && (
          <a className="cv-file__download" href={href} download={name}>
            {labels.download}
          </a>
        )}
      </div>
      )}
    </div>
  );
}
