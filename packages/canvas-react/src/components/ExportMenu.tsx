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
import { dataExporters, slidesToPrintHtml, slidesToSvg, toStandaloneHtml, type FileExport } from "../export/exporters";
import { printToPdf } from "../export/pdf";

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

  const exportHtml = () => {
    if (artifact.type === "html") {
      // The artifact *is* a full HTML document — export the real source, not the
      // iframe wrapper (capturing the rendered DOM would yield an empty <iframe>).
      downloadBlob(`${stem}.html`, "text/html", (artifact.data as HtmlData).html);
    } else {
      const html = getRenderedHtml();
      if (html == null) return;
      downloadBlob(`${stem}.html`, "text/html", toStandaloneHtml(artifact.title, html));
    }
    setOpen(false);
  };

  const exportData = async (option: FileExport) => {
    const content = await option.build(artifact);
    downloadBlob(`${stem}.${option.extension}`, option.mime, content);
    setOpen(false);
  };

  const exportPdf = () => {
    if (artifact.type === "slides") {
      printToPdf(slidesToPrintHtml(artifact.data as SlidesData, artifact.title));
    } else if (artifact.type === "html") {
      printToPdf((artifact.data as HtmlData).html);
    } else {
      const html = getRenderedHtml();
      if (html == null) return;
      printToPdf(toStandaloneHtml(artifact.title, html));
    }
    setOpen(false);
  };

  // Copy slides as SVG to the clipboard — paste straight into Figma (it parses
  // clipboard SVG into editable frames + text).
  const copyToFigma = async () => {
    const svg = slidesToSvg(artifact.data as SlidesData);
    try {
      await navigator.clipboard.writeText(svg);
    } catch {
      /* clipboard blocked */
    }
    setOpen(false);
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
            <button role="menuitem" onClick={exportHtml}>
              HTML <span className="cv-export__ext">.html</span>
            </button>
            {PDF_TYPES.has(artifact.type) && (
              <button role="menuitem" onClick={exportPdf}>
                PDF <span className="cv-export__ext">.pdf</span>
              </button>
            )}
            {artifact.type === "slides" && (
              <button role="menuitem" onClick={copyToFigma}>
                Copy to Figma <span className="cv-export__ext">paste ⌘V</span>
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
