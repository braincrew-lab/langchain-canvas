/**
 * Artifact → file exporters.
 *
 * Two kinds of export:
 *
 * 1. **HTML** (`toStandaloneHtml`) — wrap the *rendered* DOM of any artifact into
 *    a self-contained `.html` document with inlined styles.
 * 2. **Data exporters** (`dataExporters`) — deterministic, per-type conversions
 *    straight from `artifact.data`: markdown `.md`, table `.csv`, document
 *    `.docx`, raw `.json`.
 *
 * `docx` is loaded via **dynamic import** so it never touches the main bundle —
 * only the code path a user actually clicks pulls it in. Spreadsheets and decks
 * export through the Python side (`TableXlsxExporter`, `DeckPptxExporter`),
 * which keeps a deck's template skin and its fonts; the browser has no
 * equivalent, and reading a workbook well takes more than a browser should
 * carry.
 */

import type { Artifact, DocumentData, TableData } from "../protocol/artifacts";
import { parseDeckHtml } from "../client/deck";
import { projectSheetIntoRows } from "../io/tableMerge";
import { loadOptional } from "../optionalImport";

export interface FileExport {
  /** Menu label, e.g. "Excel". */
  label: string;
  /** File extension without the dot, e.g. "csv". */
  extension: string;
  mime: string;
  /** Build the file contents (text or binary; may be async for Office formats). */
  build: (artifact: Artifact) => BlobPart | Promise<BlobPart>;
}

const MIME = {
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

/** Per-type data exporters, keyed by `artifact.type`. */
export const dataExporters: Record<string, FileExport[]> = {
  document: [
    { label: "Markdown", extension: "md", mime: MIME.md, build: (a) => (a.data as DocumentData).content },
    { label: "Word", extension: "docx", mime: MIME.docx, build: (a) => documentToDocx(a.data as DocumentData) },
  ],
  table: [
    { label: "CSV", extension: "csv", mime: MIME.csv, build: (a) => tableToCsv(a.data as TableData) },
  ],
  chart: [
    { label: "JSON", extension: "json", mime: MIME.json, build: (a) => JSON.stringify(a.data, null, 2) },
  ],
};

/**
 * Browsers leave background colours out of a print. "Background graphics" is
 * unchecked by default in the print dialog, and a slide draws its shapes and
 * its page fill as CSS backgrounds — so a PDF came out with the text alone,
 * every band and box gone. `print-color-adjust: exact` prints them anyway.
 * Every document that can reach the print pipeline carries this rule.
 */
export const PRINT_COLOR_CSS =
  "*{-webkit-print-color-adjust:exact;print-color-adjust:exact}";

/** Wrap already-rendered inner HTML into a standalone, styled `.html` document. */
export function toStandaloneHtml(title: string, renderedHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}
${PRINT_COLOR_CSS}</style>
</head>
<body>
<main class="export">
${renderedHtml}
</main>
</body>
</html>`;
}

// --- table → csv ----------------------------------------------------------------

function tableToCsv(data: TableData): string {
  // A person's grid edits live in `sheet` — project them into rows first so
  // the CSV shows what the person sees, not stale structured rows.
  const rows = data.sheet?.length
    ? projectSheetIntoRows(data.columns, data.rows, data.sheet)
    : data.rows;
  const header = data.columns.map((c) => csvCell(c.label ?? c.key)).join(",");
  const body = rows
    .map((row) => data.columns.map((c) => csvCell(String(row[c.key] ?? ""))).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

async function documentToDocx(data: DocumentData): Promise<BlobPart> {
  const { Document, Packer, Paragraph, HeadingLevel } = await loadOptional("docx", () => import("docx"));

  const paragraphs = data.content.split("\n").map((line) => {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][heading[1].length - 1];
      return new Paragraph({ text: heading[2], heading: level });
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) return new Paragraph({ text: bullet[1], bullet: { level: 0 } });
    return new Paragraph({ text: line });
  });

  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBlob(doc);
}

/** Print pixel dimensions for a fixed-aspect slide ratio (16:9 → 1280×720,
 *  4:3 → 960×720) — shared by the single-slide and deck print paths so both
 *  land on the same page size. */
function slidePixelSize(ratio: string | undefined): { w: number; h: number } {
  return { w: ratio === "4:3" ? 960 : 1280, h: 720 };
}

/**
 * A print-ready HTML document with one page per slide of a canonical
 * `*.slides.html` deck — fed to the browser's print pipeline to produce a
 * multi-page PDF. Each slide's own `styleCss`/`bodyHtml` (from
 * {@link parseDeckHtml}) is rendered inside its own sized, page-breaking
 * `<section>`, then the whole document is passed through
 * {@link htmlSlideToPrintHtml} for the shared `@page` sizing and print-color
 * rules — the same finishing pass a single fixed-slide `html` artifact gets.
 */
export function slidesToPrintHtml(deckHtml: string, title: string): string {
  const deck = parseDeckHtml(deckHtml);
  const { w, h } = slidePixelSize(deck.ratio);
  const slides = deck.slides.length
    ? deck.slides
    : [{ slideId: "empty", title: "Empty deck", styleCss: "", bodyHtml: "" }];
  const sections = slides
    .map((slide, i) => {
      const style = slide.styleCss ? `<style>${slide.styleCss}</style>` : "";
      const isLast = i === slides.length - 1;
      const box = `width:${w}px;height:${h}px;position:relative;overflow:hidden` + (isLast ? "" : ";page-break-after:always");
      return `<section class="cv-print-slide" style="${box}">${style}${slide.bodyHtml}</section>`;
    })
    .join("");
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(title)}</title></head><body>${sections}</body></html>`;
  return htmlSlideToPrintHtml(doc, deck.ratio);
}

/**
 * Wrap a single html-substrate slide (a full HTML document containing a
 * `.slide-container`) for print/PDF: force the print page to the slide's own
 * size (16:9 → 1280×720, 4:3 → 960×720) with zero margin, and pin the slide box
 * to that page. Without this the browser prints the 1280px slide onto a default
 * A4-portrait page and clips it — this makes the PDF one clean, full-bleed slide.
 */
export function htmlSlideToPrintHtml(html: string, ratio?: string): string {
  const { w, h } = slidePixelSize(ratio);
  const style =
    `<style>@page{size:${w}px ${h}px;margin:0}` +
    `${PRINT_COLOR_CSS}` +
    `html,body{margin:0!important;padding:0!important;background:#fff}` +
    `.slide-container{width:${w}px!important;height:${h}px!important;` +
    `box-shadow:none!important;border-radius:0!important;overflow:hidden!important;` +
    `page-break-after:avoid}</style>`;
  const i = html.toLowerCase().lastIndexOf("</head>");
  return i === -1 ? style + html : html.slice(0, i) + style + html.slice(i);
}


// --- helpers --------------------------------------------------------------------

function escapeXml(value: string): string {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const EXPORT_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; background: #fff; color: #1f2328;
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.export { max-width: 760px; margin: 48px auto; padding: 0 24px; }
h1,h2,h3 { line-height: 1.25; }
pre { background: #f6f8fa; padding: 14px 16px; border-radius: 10px; overflow-x: auto; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
th { background: #f6f8fa; }
svg { max-width: 100%; height: auto; }
`.trim();
