/**
 * A small "Export" dropdown in the canvas header.
 *
 * Always offers **HTML** (the rendered artifact wrapped into a standalone
 * `.html` file) plus any data exporters registered for the artifact's type
 * (`.md`, `.csv`, `.json`, …). The rendered HTML is read lazily from the panel
 * body via `getRenderedHtml`, so the export always matches exactly what's shown.
 */

import { useState } from "react";

import { isLegacySlidesData, type Artifact, type HtmlData, type SlidesData } from "../protocol/artifacts";
import { downloadBlob, slugify } from "../export/download";
import { dataExporters, htmlSlideToPrintHtml, slidesToPrintHtml, toStandaloneHtml, type FileExport } from "../export/exporters";
import { printToPdf } from "../export/pdf";
import { inlineArtifactAssets, inlineHtmlAssets } from "../io/canvasAssets";
import { useCanvasStore } from "../hooks/useCanvasStore";

/** Types whose rendered DOM (or slide model) prints faithfully to PDF. */
const PDF_TYPES = new Set(["html", "document", "chart", "slides"]);

/** The deck's `*.slides.html` source, or `null` for the legacy `{ slides }`
 *  shape (which the renderer already shows as a read-only card, so there is
 *  nothing meaningful to print). */
function deckHtmlOf(data: SlidesData): string | null {
  return isLegacySlidesData(data) || typeof data.html !== "string" ? null : data.html;
}

interface ExportMenuProps {
  artifact: Artifact;
  getRenderedHtml: () => string | null;
}

/** Store path for an artifact's export source (the id when already a path). */
function exportPath(artifactId: string, suffix: string): string {
  return artifactId.endsWith(suffix)
    ? artifactId
    : `${artifactId.replace(/[^a-zA-Z0-9._-]/g, "-")}${suffix}`;
}

/** A server-rendered office export (the browser has no writer for these). */
interface ServerExport {
  label: string;
  extension: string;
  mime: string;
  /** The current artifact content, in the file dialect the export path implies. */
  content: (artifact: Artifact) => string | null;
}

const SERVER_EXPORTS: Record<string, ServerExport[]> = {
  slides: [
    {
      label: "PowerPoint",
      extension: "pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content: (a) => deckHtmlOf(a.data as SlidesData),
    },
  ],
  table: [
    {
      label: "Excel",
      extension: "xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content: (a) => JSON.stringify({ type: a.type, title: a.title, data: a.data }),
    },
  ],
};

const SERVER_EXPORT_SUFFIX: Record<string, string> = {
  slides: ".slides.html",
  table: ".table.json",
};

