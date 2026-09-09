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
 * export through the Python side (`TableXlsxExporter`, `SlidesPptxExporter`),
 * which keeps a deck's template skin and its fonts; the browser has no
 * equivalent, and reading a workbook well takes more than a browser should
 * carry.
 */

import type { Artifact, DocumentData, SlideElement, SlidesData, TableData } from "../protocol/artifacts";
import { defaultTextColor, resolveElements } from "../client/slideElements";
import { deckPage, PAGE_DPI } from "../client/slidePage";
import { CELL_PAD_X, CELL_PAD_Y, cellKey, cellLook, tableGrid } from "../client/slideTable";
import { boxHeightPct, BULLET_HANG_EM, BULLET_PREFIX, bulletParagraphs, DEFAULT_LINE_HEIGHT, inkGuardCss, textFitScale } from "../client/slideText";
import { projectSheetIntoRows } from "../io/tableMerge";
import { loadOptional } from "../optionalImport";
import { readDocxImage } from "./docxImage";
import { markdownBlocks, type MdRun } from "./markdownBlocks";

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

/** The monospace face the Python door names for code (`exporters.py::_CODE_FACE`). */
const DOCX_CODE_FACE = "Consolas";
/** The numbering definition numbered items reference (three levels). */
const DOCX_NUMBERING = "cv-numbered";
/** A picture is placed no wider than 6 in at 96 dpi, like the Python door's `Inches(6)`. */
const DOCX_IMAGE_MAX_PX = 576;
/** A quote is set in by half an inch (twips), in italics — the Python door's
 *  "Intense Quote" style has no docx.js twin; a documented deviation (plan §U5). */
const DOCX_QUOTE_INDENT = 720;
/** The page the Word doors declare (U6): Letter, 1 in on every side, in
 *  twips — the same sheet the Python door writes and the screen's Word page
 *  draws, not the writer library's default (A4). */
const DOCX_PAGE = {
  size: { width: 12240, height: 15840 },
  margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
};
/** The text column that page declares, in twips (9360) — what a table's
 *  grid, its cells and its `tblW` all sum to, as in the Python door's
 *  `_add_table` (U6). */
const DOCX_TEXT_COLUMN_TWIPS = DOCX_PAGE.size.width - DOCX_PAGE.margin.left - DOCX_PAGE.margin.right;

/** An unstated (markdown) table's grid: the column split evenly, the last
 *  column taking the remainder so the sum is exactly the column. docx.js
 *  would otherwise leave `gridCol` at a 100-twip placeholder and write no
 *  `tcW`, so a viewer laying out from the cells saw no widths at all. */
function docxColumnWidths(columns: number): number[] {
  const count = Math.max(1, columns);
  const each = Math.floor(DOCX_TEXT_COLUMN_TWIPS / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? DOCX_TEXT_COLUMN_TWIPS - each * (count - 1) : each));
}

type Docx = typeof import("docx");

/** Header dimensions preserve valid image bytes even in runtimes without a
 * bitmap decoder. No ImageBitmap is allocated, so none needs closing. */
