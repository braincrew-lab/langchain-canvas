/**
 * Artifact → file exporters.
 *
 * Two kinds of export:
 *
 * 1. **HTML** (`toStandaloneHtml`) — wrap the *rendered* DOM of any artifact into
 *    a self-contained `.html` document with inlined styles.
 * 2. **Data exporters** (`dataExporters`) — deterministic, per-type conversions
 *    straight from `artifact.data`: markdown `.md`, table `.csv`/`.xlsx`,
 *    document `.docx`, slides `.pptx`, raw `.json`.
 *
 * Office formats (xlsx / docx / pptx) are produced with `exceljs` / `docx` /
 * `pptxgenjs`, loaded via **dynamic import** so they never touch the main
 * bundle — only the code path a user actually clicks pulls them in.
 */

import type { Artifact, DocumentData, SlidesData, TableData } from "../protocol/artifacts";
import { resolveElements } from "../client/slideElements";
import { loadOptional } from "../optionalImport";

export interface FileExport {
  /** Menu label, e.g. "Excel". */
  label: string;
  /** File extension without the dot, e.g. "xlsx". */
  extension: string;
  mime: string;
  /** Build the file contents (text or binary; may be async for Office formats). */
  build: (artifact: Artifact) => BlobPart | Promise<BlobPart>;
}