export function ExportMenu({ artifact, getRenderedHtml }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const stem = slugify(artifact.title);
  const dataOptions = dataExporters[artifact.type] ?? [];
  const assetBaseUrl = useCanvasStore((s) => s.assetBaseUrl);
  const exportUrl = useCanvasStore((s) => s.exportUrl);

  // Every export path leaves through these two: canvas-asset references become
  // data: URIs so the exported file is self-contained. Without an asset
  // endpoint both are identity.
  const prepare = () => inlineArtifactAssets(artifact, assetBaseUrl);
  const prepareHtml = (html: string) =>
    assetBaseUrl ? inlineHtmlAssets(html, assetBaseUrl) : Promise.resolve(html);

  const exportHtml = async () => {
    if (artifact.type === "html") {
      // The artifact *is* a full HTML document — export the real source, not the
      // iframe wrapper (capturing the rendered DOM would yield an empty <iframe>).
      // A fixed-aspect slide gets slide sizing + an @page rule so the downloaded
      // file both displays the slide correctly and prints to a slide-sized page.
      const ratio = artifact.meta?.ratio as string | undefined;
      const html = ((await prepare()).data as HtmlData).html;
      downloadBlob(`${stem}.html`, "text/html", ratio ? htmlSlideToPrintHtml(html, ratio) : html);
    } else if (artifact.type === "slides") {
      const html = deckHtmlOf((await prepare()).data as SlidesData);
      if (html == null) return;
      downloadBlob(`${stem}.slides.html`, "text/html", html);
    } else {
      const html = getRenderedHtml();
      if (html == null) return;
      downloadBlob(`${stem}.html`, "text/html", toStandaloneHtml(artifact.title, await prepareHtml(html)));
    }
    setOpen(false);
  };

  // Server-rendered office formats (deck → .pptx, table → .xlsx): POST the
  // current content (assets inlined) to the host's export endpoint and save
  // the returned bytes. Shown only when the host provided `exportUrl`.
  const serverOptions = exportUrl ? (SERVER_EXPORTS[artifact.type] ?? []) : [];
  const exportServer = async (option: ServerExport) => {
    if (exporting) return;
    setExporting(option.extension);
    setExportError(null);
    try {
      const prepared = await prepare();
      const content = option.content(prepared);
      if (content == null) throw new Error("This deck format cannot be exported.");
      const suffix = SERVER_EXPORT_SUFFIX[artifact.type];
      const res = await fetch(exportUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: exportPath(artifact.id, suffix),
          target: option.extension,
          content,
          title: artifact.title,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(typeof body?.detail === "string" ? body.detail : `Export failed (${res.status}).`);
      }
      downloadBlob(`${stem}.${option.extension}`, option.mime, await res.blob());
      setOpen(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed. Please retry.");
    } finally {
      setExporting(null);
    }
  };

  const exportData = async (option: FileExport) => {
    const content = await option.build(await prepare());
    downloadBlob(`${stem}.${option.extension}`, option.mime, content);
    setOpen(false);
  };

  const exportPdf = async () => {
    if (artifact.type === "slides") {
      const deckHtml = deckHtmlOf((await prepare()).data as SlidesData);
      if (deckHtml != null) printToPdf(slidesToPrintHtml(deckHtml, artifact.title));
    } else if (artifact.type === "html") {
      const ratio = artifact.meta?.ratio as string | undefined;
      const html = ((await prepare()).data as HtmlData).html;
      // A fixed-aspect slide prints to a slide-sized landscape page (no A4 clip);
      // a fluid web page prints as-is.
      printToPdf(ratio ? htmlSlideToPrintHtml(html, ratio) : html);
    } else {
      const html = getRenderedHtml();
      if (html == null) return;
      printToPdf(toStandaloneHtml(artifact.title, await prepareHtml(html)));
    }
    setOpen(false);
  };

  const openInTab = async () => {
    let html: string | null;
    if (artifact.type === "html") {
      html = ((await prepare()).data as HtmlData).html;
    } else if (artifact.type === "slides") {
      const deckHtml = deckHtmlOf((await prepare()).data as SlidesData);
      html = deckHtml == null ? null : slidesToPrintHtml(deckHtml, artifact.title);
    } else {
      const rendered = getRenderedHtml();
      html = rendered == null ? null : toStandaloneHtml(artifact.title, await prepareHtml(rendered));
    }
    if (html == null) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setOpen(false);
  };

  const [copied, setCopied] = useState(false);
  const copyHtml = async () => {
    const isHtmlSource = artifact.type === "html" || artifact.type === "slides";
    const html = artifact.type === "slides"
      ? deckHtmlOf((await prepare()).data as SlidesData)
      : artifact.type === "html" ? ((await prepare()).data as HtmlData).html : getRenderedHtml();
    if (html == null) return;
    try {
      await navigator.clipboard.writeText(
        isHtmlSource ? html : toStandaloneHtml(artifact.title, await prepareHtml(html)),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <div className="cv-export">
      <button
        className="cv-export__btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Export ▾
      </button>

      {open && (
        <>
          <div className="cv-export__scrim" onClick={() => setOpen(false)} />
          <div className="cv-export__menu" role="menu">
            <button role="menuitem" onClick={openInTab}>
              Open in new tab ↗
            </button>
            <button role="menuitem" onClick={copyHtml}>
              {copied ? "Copied ✓" : "Copy HTML"}
            </button>
            <button role="menuitem" onClick={exportHtml}>
              HTML <span className="cv-export__ext">.html</span>
            </button>
            {PDF_TYPES.has(artifact.type) && (
              <button role="menuitem" onClick={exportPdf}>
                PDF <span className="cv-export__ext">.pdf</span>
              </button>
            )}
            {dataOptions.map((option) => (
              <button key={option.extension} role="menuitem" onClick={() => exportData(option)}>
                {option.label} <span className="cv-export__ext">.{option.extension}</span>
              </button>
            ))}
            {serverOptions.map((option) => (
              <button key={option.extension} role="menuitem" disabled={exporting !== null} onClick={() => exportServer(option)}>
                {exporting === option.extension ? "Exporting…" : option.label} <span className="cv-export__ext">.{option.extension}</span>
              </button>
            ))}
            {artifact.type === "slides" && serverOptions.length > 0 && (
              <p className="cv-export__note">PowerPoint exports editable text and shapes from the slide HTML. Original images remain images.</p>
            )}
            {exportError && <p className="cv-export__error" role="alert">{exportError}</p>}
          </div>
        </>
      )}
    </div>
  );
}
