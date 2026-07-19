/**
 * Rich `.xlsx` → Fortune-sheet import.
 *
 * The plain `{ columns, rows }` shape throws away everything that makes a real
 * spreadsheet look like one — fonts, colours, fills, number formats, merged
 * cells, column widths, and every sheet after the first. This builds Fortune's
 * native sheet model instead, preserving that detail, and *also* returns a flat
 * columns/rows view of the first sheet for export/fallback.
 *
 * `exceljs` is loaded via the caller's guarded dynamic import.
 */

import type { TableColumn, TableData } from "../protocol/artifacts";

/* eslint-disable @typescript-eslint/no-explicit-any */

type FortuneSheet = Record<string, unknown>;

// Excel's default (Office) theme palette, indexed as exceljs reports `color.theme`.
// Real spreadsheets colour most cells by theme index + tint rather than a literal
// ARGB, so resolving these is what actually brings a file's colours across.
const THEME_PALETTE = [
  "FFFFFF", "000000", "E7E6E6", "44546A", // lt1, dk1, lt2, dk2
  "4472C4", "ED7D31", "A5A5A5", "FFC000", // accent 1–4
  "5B9BD5", "70AD47", "0563C1", "954F72", // accent 5–6, hlink, followed-hlink
];

/** Apply an Excel tint (−1…1) to one 0–255 channel: <0 darkens, >0 lightens. */
function tintChannel(channel: number, tint: number): number {
  const t = tint < 0 ? channel * (1 + tint) : channel * (1 - tint) + 255 * tint;
  return Math.max(0, Math.min(255, Math.round(t)));
}

// Legacy indexed colour palette (BIFF8). Many real files still colour cells by a
// palette index rather than ARGB/theme, so without this those colours vanish.
const INDEXED_PALETTE: Record<number, string> = {
  0: "000000", 1: "FFFFFF", 2: "FF0000", 3: "00FF00", 4: "0000FF", 5: "FFFF00",
  6: "FF00FF", 7: "00FFFF", 8: "000000", 9: "FFFFFF", 10: "FF0000", 11: "00FF00",
  12: "0000FF", 13: "FFFF00", 14: "FF00FF", 15: "00FFFF", 16: "800000", 17: "008000",
  18: "000080", 19: "808000", 20: "800080", 21: "008080", 22: "C0C0C0", 23: "808080",
  24: "9999FF", 25: "993366", 26: "FFFFCC", 27: "CCFFFF", 28: "660066", 29: "FF8080",
  30: "0066CC", 31: "CCCCFF", 32: "000080", 33: "FF00FF", 34: "FFFF00", 35: "00FFFF",
  36: "800080", 37: "800000", 38: "008080", 39: "0000FF", 40: "00CCFF", 41: "CCFFFF",
  42: "CCFFCC", 43: "FFFF99", 44: "99CCFF", 45: "FF99CC", 46: "CC99FF", 47: "FFCC99",
  48: "3366FF", 49: "33CCCC", 50: "99CC00", 51: "FFCC00", 52: "FF9900", 53: "FF6600",
  54: "666699", 55: "969696", 56: "003366", 57: "339966", 58: "003300", 59: "333300",
  60: "993300", 61: "993366", 62: "333399", 63: "333333",
};

/** exceljs colour (ARGB, theme index + tint, or legacy indexed) → CSS "#RRGGBB". */
function toHex(color: any): string | undefined {
  if (!color || typeof color !== "object") return undefined;
  let hex: string | undefined;
  if (typeof color.argb === "string") {
    hex = color.argb.length === 8 ? color.argb.slice(2) : color.argb;
  } else if (typeof color.theme === "number") {
    hex = THEME_PALETTE[color.theme];
  } else if (typeof color.indexed === "number") {
    hex = INDEXED_PALETTE[color.indexed]; // 64/65 (system auto) intentionally absent
  }
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const tint = typeof color.tint === "number" ? color.tint : 0;
  if (tint) {
    const n = parseInt(hex, 16);
    const r = tintChannel((n >> 16) & 255, tint);
    const g = tintChannel((n >> 8) & 255, tint);
    const b = tintChannel(n & 255, tint);
    hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
  }
  return `#${hex}`;
}