const MIME = {
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

/** Per-type data exporters, keyed by `artifact.type`. */
export const dataExporters: Record<string, FileExport[]> = {
  document: [
    { label: "Markdown", extension: "md", mime: MIME.md, build: (a) => (a.data as DocumentData).content },
    { label: "Word", extension: "docx", mime: MIME.docx, build: (a) => documentToDocx(a.data as DocumentData) },
  ],
  table: [
    { label: "CSV", extension: "csv", mime: MIME.csv, build: (a) => tableToCsv(a.data as TableData) },
    { label: "Excel", extension: "xlsx", mime: MIME.xlsx, build: (a) => tableToXlsx(a.data as TableData) },
  ],
  chart: [
    { label: "JSON", extension: "json", mime: MIME.json, build: (a) => JSON.stringify(a.data, null, 2) },
  ],
  slides: [
    { label: "PowerPoint", extension: "pptx", mime: MIME.pptx, build: (a) => slidesToPptx(a.data as SlidesData, a.title) },
    { label: "Figma (JSON)", extension: "json", mime: MIME.json, build: (a) => slidesToFigmaJson(a.data as SlidesData) },
  ],
};

/** Wrap already-rendered inner HTML into a standalone, styled `.html` document. */
export function toStandaloneHtml(title: string, renderedHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<main class="export">
${renderedHtml}
</main>
</body>
</html>`;
}

// --- table → csv / xlsx ---------------------------------------------------------

function tableToCsv(data: TableData): string {
  const header = data.columns.map((c) => csvCell(c.label ?? c.key)).join(",");
  const body = data.rows
    .map((row) => data.columns.map((c) => csvCell(String(row[c.key] ?? ""))).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

async function tableToXlsx(data: TableData): Promise<BlobPart> {
  const { Workbook } = await loadOptional("exceljs", () => import("exceljs"));
  const workbook = new Workbook();

  if (data.sheet?.length) {
    // Prefer the edited Fortune-sheet state — carries merges, fonts, formats.
    fortuneToWorkbook(workbook, data.sheet);
  } else {
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(data.columns.map((c) => c.label ?? c.key));
    for (const row of data.rows) sheet.addRow(data.columns.map((c) => row[c.key] ?? ""));
    sheet.getRow(1).font = { bold: true };
  }
  return workbook.xlsx.writeBuffer();
}

/** Map Fortune-sheet sheets → an ExcelJS workbook (values, fonts, fills, merges). */
function fortuneToWorkbook(workbook: any, sheets: Array<Record<string, any>>): void {
  const align = ["center", "left", "right"] as const;
  for (const s of sheets) {
    const ws = workbook.addWorksheet(String(s.name ?? "Sheet1"));
    for (const cell of (s.celldata as any[]) ?? []) {
      const v = cell.v;
      const value = v && typeof v === "object" ? v.v ?? v.m ?? null : v;
      const xc = ws.getCell(cell.r + 1, cell.c + 1);
      xc.value = value;
      if (v && typeof v === "object") {
        if (v.bl) xc.font = { ...xc.font, bold: true };
        if (v.it) xc.font = { ...xc.font, italic: true };
        if (v.fc) xc.font = { ...xc.font, color: { argb: hexToArgb(v.fc) } };
        if (v.bg) xc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: hexToArgb(v.bg) } };
        if (typeof v.ht === "number" && align[v.ht]) xc.alignment = { ...xc.alignment, horizontal: align[v.ht] };
      }
    }
    const merge = (s.config as any)?.merge ?? {};
    for (const key of Object.keys(merge)) {
      const m = merge[key];
      try {
        ws.mergeCells(m.r + 1, m.c + 1, m.r + m.rs, m.c + m.cs);
      } catch {
        /* ignore overlapping/invalid merge ranges */
      }
    }
  }
}

function hexToArgb(hex: string): string {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return ("FF" + full).toUpperCase();
}

// --- document (markdown) → docx -------------------------------------------------

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

// --- slides → pptx --------------------------------------------------------------

async function slidesToPptx(data: SlidesData, _title: string): Promise<BlobPart> {
  const PptxGenJS = (await loadOptional("pptxgenjs", () => import("pptxgenjs"))).default;
  const pptx = new PptxGenJS();

  const W = 10;
  const H = 5.625;
  for (const slide of data.slides) {
    const s = pptx.addSlide();
    if (slide.background) s.background = { color: slide.background.replace("#", "") };
    const tc = slide.textColor ? slide.textColor.replace("#", "") : undefined;

    for (const el of resolveElements(slide)) {
      const box = { x: (el.x / 100) * W, y: (el.y / 100) * H, w: (el.w / 100) * W, h: (el.h / 100) * H };
      if (el.type === "text") {
        const color = el.color ? el.color.replace("#", "") : tc;
        s.addText(el.text ?? "", { ...box, fontSize: (el.fontSize ?? 24) * 0.75, bold: !!el.bold, align: el.align ?? "left", ...(color ? { color } : {}) });
      } else if (el.src) {
        s.addImage({ data: el.src, ...box, sizing: { type: "contain", w: box.w, h: box.h } });
      }
    }

    if (slide.notes) s.addNotes(slide.notes);
  }

  return (await pptx.write({ outputType: "blob" })) as Blob;
}

/**
 * Slides → a Figma-plugin-friendly deck JSON: a flat list of frames (one 16:9
 * slide each, stacked) holding text nodes with hex colors and pixel geometry.
 * The companion Figma plugin (`packages/figma-plugin`) maps each entry directly
 * onto real `figma.createFrame()` / `figma.createText()` nodes — so slides land
 * as native, editable Figma frames (not a flattened image).
 */
function slidesToFigmaJson(data: SlidesData): string {
  const W = 1280;
  const H = 720;
  const GAP = 64;
  const slides = data.slides.length ? data.slides : [{ title: "Empty deck" }];

  const textNode = (
    x: number,
    y: number,
    width: number,
    characters: string,
    fontSize: number,
    fontWeight: number,
    align: "LEFT" | "CENTER",
    color = "#1F2328",
  ) => ({ type: "text", x, y, width, characters, fontSize, fontWeight, align, color });

  const frames = slides.map((slide, i) => {
    const nodes: object[] = [];
    for (const el of resolveElements(slide)) {
      if (el.type !== "text") continue;
      nodes.push(
        textNode((el.x / 100) * W, (el.y / 100) * H, (el.w / 100) * W, el.text ?? "", el.fontSize ?? 24, el.bold ? 700 : 400, el.align === "center" ? "CENTER" : "LEFT", el.color ?? slide.textColor ?? "#1F2328"),
      );
    }
    return { name: `Slide ${i + 1}`, x: 0, y: i * (H + GAP), width: W, height: H, fill: slide.background ?? "#FFFFFF", nodes };
  });

  return JSON.stringify({ type: "langchain-canvas/figma-deck", version: 1, frames }, null, 2);
}

/**
 * Slides → a single SVG (one 16:9 frame per slide, stacked). Paste this SVG into
 * Figma and it becomes editable frames + text (Figma parses SVG from the
 * clipboard). Used by the "Copy to Figma" action.
 */
export function slidesToSvg(data: SlidesData): string {
  const W = 1280;
  const H = 720;
  const GAP = 64;
  const slides = data.slides.length ? data.slides : [{ title: "Empty deck" }];
  const totalH = slides.length * H + (slides.length - 1) * GAP;

  const text = (
    x: number,
    y: number,
    value: string,
    size: number,
    anchor: "start" | "middle" | "end",
    weight: number,
    fill = "#1f2328",
  ) =>
    `<text x="${x}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="${size}" ` +
    `font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${escapeXml(value)}</text>`;

  const frames = slides
    .map((slide, i) => {
      const y = i * (H + GAP);
      const bg = slide.background ?? "#ffffff";
      let body = `<rect width="${W}" height="${H}" rx="8" fill="${bg}" stroke="#e5e7eb"/>`;
      for (const el of resolveElements(slide)) {
        const ex = (el.x / 100) * W;
        const ey = (el.y / 100) * H;
        const ew = (el.w / 100) * W;
        if (el.type === "text") {
          const anchor = el.align === "center" ? "middle" : el.align === "right" ? "end" : "start";
          const ax = el.align === "center" ? ex + ew / 2 : el.align === "right" ? ex + ew : ex;
          const fs = el.fontSize ?? 24;
          body += text(ax, ey + fs, el.text ?? "", fs, anchor, el.bold ? 700 : 400, el.color ?? slide.textColor ?? "#1f2328");
        } else if (el.src) {
          body += `<image href="${el.src}" x="${ex}" y="${ey}" width="${ew}" height="${(el.h / 100) * H}" preserveAspectRatio="xMidYMid meet"/>`;
        }
      }
      return `<g transform="translate(0 ${y})">${body}</g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">${frames}</svg>`;
}

/**
 * A print-ready HTML document with one landscape page per slide — fed to the
 * browser's print pipeline to produce a multi-page PDF. Elements keep their
 * percentage geometry, so pages match the on-canvas layout exactly.
 */
export function slidesToPrintHtml(data: SlidesData, title: string): string {
  const slides = data.slides.length ? data.slides : [{ title: "Empty deck" }];
  const pages = slides
    .map((slide) => {
      const bg = slide.background ?? "#ffffff";
      const fg = slide.textColor ?? "#1f2328";
      const els = resolveElements(slide)
        .map((el) => {
          const box = `left:${el.x}%;top:${el.y}%;width:${el.w}%;height:${el.h}%`;
          if (el.type === "text") {
            // box is numeric; color/align are escaped individually — the composed
            // style string is then safe to place in the attribute as-is.
            const style = `${box};font-size:${(el.fontSize ?? 24) / 7.2}vw;font-weight:${el.bold ? 700 : 400};color:${escapeAttr(el.color ?? fg)};text-align:${escapeAttr(el.align ?? "left")}`;
            return `<div class="el" style="${style}">${escapeXml(el.text ?? "")}</div>`;
          }
          const src = safeSrc(el.src);
          return src ? `<img class="el" style="${box}" src="${escapeAttr(src)}"/>` : "";
        })
        .join("");
      return `<section class="slide" style="background:${escapeAttr(bg)}">${els}</section>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>
    @page { size: 1280px 720px; margin: 0; }
    * { margin: 0; box-sizing: border-box; }
    body { font-family: Inter, Arial, sans-serif; }
    .slide { position: relative; width: 1280px; height: 720px; overflow: hidden; page-break-after: always; }
    .el { position: absolute; overflow: hidden; line-height: 1.25; }
    img.el { object-fit: contain; }
  </style></head><body>${pages}</body></html>`;
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
