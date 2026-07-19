/**
 * File → artifact importers — the inverse of `export/exporters.ts`.
 *
 * `langchain-canvas` isn't only a viewer for agent output: you can open a real
 * file and edit it on the canvas, then export it back out (round-trip). Each
 * importer maps a file to a `canvas.create` + `canvas.status: complete` event
 * pair, so an opened file flows through the exact same reconciler path an
 * agent's stream would — no special-casing downstream.
 *
 * Dependency policy mirrors the exporters: text formats (csv / md / html / json)
 * are parsed inline with zero dependencies; `.xlsx` reuses `exceljs`, loaded via
 * dynamic import so it never touches the main bundle.
 */

import type { Artifact, DocumentData, HtmlData, TableColumn, TableData } from "../protocol/artifacts";
import type { CanvasCreate, CanvasStatus, StreamEvent } from "../protocol/events";
import { loadOptional } from "../optionalImport";
import { xlsxToSheets } from "./xlsx";

/** Extensions we can turn into an artifact, for `accept="…"` and drop filtering. */
export const IMPORTABLE_EXTENSIONS = [".csv", ".md", ".markdown", ".txt", ".html", ".htm", ".json", ".xlsx"] as const;

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
};

/** True when the file has an extension we know how to import. */
export const canImport = (file: File) => (IMPORTABLE_EXTENSIONS as readonly string[]).includes(extensionOf(file.name));

const baseName = (name: string) => name.replace(/\.[^.]+$/, "");
const slug = (name: string) => baseName(name).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "file";

let importSeq = 0;
const newId = (name: string) => `imp_${slug(name)}_${Date.now().toString(36)}${importSeq++}`;

/** Wrap built artifact data into the create + complete event pair. */
function toEvents(artifact: Artifact): StreamEvent[] {
  const create: CanvasCreate = { type: "canvas.create", artifact };
  const complete: CanvasStatus = { type: "canvas.status", id: artifact.id, status: "complete" };
  return [create, complete];
}

/**
 * Parse a file into canvas events. Rejects if the extension is unsupported so
 * callers can surface a clear message. Text parsing is synchronous; `.xlsx`
 * awaits its dynamic import.
 */
export async function importFile(file: File): Promise<StreamEvent[]> {
  const ext = extensionOf(file.name);
  const id = newId(file.name);
  const title = baseName(file.name);

  switch (ext) {
    case ".csv": {
      const data = parseCsv(await file.text());
      return toEvents(artifact(id, "table", title, data));
    }
    case ".md":
    case ".markdown":
    case ".txt": {
      const data: DocumentData = { format: "markdown", content: await file.text() };
      return toEvents(artifact(id, "document", title, data));
    }
    case ".html":
    case ".htm": {
      const data: HtmlData = { html: await file.text() };
      return toEvents(artifact(id, "html", title, data));
    }
    case ".json":
      return importJson(await file.text(), id, title);
    case ".xlsx": {
      // Rich import: every sheet, with fonts/fills/formats/merges/widths, plus a
      // flat first-sheet view for export/fallback.
      const { sheets, columns, rows } = await xlsxToSheets(await file.arrayBuffer(), () => loadOptional("exceljs", () => import("exceljs")));
      return toEvents(artifact(id, "table", title, { columns, rows, sheet: sheets } satisfies TableData));
    }
    default:
      throw new Error(`Unsupported file type "${ext || file.name}". Supported: ${IMPORTABLE_EXTENSIONS.join(", ")}`);
  }
}

/** Build a complete artifact envelope around type-specific data. */
function artifact(id: string, type: Artifact["type"], title: string, data: unknown): Artifact {
  return { id, type, title, version: 1, status: "complete", data } as Artifact;
}

/** A `.json` file may be an exported artifact, a raw data payload, or arbitrary
 *  JSON — degrade gracefully, always producing *something* editable. */
function importJson(text: string, id: string, title: string): StreamEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not valid JSON — treat the raw text as a document.
    return toEvents(artifact(id, "document", title, { format: "markdown", content: text } satisfies DocumentData));
  }
  // A previously-exported artifact envelope: re-home it under a fresh id.
  if (parsed && typeof parsed === "object" && "type" in parsed && "data" in parsed) {
    const a = parsed as Artifact;
    return toEvents({ ...a, id, version: 1, status: "complete" });
  }
  // Otherwise show the JSON as a fenced markdown block.
  const content = "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
  return toEvents(artifact(id, "document", title, { format: "markdown", content } satisfies DocumentData));
}

/** RFC-4180-ish CSV parser: handles quoted fields, embedded commas, and "" escapes. */
export function parseCsv(text: string): TableData {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\n") { record.push(field); rows.push(record); field = ""; record = []; }
    else field += ch;
  }
  if (field !== "" || record.length) { record.push(field); rows.push(record); }

  const [header = [], ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  const columns = uniqueColumns(header.map((label, i) => (label.trim() || `Column ${i + 1}`)));
  const dataRows = body.map((r) => {
    const obj: Record<string, string | number> = {};
    columns.forEach((c, i) => (obj[c.key] = coerce(r[i] ?? "")));
    return obj;
  });
  return { columns, rows: dataRows };
}

/** Build columns with de-duplicated keys so same-named headers don't collide. */
function uniqueColumns(labels: string[]): TableColumn[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = seen.get(label) ?? 0;
    seen.set(label, count + 1);
    return { key: count ? `${label} (${count + 1})` : label, label };
  });
}

/**
 * Turn a cell string into a number only when it round-trips exactly — so IDs and
 * codes like "00123", "1e3", "0x10", or 20-digit numbers stay strings instead of
 * being silently mangled.
 */
function coerce(raw: string): string | number {
  const t = raw.trim();
  if (t === "") return raw;
  const n = Number(t);
  return Number.isFinite(n) && String(n) === t ? n : raw;
}