async function docxImage(docx: Docx, base64: string): Promise<InstanceType<Docx["Paragraph"]>> {
  const image = readDocxImage(base64);
  const scale = Math.min(1, DOCX_IMAGE_MAX_PX / image.width);
  const transformation = { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
  return new docx.Paragraph({ children: [new docx.ImageRun({ type: image.type, data: image.bytes, transformation })] });
}

/**
 * The browser's Word file as a `docx` Document — the same block set the
 * Python door writes (`exporters.py::_blocks_to_docx`, U5): headings h1–h4,
 * soft-joined paragraphs with inline bold / italic / strike / code, bullet and
 * numbered items three levels deep, quotes, fenced code, pipe tables with
 * their column alignment, rules and `data:` pictures. Exported so a test can
 * pack it to bytes; `documentToDocx` packs it to the download Blob.
 */
export async function documentToDocxDocument(data: DocumentData): Promise<InstanceType<Docx["Document"]>> {
  const docx = await loadOptional("docx", () => import("docx"));
  const { Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, LevelFormat } = docx;
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  // A run's "\n" (a two-space line end) is a line break inside the paragraph,
  // as python-docx writes it for the same text.
  const runs = (mdRuns: MdRun[], extra: { bold?: boolean; italics?: boolean } = {}) =>
    mdRuns.flatMap((mdRun) =>
      mdRun.text.split("\n").map(
        (text, index) =>
          new TextRun({
            text,
            bold: mdRun.bold || extra.bold,
            italics: mdRun.italic || extra.italics,
            strike: mdRun.strike,
            ...(mdRun.code ? { font: DOCX_CODE_FACE } : {}),
            ...(index ? { break: 1 } : {}),
          }),
      ),
    );

  const children: (InstanceType<Docx["Paragraph"]> | InstanceType<Docx["Table"]>)[] = [];
  for (const block of markdownBlocks(data.content)) {
    switch (block[0]) {
      case "heading":
        children.push(new Paragraph({ heading: headings[Math.min(block[1], 4) - 1], children: runs(block[2]) }));
        break;
      case "para":
        children.push(new Paragraph({ children: runs(block[1]) }));
        break;
      case "bullet":
        children.push(new Paragraph({ children: runs(block[1]), bullet: { level: block[2] } }));
        break;
      case "numbered":
        children.push(new Paragraph({ children: runs(block[1]), numbering: { reference: DOCX_NUMBERING, level: block[2] } }));
        break;
      case "quote":
        children.push(new Paragraph({ children: runs(block[1], { italics: true }), indent: { left: DOCX_QUOTE_INDENT } }));
        break;
      case "code":
        for (const line of block[1].split("\n")) {
          children.push(new Paragraph({ children: [new TextRun({ text: line, font: DOCX_CODE_FACE, size: 18 })] }));
        }
        break;
      case "table": {
        const widths = docxColumnWidths(Math.max(...block[1].map((row) => row.length)));
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            columnWidths: widths,
            rows: block[1].map(
              (row, r) =>
                new TableRow({
                  children: row.map(
                    (cell, c) =>
                      new TableCell({
                        width: { size: widths[c], type: WidthType.DXA },
                        children: [
                          new Paragraph({
                            children: runs(cell.runs, { bold: block[2] && r === 0 }),
                            ...(cell.align ? { alignment: cell.align === "center" ? AlignmentType.CENTER : AlignmentType.RIGHT } : {}),
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
        );
        break;
      }
      case "rule":
        children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999" } } }));
        break;
      case "image": {
        const picture = await docxImage(docx, block[1]);
        children.push(picture);
        break;
      }
    }
  }
  return new Document({
    numbering: {
      config: [
        {
          reference: DOCX_NUMBERING,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: DOCX_QUOTE_INDENT * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ properties: { page: DOCX_PAGE }, children }],
  });
}

async function documentToDocx(data: DocumentData): Promise<BlobPart> {
  const { Packer } = await loadOptional("docx", () => import("docx"));
  return Packer.toBlob(await documentToDocxDocument(data));
}

/**
 * A print-ready HTML document with one landscape page per slide — fed to the
 * browser's print pipeline to produce a multi-page PDF. Elements keep their
 * percentage geometry, so pages match the on-canvas layout exactly.
 *
 * The page is the deck's own page at `PAGE_DPI`, which is the density
 * `fontSize` is stored at — so stored px are CSS px here and text needs no
 * scaling at all. Viewport units would resolve against whatever box the
 * printing frame happens to have, which is how the same document came out
 * one size in the print preview and another in the saved file.
 */
export function slidesToPrintHtml(data: SlidesData, title: string): string {
  const slides = data.slides.length ? data.slides : [{ title: "Empty deck" }];
  const page = deckPage(data);
  const pw = Math.round(page.widthIn * PAGE_DPI);
  const ph = Math.round(page.heightIn * PAGE_DPI);
  const pages = slides
    .map((slide) => {
      const bg = slide.background ?? "#ffffff";
      const fg = slide.textColor ?? defaultTextColor(slide.background);
      const backdrop = slide.masterImage
        ? `<img src="${escapeAttr(slide.masterImage)}" style="position:absolute;inset:0;width:100%;height:100%" alt=""/>`
        : "";
      const els = resolveElements(slide, page)
        .map((el) => {
          // Rotation rides the shared box string so every element type (text,
          // shape, table, image) turns about its centre in the printed page,
          // matching the editor and the .pptx export. `rotation` is numeric.
          // A box that grows with its text carries the ink guard (U1): the
          // estimator's height plus the face's own bottom overhang, resolved
          // by the browser on a `line-height: normal` box whose text child
          // keeps the leading — the same rule `textBoxStyle` draws on screen.
          const grown = el.type === "text" && el.autofit === "shape";
          const height = grown
            ? `calc(${boxHeightPct(el, page)}% + ${inkGuardCss(el.lineHeight)})`
            : `${boxHeightPct(el, page)}%`;
          const box = `left:${el.x}%;top:${el.y}%;width:${el.w}%;height:${height}${el.rotation ? `;transform:rotate(${el.rotation}deg)` : ""}`;
          if (el.type === "text") {
            // box is numeric; colours and the face are escaped individually — the
            // composed style string is then safe to place in the attribute as-is.
            const style = [
              box,
              `font-size:${(el.fontSize ?? 24) * textFitScale(el, page)}px`,
              `font-weight:${el.bold ? 700 : 400}`,
              `color:${escapeAttr(el.color ?? fg)}`,
              el.stroke ? `-webkit-text-stroke:${Math.max(0.5, el.strokeWidth ?? 1)}px ${escapeAttr(el.stroke)}` : "",
              `text-align:${escapeAttr(el.align ?? "left")}`,
              el.wrap === false ? "white-space:pre" : "white-space:pre-wrap",
              el.fontFamily ? `font-family:${escapeAttr(el.fontFamily)},Inter,Arial,sans-serif` : "",
              grown ? "line-height:normal" : el.lineHeight ? `line-height:${el.lineHeight}` : "",
              el.highlight ? `background:${escapeAttr(el.highlight)}` : "",
              el.spaceBefore ? `padding-top:${el.spaceBefore}px` : "",
              el.spaceAfter ? `padding-bottom:${el.spaceAfter}px` : "",
              // The box is the text's frame, so sitting text in the middle or at
              // the foot of it is a column laid out along the box height.
              el.verticalAlign
                ? `display:flex;flex-direction:column;justify-content:${
                    el.verticalAlign === "middle" ? "center" : el.verticalAlign === "bottom" ? "flex-end" : "flex-start"
                  }`
                : "",
            ]
              .filter(Boolean)
              .join(";");
            // Snug one-liners are marked for the print pipeline to fit: the
            // host (trusted) measures and shrinks them a hair before print()
            // — the sandboxed frame itself runs no scripts.
            const snug =
              el.text && !el.text.includes("\n") && el.wrap !== false && el.autofit !== "text"
                ? ' data-snug="1"'
                : "";
            // A bulleted body prints as the file draws it (U3): one block per
            // paragraph, a bullet paragraph hanging under one fixed-width marker
            // (`.p-bullet`, the same rule `FittedText` draws on screen); each
            // paragraph's body is escaped on its own, the marker is a literal.
            const paragraphs = bulletParagraphs(el.text ?? "");
            const body = paragraphs
              ? paragraphs
                  .map((p) =>
                    p.bullet
                      ? `<div class="p-bullet"><span class="p-bullet__marker">${BULLET_PREFIX.trim()}</span>${escapeXml(p.text)}</div>`
                      : `<div>${escapeXml(p.text) || "&#160;"}</div>`,
                  )
                  .join("")
              : escapeXml(el.text ?? "");
            // The grown box's text child keeps the leading the box gave up to the guard.
            const inner = grown ? `<div class="el__text" style="line-height:${el.lineHeight ?? DEFAULT_LINE_HEIGHT}">${body}</div>` : body;
            return `<div class="el"${snug} style="${style}">${inner}</div>`;
          }
          if (el.type === "shape") {
            // A box drawn by its outline alone carries no fill — painting one
            // would hide whatever the border is meant to frame.
            const isLine = el.shape === "line";
            // A line is its stroke (see shapeStyle); a box may be outline-only.
            const bodyFill = el.fill && el.fill !== "none" ? el.fill : undefined;
            const fill = escapeAttr(
              isLine ? (bodyFill ?? el.stroke ?? fg) : (bodyFill ?? "transparent"),
            );
            // Square like the file's `prst="rect"` and its straight connector (U4).
            const radius = el.shape === "ellipse" ? "50%" : "0";
            const outline =
              el.stroke && !isLine
                ? `;border:${Math.max(1, el.strokeWidth ?? 1)}px solid ${escapeAttr(el.stroke)}`
                : isLine
                  ? `;min-height:${Math.max(1, el.strokeWidth ?? 1)}px`
                  : "";
            return `<div class="el" style="${box};background:${fill};border-radius:${radius}${outline}"></div>`;
          }
          if (el.type === "table") return tableHtml(el, box, fg);
          const src = safeSrc(el.src);
          return src ? `<img class="el" style="${box}" src="${escapeAttr(src)}"/>` : "";
        })
        .join("");
      const pad = slide.padding ?? 0;
      const inner = pad ? `<div style="position:absolute;inset:${pad}%">${els}</div>` : els;
      return `<section class="slide" style="background:${escapeAttr(bg)}">${backdrop}${inner}</section>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>
    @page { size: ${pw}px ${ph}px; margin: 0; }
    * { margin: 0; box-sizing: border-box; }
    ${PRINT_COLOR_CSS}
    body { font-family: Inter, Arial, sans-serif; }
    .slide { position: relative; width: ${pw}px; height: ${ph}px; overflow: hidden; page-break-after: always; }
    .el { position: absolute; overflow: hidden; line-height: ${DEFAULT_LINE_HEIGHT}; }
    .p-bullet { padding-left: ${BULLET_HANG_EM}em; text-indent: -${BULLET_HANG_EM}em; }
    .p-bullet__marker { display: inline-block; width: ${BULLET_HANG_EM}em; text-indent: 0; }
    img.el { object-fit: contain; }
  </style></head><body>${pages}</body></html>`;
}

/**
 * Wrap a single html-substrate slide (a full HTML document containing a
 * `.slide-container`) for print/PDF: force the print page to the slide's own
 * size (16:9 → 1280×720, 4:3 → 960×720) with zero margin, and pin the slide box
 * to that page. Without this the browser prints the 1280px slide onto a default
 * A4-portrait page and clips it — this makes the PDF one clean, full-bleed slide.
 */
export function htmlSlideToPrintHtml(html: string, ratio?: string): string {
  const w = ratio === "4:3" ? 960 : 1280;
  const h = 720;
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

/** A table element as a real `<table>` in the print sheet — the grid the
 *  editor draws, with the same line, fills and text. */
function tableHtml(el: SlideElement, box: string, fg: string): string {
  const grid = tableGrid(el);
  if (!grid) return "";
  const border = el.stroke ? `border:${Math.max(1, el.strokeWidth ?? 1)}px solid ${escapeAttr(el.stroke)}` : "border:none";
  const vAlign = el.verticalAlign === "middle" ? "middle" : el.verticalAlign === "bottom" ? "bottom" : "top";
  const cols = grid.colWidths.map((w) => `<col style="width:${w}%">`).join("");
  const rows = grid.rows
    .map((row, r) => {
      const cells = row
        .map((text, c) => {
          const key = cellKey(r, c);
          if (grid.covered.has(key)) return "";
          const span = grid.spans.get(key);
          const look = cellLook(el, r, grid.styles.get(key));
          const style = [
            border,
            `padding:${CELL_PAD_Y}px ${CELL_PAD_X}px`,
            `vertical-align:${vAlign}`,
            "overflow:hidden",
            "white-space:pre-wrap",
            `font-size:${look.fontSize}px`,
            `font-weight:${look.bold ? 700 : 400}`,
            `color:${escapeAttr(look.color ?? fg)}`,
            `text-align:${look.align}`,
            look.fill ? `background:${escapeAttr(look.fill)}` : "",
            el.fontFamily ? `font-family:${escapeAttr(el.fontFamily)},Inter,Arial,sans-serif` : "",
            el.lineHeight ? `line-height:${el.lineHeight}` : "",
          ]
            .filter(Boolean)
            .join(";");
          const spans = span ? ` rowspan="${span[0]}" colspan="${span[1]}"` : "";
          return `<td${spans} style="${style}">${escapeXml(text)}</td>`;
        })
        .join("");
      return `<tr style="height:${grid.rowHeights[r]}%">${cells}</tr>`;
    })
    .join("");
  return (
    `<div class="el" style="${box}"><table style="width:100%;height:100%;table-layout:fixed;border-collapse:collapse">` +
    `<colgroup>${cols}</colgroup><tbody>${rows}</tbody></table></div>`
  );
}

// --- helpers --------------------------------------------------------------------

function escapeXml(value: string): string {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

/** Escape a value destined for a double-quoted attribute (quotes included). */
function escapeAttr(value: string): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Allow only inert image URL schemes; reject javascript:/vbscript:/etc. */
function safeSrc(src: string | undefined): string {
  const s = (src ?? "").trim();
  return /^(data:image\/|https?:\/\/|\/)/i.test(s) ? s : "";
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