const H_ALIGN: Record<string, number> = { center: 0, left: 1, right: 2 };
const V_ALIGN: Record<string, number> = { middle: 0, top: 1, bottom: 2 };

// exceljs border style name → Fortune-sheet border style number.
const BORDER_STYLE: Record<string, number> = {
  hair: 2, thin: 1, dotted: 3, dashDot: 5, dashDotDot: 6, dashed: 4,
  mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, slantDashDot: 12,
  medium: 8, double: 7, thick: 13,
};

/** One border side ({style,color}) in Fortune's shape, or undefined if none. */
function borderSide(side: any): { style: number; color: string } | undefined {
  if (!side || !side.style) return undefined;
  return { style: BORDER_STYLE[side.style] ?? 1, color: toHex(side.color) ?? "#000000" };
}

/** Display text for a value (formulas resolve to their cached result). */
function display(value: any): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.result != null) return display(value.result);
    if (typeof value.text === "string") return value.text;
    if (value instanceof Date) return formatDate(value, "yyyy-mm-dd");
    return "";
  }
  return String(value);
}

/** Render a number the way its Excel number format would — thousands separators,
 *  fixed decimals, percent, and a leading currency symbol. Not a full format
 *  engine, but it covers the everyday patterns so cells read like the source
 *  ("1,234.50", "15.6%", "$1,000") instead of a bare "1234.5". */
