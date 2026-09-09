/**
 * The markdown subset the Word door writes — the twin of
 * `canvas-py/src/langchain_canvas/exporters.py::_markdown_blocks` and its
 * helpers (`_md_runs`, `_md_depth`, `_join_soft_lines`, `_md_cells`,
 * `_md_is_separator`, `_md_aligns`, `_decode_data_uri`), held to
 * `markdownBlocks.golden.json` for the shared fixture so the browser's `.docx`
 * carries the same blocks as the Python one (plan §U5).
 *
 * Headings, paragraphs with inline bold / italic / strike / code (a line
 * ending in two spaces keeps a line break), bullet and numbered items up to
 * three levels deep, block quotes, pipe tables with the same inline marks in
 * their cells and `:---:` / `---:` alignment, fenced code, thematic breaks and
 * `data:` images. A link stays literal text, as it does on the Python side.
 */

export interface MdRun {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
}

export interface MdCell {
  runs: MdRun[];
  align: "center" | "right" | null;
}

export type MdBlock =
  | ["heading", number, MdRun[]]
  | ["para", MdRun[]]
  | ["bullet", MdRun[], number]
  | ["numbered", MdRun[], number]
  | ["quote", MdRun[]]
  | ["code", string]
  | ["table", MdCell[][], boolean]
  | ["rule"]
  | ["image", string];

// The same patterns as the Python twin, character for character.
const MD_INLINE = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|___[^_]+___|__[^_]+__|_[^_]+_|~~[^~]+~~|`[^`]+`)/;
const MD_IMAGE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const MD_NUMBERED = /^\s*\d+[.)]\s+/;
const MD_BULLET = /^\s*[-*+]\s+/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function run(text: string, bold = false, italic = false, strike = false, code = false): MdRun {
  return { text, bold, italic, strike, code };
}

/** Inline markdown as runs: bold, italic, bold-italic, strikethrough and
 *  code (a monospace run without its ticks). */
export function mdRuns(text: string): MdRun[] {
  const runs: MdRun[] = [];
  for (const part of text.split(MD_INLINE)) {
    if (!part) continue;
    if (part.startsWith("***") && part.endsWith("***") && part.length > 6) runs.push(run(part.slice(3, -3), true, true));
    else if (part.startsWith("___") && part.endsWith("___") && part.length > 6) runs.push(run(part.slice(3, -3), true, true));
    else if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4) runs.push(run(part.slice(2, -2), false, false, true));
    else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) runs.push(run(part.slice(2, -2), true));
    else if (part.startsWith("__") && part.endsWith("__") && part.length > 4) runs.push(run(part.slice(2, -2), true));
    else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) runs.push(run(part.slice(1, -1), false, true));
    else if (part.startsWith("_") && part.endsWith("_") && part.length > 2) runs.push(run(part.slice(1, -1), false, true));
    else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) runs.push(run(part.slice(1, -1), false, false, false, true));
    else runs.push(run(part));
  }
  return runs;
}

/** List nesting from leading spaces: 0, 1 or 2 (two spaces per level). */
function mdDepth(line: string): number {
  return Math.min(2, Math.floor((line.length - line.replace(/^ +/, "").length) / 2));
}

/** One paragraph from its source lines: a line that ends in two spaces keeps
 *  a line break; the rest wrap into one line. */
function joinSoftLines(lines: string[]): string {
  let out = "";
  lines.forEach((raw, index) => {
    const piece = raw.trim();
    if (index) out += lines[index - 1].endsWith("  ") ? "\n" : " ";
    out += piece;
  });
  return out;
}

function mdCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|+|\|+$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function mdIsSeparator(line: string): boolean {
  const body = line.trim().replace(/^\|+|\|+$/g, "").replaceAll("|", "").replaceAll(" ", "");
  return body.length > 0 && /^[-:]+$/.test(body) && body.includes("-");
}

/** Per-column alignment from the separator row — `:---:` centres, `---:`
 *  right-aligns, the rest keep Word's default. */
function mdAligns(separator: string): ("center" | "right" | null)[] {
  return mdCells(separator).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : null;
  });
}

/** The base64 payload of a `data:...;base64,` URI, canonicalised, or null when
 *  the URI is not one or the payload is not valid base64 (the Python twin's
 *  strict decode). */
function decodeDataUri(url: string): string | null {
  const marker = ";base64,";
  if (!url.startsWith("data:") || !url.includes(marker)) return null;
  const payload = url.slice(url.indexOf(marker) + marker.length);
  if (!BASE64.test(payload) || payload.length % 4 !== 0) return null;
  try {
    return btoa(atob(payload));
  } catch {
    return null;
  }
}

/** A deliberate markdown subset as export blocks — the Python twin's rules. */
export function markdownBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const paragraph: string[] = [];
  const lines = text.split("\n");
  const flush = () => {
    if (paragraph.length) {
      blocks.push(["para", mdRuns(joinSoftLines(paragraph))]);
      paragraph.length = 0;
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const stripped = line.trim();
    if (!stripped) {
      flush();
      index += 1;
      continue;
    }
    if (stripped.startsWith("```")) {
      flush();
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(["code", code.join("\n")]);
      continue;
    }
    if (stripped.startsWith("#")) {
      flush();
      const level = stripped.length - stripped.replace(/^#+/, "").length;
      blocks.push(["heading", level, mdRuns(stripped.slice(level).trim())]);
      index += 1;
      continue;
    }
    if (stripped === "---" || stripped === "***" || stripped === "___") {
      flush();
      blocks.push(["rule"]);
      index += 1;
      continue;
    }
    const image = MD_IMAGE.exec(stripped);
    if (image) {
      flush();
      const data = decodeDataUri(image[2]);
      if (data !== null) blocks.push(["image", data]);
      else if (image[1]) blocks.push(["para", [run(image[1])]]);
      else if (/^data:image\//i.test(image[2])) throw new Error("DOCX image: unsupported or invalid data URI");
      index += 1;
      continue;
    }
    if (stripped.startsWith("|") && index + 1 < lines.length && mdIsSeparator(lines[index + 1])) {
      flush();
      const aligns = mdAligns(lines[index + 1]);
      const rows = [mdCells(stripped)];
      index += 2; // past the separator line
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(mdCells(lines[index]));
        index += 1;
      }
      blocks.push([
        "table",
        rows.map((row) => row.map((cell, i) => ({ runs: mdRuns(cell), align: i < aligns.length ? aligns[i] : null }))),
        true,
      ]);
      continue;
    }
    if (MD_BULLET.test(line)) {
      flush();
      blocks.push(["bullet", mdRuns(line.replace(MD_BULLET, "")), mdDepth(line)]);
      index += 1;
      continue;
    }
    if (MD_NUMBERED.test(line)) {
      flush();
      blocks.push(["numbered", mdRuns(line.replace(MD_NUMBERED, "")), mdDepth(line)]);
      index += 1;
      continue;
    }
    if (stripped.startsWith(">")) {
      flush();
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>+/, "").trim());
        index += 1;
      }
      blocks.push(["quote", mdRuns(joinSoftLines(quote))]);
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flush();
  return blocks;
}
