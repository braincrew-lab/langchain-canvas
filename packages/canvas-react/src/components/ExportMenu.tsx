/**
 * A small "Export" dropdown in the canvas header.
 *
 * Always offers **HTML** (the rendered artifact wrapped into a standalone
 * `.html` file) plus any data exporters registered for the artifact's type
 * (`.md`, `.csv`, `.json`, …). The rendered HTML is read lazily from the panel
 * body via `getRenderedHtml`, so the export always matches exactly what's shown.
 */

import { useState } from "react";

import type { Artifact, HtmlData, SlidesData } from "../protocol/artifacts";
import { downloadBlob, slugify } from "../export/download";
import { dataExporters, htmlSlideToPrintHtml, slidesToPrintHtml, toStandaloneHtml, type FileExport } from "../export/exporters";
import { printToPdf } from "../export/pdf";
import { inlineArtifactAssets, inlineHtmlAssets } from "../io/canvasAssets";
import { useCanvasStore } from "../hooks/useCanvasStore";

/** Types whose rendered DOM (or slide model) prints faithfully to PDF. */
const PDF_TYPES = new Set(["html", "document", "chart", "slides"]);

interface ExportMenuProps {
  artifact: Artifact;
  getRenderedHtml: () => string | null;
}

export function ExportMenu({ artifact, getRenderedHtml }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const stem = slugify(artifact.title);
  const dataOptions = dataExporters[artifact.type] ?? [];
  const assetBaseUrl = useCanvasStore((s) => s.assetBaseUrl);

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
    } else {
      const html = getRenderedHtml();
      if (html == null) return;
      downloadBlob(`${stem}.html`, "text/html", toStandaloneHtml(artifact.title, await prepareHtml(html)));
    }
    setOpen(false);
  };

  const exportData = async (option: FileExport) => {
    const content = await option.build(await prepare());
    downloadBlob(`${stem}.${option.extension}`, option.mime, content);
    setOpen(false);
  };

  const exportPdf = async () => {
    if (artifact.type === "slides") {
      printToPdf(slidesToPrintHtml((await prepare()).data as SlidesData, artifact.title));
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
    const html =
      artifact.type === "html"
        ? (((await prepare()).data as HtmlData).html)
        : artifact.type === "slides"
          ? slidesToPrintHtml((await prepare()).data as SlidesData, artifact.title)
          : await (async () => { const h = getRenderedHtml(); return h == null ? null : toStandaloneHtml(artifact.title, await prepareHtml(h)); })();
    if (html == null) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setOpen(false);
  };

  const [copied, setCopied] = useState(false);
  const copyHtml = async () => {
    const html = artifact.type === "html" ? ((await prepare()).data as HtmlData).html : getRenderedHtml();
    if (html == null) return;
    try {
      await navigator.clipboard.writeText(
        artifact.type === "html" ? html : toStandaloneHtml(artifact.title, await prepareHtml(html)),
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
          </div>
        </>
      )}
    </div>
  );
}