function formatNumber(value: number, numFmt?: string): string {
  const fmt = numFmt && numFmt !== "General" ? numFmt : "";
  if (!fmt) return String(value);
  const decimals = (fmt.match(/\.([0#]+)/)?.[1] ?? "").length;
  if (fmt.includes("%")) return `${(value * 100).toFixed(decimals)}%`;
  const thousands = /[#0],[#0]/.test(fmt);
  let out = thousands
    ? value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : value.toFixed(decimals);
  const currency = fmt.match(/[$₩€£¥]/);
  if (currency) out = value < 0 ? `-${currency[0]}${out.slice(1)}` : `${currency[0]}${out}`;
  return out;
}

/** Format a Date by an Excel date pattern (yyyy/yy, mm/m, dd/d, hh/h, ss). Uses
 *  local parts so it matches the calendar day the author saw. Non-token text
 *  (e.g. Korean 년/월/일) passes through untouched. */
function formatDate(d: Date, numFmt?: string): string {
  const fmt = numFmt && numFmt !== "General" && /[ymdhs]/i.test(numFmt) ? numFmt : "yyyy-mm-dd";
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()), yy: p(d.getFullYear() % 100),
    mmmm: d.toLocaleString("en-US", { month: "long" }), mmm: d.toLocaleString("en-US", { month: "short" }),
    mm: p(d.getMonth() + 1), m: String(d.getMonth() + 1),
    dd: p(d.getDate()), d: String(d.getDate()),
    hh: p(d.getHours()), h: String(d.getHours()),
    ss: p(d.getSeconds()),
  };
  // Longest tokens first so "yyyy" wins over "yy", "mmmm" over "mm", etc.
  return fmt.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d|hh|h|ss/g, (t) => map[t] ?? t);
}

/** Build a Fortune cell `v` object from an exceljs cell, carrying its style.
 *  Merges are handled by the caller, so this reads only the cell's own value. */
function cellValue(cell: any): Record<string, unknown> | null {
  const raw = cell.value;
  const effective = raw;
  const m = display(effective);
  const isFormula = raw && typeof raw === "object" && "formula" in raw;
  const hasStyle = cell.font || cell.fill?.type === "pattern" || cell.alignment;
  if (m === "" && !isFormula && !hasStyle) return null;

  const v: Record<string, unknown> = { m };
  if (isFormula) {
    v.f = `=${raw.formula}`;
    v.v = display(raw.result);
    if (typeof raw.result === "number") v.m = formatNumber(raw.result, cell.numFmt);
  } else if (typeof effective === "number") {
    v.v = effective;
    v.m = formatNumber(effective, cell.numFmt); // show "1,234.50"/"15.6%"/"$1,000", not "1234.5"
    v.ct = { fa: cell.numFmt || "General", t: "n" };
  } else if (effective instanceof Date) {
    v.m = formatDate(effective, cell.numFmt);
    v.v = v.m;
    v.ct = { fa: cell.numFmt || "yyyy-mm-dd", t: "d" };
  } else {
    v.v = m;
  }

  const font = cell.font;
  if (font?.bold) v.bl = 1;
  if (font?.italic) v.it = 1;
  if (font?.underline) v.un = 1;
  if (font?.size) v.fs = font.size;
  if (font?.name) v.ff = font.name;
  const fc = toHex(font?.color);
  if (fc) v.fc = fc;

  // Solid fill → background colour. The fill colour lives in `fgColor`; some
  // writers only populate `bgColor`, so fall back to it.
  if (cell.fill?.type === "pattern" && cell.fill.pattern === "solid") {
    const bg = toHex(cell.fill.fgColor) ?? toHex(cell.fill.bgColor);
    if (bg) v.bg = bg;
  }
  const ha = cell.alignment?.horizontal;
  if (ha && ha in H_ALIGN) v.ht = H_ALIGN[ha];
  const va = cell.alignment?.vertical;
  if (va && va in V_ALIGN) v.vt = V_ALIGN[va];
  if (cell.alignment?.wrapText) v.tb = "2"; // Fortune: 2 = wrap text

  return v;
}

/** Parse a merge range ("A1:C2") into Fortune's `{r,c,rs,cs}` (0-based). */
function parseMerge(range: string): { key: string; entry: { r: number; c: number; rs: number; cs: number } } | null {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!m) return null;
  const col = (s: string) => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const r1 = Number(m[2]) - 1, c1 = col(m[1]);
  const r2 = Number(m[4]) - 1, c2 = col(m[3]);
  const r = Math.min(r1, r2), c = Math.min(c1, c2);
  return { key: `${r}_${c}`, entry: { r, c, rs: Math.abs(r2 - r1) + 1, cs: Math.abs(c2 - c1) + 1 } };
}

export interface RichXlsx {
  sheets: FortuneSheet[];
  columns: TableColumn[];
  rows: TableData["rows"];
}

/** Convert an .xlsx buffer to Fortune sheets (rich) + a flat first-sheet view. */
export async function xlsxToSheets(buffer: ArrayBuffer, load: () => Promise<any>): Promise<RichXlsx> {
  const ExcelJS = await load();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheets: FortuneSheet[] = [];
  wb.worksheets.forEach((ws: any, index: number) => {
    const colCount = Math.max(ws.columnCount || 0, ws.actualColumnCount || 0);
    const rowCount = Math.max(ws.rowCount || 0, ws.actualRowCount || 0);

    // Merges first — Fortune needs both a `config.merge` entry and per-cell `mc`
    // markers: the master carries the value + span, the covered cells only point
    // back to it (no value), so the content shows once across the span.
    const merge: Record<string, { r: number; c: number; rs: number; cs: number }> = {};
    const master = new Map<string, { r: number; c: number }>(); // covered cell → master
    for (const range of ws.model?.merges ?? []) {
      const parsed = parseMerge(range);
      if (!parsed) continue;
      const { r, c, rs, cs } = parsed.entry;
      merge[parsed.key] = parsed.entry;
      for (let rr = r; rr < r + rs; rr++) {
        for (let cc = c; cc < c + cs; cc++) {
          if (rr !== r || cc !== c) master.set(`${rr}_${cc}`, { r, c });
        }
      }
    }

    const celldata: Array<Record<string, unknown>> = [];
    const borderInfo: Array<Record<string, unknown>> = [];
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        // Borders are captured for every cell (merged ones too — a box's edges live
        // on its outer cells) so the grid's rules match the source exactly.
        const b = cell.border;
        if (b) {
          const l = borderSide(b.left), rt = borderSide(b.right), t = borderSide(b.top), bt = borderSide(b.bottom);
          if (l || rt || t || bt) {
            const value: Record<string, unknown> = { row_index: r - 1, col_index: c - 1 };
            if (l) value.l = l;
            if (rt) value.r = rt;
            if (t) value.t = t;
            if (bt) value.b = bt;
            borderInfo.push({ rangeType: "cell", value });
          }
        }

        const key = `${r - 1}_${c - 1}`;
        const cover = master.get(key);
        if (cover) {
          celldata.push({ r: r - 1, c: c - 1, v: { mc: { r: cover.r, c: cover.c } } });
          continue;
        }
        const v = cellValue(cell);
        if (v) {
          if (merge[key]) v.mc = merge[key]; // this cell is a merge master
          celldata.push({ r: r - 1, c: c - 1, v });
        }
      }
    }

    // Auto-fit each column to its widest cell so short content isn't padded out
    // to wide empty columns (which made the grid feel too wide and left–right
    // scrolling awkward). A stored column width is honoured as a floor. Merged
    // cells span several columns, so they don't size any single one.
    const colChars: Record<number, number> = {};
    for (const cell of celldata) {
      const v = cell.v as Record<string, unknown>;
      if (v.mc) continue;
      const len = typeof v.m === "string" ? v.m.length : 0;
      const c = cell.c as number;
      if (len > (colChars[c] ?? 0)) colChars[c] = len;
    }
    const columnlen: Record<number, number> = {};
    for (let c = 0; c < colCount; c++) {
      const stored = ws.getColumn(c + 1)?.width;
      const px = Math.max(colChars[c] ? colChars[c] * 8 + 20 : 0, stored ? stored * 7 + 5 : 0);
      if (px) columnlen[c] = Math.max(56, Math.min(320, Math.round(px)));
    }
    const rowlen: Record<number, number> = {};
    for (let r = 1; r <= rowCount; r++) {
      const h = ws.getRow(r)?.height;
      if (h) rowlen[r - 1] = Math.round(h * 1.33); // points → px
    }

    sheets.push({
      name: ws.name || `Sheet${index + 1}`,
      id: `sheet_${index}`,
      order: index,
      status: index === 0 ? 1 : 0,
      // Size the grid to the data plus a small buffer — enough to feel like a real
      // sheet, tight enough that the scrollbars stay proportional and there aren't
      // rows/columns of empty grid to scroll past.
      row: Math.max(rowCount + 8, 24),
      column: Math.max(colCount + 2, 10),
      celldata,
      config: { merge, columnlen, rowlen, borderInfo },
    });
  });

  // Flat view of the first sheet for export/fallback.
  const { columns, rows } = flatten(wb.worksheets[0]);
  return { sheets, columns, rows };
}

