/**
 * The client-side export actions for one artifact, as data.
 *
 * `<ExportMenu />` renders exactly this list; a host that draws its own export
 * control (one button, its own dropdown) builds the same list and gets the
 * same files — every path still leaves through the asset inliner, so exported
 * files stay self-contained.
 */

import type { Artifact, HtmlData, SlidesData } from "../protocol/artifacts";
import { DEFAULT_LABELS, type CanvasLabels } from "../components/chrome";
import { downloadBlob, slugify } from "./download";
import { dataExporters, htmlSlideToPrintHtml, slidesToPrintHtml, toStandaloneHtml } from "./exporters";
import { printToPdf } from "./pdf";
import { inlineArtifactAssets, inlineHtmlAssets } from "../io/canvasAssets";

/** Types whose rendered DOM (or slide model) prints faithfully to PDF. */
const PDF_TYPES = new Set(["html", "document", "chart", "slides"]);

export interface ExportAction {
  /** Stable key: `open-tab` · `copy` · `html` · `pdf` · a data exporter's extension. */
  id: string;
  label: string;
  /** Small extension chip after the label, e.g. "pptx". */
  extension?: string;
  run: () => Promise<void>;
}

export interface ExportActionOptions {
  /** The panel body's rendered HTML (editor chrome stripped), or null when unknown. */
  getRenderedHtml: () => string | null;
  /** The host's file endpoint prefix, or null (references stay unresolved). */
  assetBaseUrl: string | null;
  labels?: Partial<Pick<CanvasLabels, ExportLabelKey>>;
}

type ExportLabelKey =
  | "exportOpenInTab"
  | "exportCopyHtml"
  | "exportHtml"
  | "exportPdf"
  | "exportMarkdown"
  | "exportWord"
  | "exportCsv"
  | "exportJson";

const DATA_LABELS: Record<string, ExportLabelKey> = {
  md: "exportMarkdown",
  docx: "exportWord",
  csv: "exportCsv",
  json: "exportJson",
};

export function buildExportActions(artifact: Artifact, options: ExportActionOptions): ExportAction[] {
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  const { getRenderedHtml, assetBaseUrl } = options;
  const stem = slugify(artifact.title);

  // Every export path leaves through these two: canvas-asset references become
  // data: URIs so the exported file is self-contained. Without an asset
  // endpoint both are identity.
  const prepare = () => inlineArtifactAssets(artifact, assetBaseUrl);
  const prepareHtml = (html: string) =>
    assetBaseUrl ? inlineHtmlAssets(html, assetBaseUrl) : Promise.resolve(html);

  const standalone = async (forPrint = true): Promise<string | null> => {
    if (artifact.type === "html") {
      // The artifact *is* a full HTML document — export the real source, not the
      // iframe wrapper (capturing the rendered DOM would yield an empty <iframe>).
      // A fixed-aspect slide gets slide sizing + an @page rule so the downloaded
      // file both displays the slide correctly and prints to a slide-sized page;
      // a browser tab shows the page as authored.
      const ratio = artifact.meta?.ratio as string | undefined;
      const html = ((await prepare()).data as HtmlData).html;
      return forPrint && ratio ? htmlSlideToPrintHtml(html, ratio) : html;
    }
    if (artifact.type === "slides") {
      return slidesToPrintHtml((await prepare()).data as SlidesData, artifact.title);
    }
    const html = getRenderedHtml();
    return html == null ? null : toStandaloneHtml(artifact.title, await prepareHtml(html));
  };

  const actions: ExportAction[] = [
    {
      id: "open-tab",
      label: labels.exportOpenInTab,
      run: async () => {
        const html = await standalone(false);
        if (html == null) return;
        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      },
    },
    {
      id: "copy",
      label: labels.exportCopyHtml,
      run: async () => {
        const html = artifact.type === "html" ? ((await prepare()).data as HtmlData).html : getRenderedHtml();
        if (html == null) return;
        try {
          await navigator.clipboard.writeText(
            artifact.type === "html" ? html : toStandaloneHtml(artifact.title, await prepareHtml(html)),
          );
        } catch {
          /* clipboard blocked — no-op */
        }
      },
    },
    {
      id: "html",
      label: labels.exportHtml,
      extension: "html",
      run: async () => {
        if (artifact.type === "slides") {
          // A deck's HTML export is the rendered body, not the print sheet.
          const html = getRenderedHtml();
          if (html == null) return;
          downloadBlob(`${stem}.html`, "text/html", toStandaloneHtml(artifact.title, await prepareHtml(html)));
          return;
        }
        const html = await standalone();
        if (html == null) return;
        downloadBlob(`${stem}.html`, "text/html", html);
      },
    },
  ];

  if (PDF_TYPES.has(artifact.type)) {
    actions.push({
      id: "pdf",
      label: labels.exportPdf,
      extension: "pdf",
      run: async () => {
        // A fixed-aspect slide prints to a slide-sized landscape page (no A4
        // clip); a fluid web page prints as-is.
        const html = await standalone();
        if (html != null) printToPdf(html);
      },
    });
  }

  for (const option of dataExporters[artifact.type] ?? []) {
    actions.push({
      id: option.extension,
      label: labels[DATA_LABELS[option.extension]] ?? option.label,
      extension: option.extension,
      run: async () => {
        const content = await option.build(await prepare());
        downloadBlob(`${stem}.${option.extension}`, option.mime, content);
      },
    });
  }

  return actions;
}