/** A cell's value with its type preserved (numbers stay numbers). */
function cellVal(v: any): string | number {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "object") {
    if (v.result != null) return cellVal(v.result);
    if (typeof v.text === "string") return v.text;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

/** First-sheet columns/rows (values only, types preserved), read through merges. */
function flatten(ws: any): { columns: TableColumn[]; rows: TableData["rows"] } {
  if (!ws) return { columns: [], rows: [] };
  const colCount = Math.max(ws.columnCount || 0, ws.actualColumnCount || 0);
  const rowCount = Math.max(ws.rowCount || 0, ws.actualRowCount || 0);
  const letter = (n: number) => { let s = ""; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
  const read = (cell: any): string | number => cellVal(cell.value != null ? cell.value : cell.master?.value ?? null);

  const header = ws.getRow(1);
  const seen = new Map<string, number>();
  const columns: TableColumn[] = [];
  for (let c = 1; c <= colCount; c++) {
    let label = String(read(header.getCell(c))).trim() || letter(c);
    const count = seen.get(label) ?? 0;
    seen.set(label, count + 1);
    columns.push({ key: count ? `${label} (${count + 1})` : label, label });
  }
  const rows: TableData["rows"] = [];
  for (let r = 2; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, string | number> = {};
    let has = false;
    for (let c = 1; c <= colCount; c++) {
      const v = read(row.getCell(c));
      obj[columns[c - 1].key] = v;
      if (v !== "") has = true;
    }
    if (has) rows.push(obj);
  }
  return { columns, rows };
}
