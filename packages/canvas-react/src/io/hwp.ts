/**
 * Zero-dependency `.hwp` (HWP 5.x) → plain-text extractor.
 *
 * Binary HWP files are an MS Compound File Binary (CFB / OLE) container holding
 * a tiny `FileHeader` stream plus one record stream per section under
 * `BodyText/Section0…N`. Nothing on npm parses this without dragging in a
 * full office suite, and the importer dependency policy is "text formats are
 * parsed inline", so the whole chain — CFB (FAT, mini-FAT, directory), the
 * HWP file header, raw-deflate decompression, and the tagged record stream —
 * is implemented here from the published HWP 5.0 spec.
 *
 * Scope is deliberately pragmatic: every `HWPTAG_PARA_TEXT` record becomes one
 * paragraph, except that table controls (`CTRL_HEADER` with ctrl id "tbl ")
 * are recognized and their cell paragraphs re-assembled into GFM tables — any
 * structural surprise falls back to emitting the cells as plain paragraphs so
 * text is never dropped. Encrypted, distribution (DRM), and pre-5.0 documents
 * are rejected with bilingual (한국어 / English) errors so the UI can surface
 * them to Korean users directly.
 */

/* ------------------------------------------------------------------------- *
 * Error messages — bilingual so they can be shown to end users as-is.
 * ------------------------------------------------------------------------- */

const ERR = {
  notCfb:
    "CFB(OLE) 컨테이너 형식이 아닙니다 — 올바른 HWP 파일이 아닙니다. / Not a CFB (OLE) compound file container — not a valid HWP file.",
  notHwp:
    "\"HWP Document File\" 시그니처가 없습니다 — HWP 문서가 아닙니다. / Missing \"HWP Document File\" signature — not an HWP document.",
  encrypted:
    "암호로 보호된 HWP 문서입니다 — 한글에서 암호를 해제한 뒤 다시 시도하세요. / This HWP document is password-encrypted — remove the password in Hangul and try again.",
  drm:
    "배포용(DRM) HWP 문서입니다 — 본문이 난독화되어 있어 텍스트를 추출할 수 없습니다. / This is a distribution (DRM) HWP document — its body text is obfuscated and cannot be extracted.",
  legacy: (version: string) =>
    `지원하지 않는 HWP 버전입니다 (${version} < 5.0) — 한글에서 HWP 5.0 이상으로 저장한 뒤 다시 시도하세요. / Unsupported HWP version (${version} < 5.0) — re-save as HWP 5.0+ in Hangul and try again.`,
  corrupt: (detail: string) =>
    `손상된 HWP 파일입니다 (${detail}). / Corrupt HWP file (${detail}).`,
  noInflate:
    "이 환경에서는 DecompressionStream을 지원하지 않아 압축된 HWP를 열 수 없습니다. / DecompressionStream is unavailable in this environment, so compressed HWP files cannot be opened.",
} as const;

/* ------------------------------------------------------------------------- *
 * CFB (Compound File Binary) container
 * ------------------------------------------------------------------------- */

// Special FAT sector values ([MS-CFB] 2.1). Everything else is a "next sector"
// pointer, which is what lets us walk a stream's sector chain.
const ENDOFCHAIN = 0xfffffffe;

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface CfbEntry {
  name: string;
  /** 1 = storage (folder), 2 = stream, 5 = root. */
  type: number;
  startSector: number;
  size: number;
}

interface CfbFile {
  entries: CfbEntry[];
  /** Read a stream entry's bytes, transparently routing small streams to the mini stream. */
  readStream(entry: CfbEntry): Uint8Array;
}

/**
 * Parse the CFB container. Every chain walk is capped at the total sector
 * count so a corrupt (or malicious) FAT with a cycle can never hang the UI —
 * it throws a "corrupt" error instead.
 */
function parseCfb(bytes: Uint8Array): CfbFile {
  if (bytes.length < 512 || CFB_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error(ERR.notCfb);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sectorSize = 1 << view.getUint16(30, true); // usually 512
  const miniSectorSize = 1 << view.getUint16(32, true); // usually 64
  const numFatSectors = view.getUint32(44, true);
  const firstDirSector = view.getUint32(48, true);
  const miniCutoff = view.getUint32(56, true); // streams below this live in the mini stream
  const firstMiniFatSector = view.getUint32(60, true);
  const firstDifatSector = view.getUint32(68, true);

  // Sector 0 starts right after the 512-byte header (even when sectors are 4096).
  const totalSectors = Math.max(0, Math.ceil((bytes.length - 512) / sectorSize));
  const sectorBytes = (sector: number): Uint8Array => {
    const start = 512 + sector * sectorSize;
    if (sector >= totalSectors || start >= bytes.length) {
      throw new Error(ERR.corrupt("sector out of range"));
    }
    return bytes.subarray(start, start + sectorSize);
  };

  // --- DIFAT → FAT. The first 109 FAT-sector pointers are in the header; huge
  // files chain extra DIFAT sectors (last uint32 of each points to the next).
  const fatSectorIds: number[] = [];
  for (let i = 0; i < 109 && fatSectorIds.length < numFatSectors; i++) {
    fatSectorIds.push(view.getUint32(76 + i * 4, true));
  }
  let difatSector = firstDifatSector;
  let difatHops = 0;
  while (difatSector !== ENDOFCHAIN && difatSector < 0xfffffffa) {
    if (difatHops++ > totalSectors) throw new Error(ERR.corrupt("DIFAT chain loops"));
    const s = sectorBytes(difatSector);
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector && fatSectorIds.length < numFatSectors; i++) {
      fatSectorIds.push(sv.getUint32(i * 4, true));
    }
    difatSector = sv.getUint32(sectorSize - 4, true);
  }

  // Flatten the FAT into one array: fat[sector] = next sector in the chain.
  const fat = new Uint32Array(fatSectorIds.length * (sectorSize / 4));
  fatSectorIds.forEach((id, idx) => {
    const s = sectorBytes(id);
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < sectorSize / 4; i++) fat[idx * (sectorSize / 4) + i] = sv.getUint32(i * 4, true);
  });

  /** Follow a FAT chain, concatenating sectors, clamped to `size` bytes. */
  const readChain = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let sector = start;
    let written = 0;
    let hops = 0;
    while (sector !== ENDOFCHAIN && written < size) {
      // Cycle/overrun guard: a valid chain can never exceed the sector count.
      if (hops++ > totalSectors || sector >= fat.length) throw new Error(ERR.corrupt("FAT chain loops"));
      const chunk = sectorBytes(sector);
      out.set(chunk.subarray(0, Math.min(sectorSize, size - written)), written);
      written += sectorSize;
      sector = fat[sector];
    }
    return out;
  };

  // --- Directory: a FAT chain of 128-byte entries. We don't know its byte size
  // up front, so walk the chain sector-by-sector with the same loop guard.
  const dirSectors: Uint8Array[] = [];
  let dirSector = firstDirSector;
  let dirHops = 0;
  while (dirSector !== ENDOFCHAIN) {
    if (dirHops++ > totalSectors || dirSector >= fat.length) throw new Error(ERR.corrupt("directory chain loops"));
    dirSectors.push(sectorBytes(dirSector));
    dirSector = fat[dirSector];
  }

  const entries: CfbEntry[] = [];
  for (const sector of dirSectors) {
    const sv = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
    for (let off = 0; off + 128 <= sector.length; off += 128) {
      const nameLen = sv.getUint16(off + 64, true); // bytes, including the NUL
      const type = sv.getUint8(off + 66);
      if (type === 0 || nameLen < 2 || nameLen > 64) continue; // unused slot
      let name = "";
      for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(sv.getUint16(off + i, true));
      entries.push({
        name,
        type,
        startSector: sv.getUint32(off + 116, true),
        // Size is a uint64, but HWP streams are far below 4 GB — the low half suffices.
        size: sv.getUint32(off + 120, true),
      });
    }
  }

  const root = entries.find((e) => e.type === 5);
  if (!root) throw new Error(ERR.corrupt("missing root directory entry"));

  // --- Mini stream: streams smaller than the cutoff (4096) don't own regular
  // sectors. They live inside one big stream rooted at the root entry, sliced
  // into 64-byte mini sectors addressed by a separate mini FAT. HWP's
  // FileHeader is only 256 bytes, so this path is mandatory, not optional.
  let miniStream: Uint8Array | null = null;
  let miniFat: Uint32Array | null = null;
  const lazyMini = () => {
    if (miniStream && miniFat) return;
    miniStream = readChain(root.startSector, root.size);
    const miniFatSectors = Math.ceil(root.size / miniSectorSize) + 1;
    const raw = readChain(firstMiniFatSector, miniFatSectors * 4 + sectorSize);
    const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    miniFat = new Uint32Array(Math.floor(raw.length / 4));
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = rv.getUint32(i * 4, true);
  };

  const readMiniChain = (start: number, size: number): Uint8Array => {
    lazyMini();
    const out = new Uint8Array(size);
    let sector = start;
    let written = 0;
    let hops = 0;
    const maxMini = Math.ceil(miniStream!.length / miniSectorSize);
    while (sector !== ENDOFCHAIN && written < size) {
      if (hops++ > maxMini || sector >= miniFat!.length || sector >= maxMini) {
        throw new Error(ERR.corrupt("mini FAT chain loops"));
      }
      const at = sector * miniSectorSize;
      out.set(miniStream!.subarray(at, at + Math.min(miniSectorSize, size - written)), written);
      written += miniSectorSize;
      sector = miniFat![sector];
    }
    return out;
  };

  return {
    entries,
    readStream: (entry) =>
      entry.size < miniCutoff && entry.type !== 5
        ? readMiniChain(entry.startSector, entry.size)
        : readChain(entry.startSector, entry.size),
  };
}

/* ------------------------------------------------------------------------- *
 * HWP FileHeader
 * ------------------------------------------------------------------------- */

const HWP_SIGNATURE = "HWP Document File";

interface HwpHeader {
  compressed: boolean;
}

/** Validate signature/version/flags; throws for anything we can't extract from. */
function parseFileHeader(bytes: Uint8Array): HwpHeader {
  if (bytes.length < 40) throw new Error(ERR.notHwp);
  let sig = "";
  for (let i = 0; i < HWP_SIGNATURE.length; i++) sig += String.fromCharCode(bytes[i]);
  if (sig !== HWP_SIGNATURE) throw new Error(ERR.notHwp);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Version is 0xMMnnPPrr (e.g. 5.0.3.0 → 0x05000300); only the major matters here.
  const version = view.getUint32(32, true);
  const major = (version >>> 24) & 0xff;
  if (major < 5) {
    throw new Error(ERR.legacy(`${major}.${(version >>> 16) & 0xff}`));
  }

  const flags = view.getUint32(36, true);
  // Reject before touching BodyText: encrypted sections are unreadable, and DRM
  // ("distribution") documents keep their text obfuscated under ViewText.
  if (flags & 0b10) throw new Error(ERR.encrypted);
  if (flags & 0b100) throw new Error(ERR.drm);
  return { compressed: (flags & 0b1) !== 0 };
}

/* ------------------------------------------------------------------------- *
 * Section record stream → paragraphs and tables
 * ------------------------------------------------------------------------- */

// HWPTAG_BEGIN (0x10) + 51 — the record that carries a paragraph's WCHARs.
const HWPTAG_PARA_TEXT = 0x10 + 51;
// HWPTAG_BEGIN + 55 — opens a control; the payload starts with its 4-byte id.
const HWPTAG_CTRL_HEADER = 0x10 + 55;
// HWPTAG_BEGIN + 56 — opens a paragraph list (one per table cell / caption).
const HWPTAG_LIST_HEADER = 0x10 + 56;
// HWPTAG_BEGIN + 61 — table body: 4-byte attr, then uint16 nRows / nCols.
const HWPTAG_TABLE = 0x10 + 61;

// Ctrl ids pack as MAKE_4CHID('t','b','l',' ') = 't'<<24|'b'<<16|'l'<<8|' ',
// stored little-endian — so reading the uint32 LE yields this constant.
const CTRL_ID_TABLE = 0x74626c20;

/**
 * Decode one PARA_TEXT payload (UTF-16LE WCHARs) into paragraphs.
 *
 * Code units < 32 are controls, and the spec gives them different *widths*:
 * most inline/extended controls occupy 8 WCHARs (the marker plus 7 of state),
 * so failing to skip the full footprint would leak binary junk into the text.
 */
function decodeParaText(view: DataView, offset: number, byteLength: number): string[] {
  const paragraphs: string[] = [];
  let text = "";
  const count = byteLength >> 1;
  for (let i = 0; i < count; i++) {
    const code = view.getUint16(offset + i * 2, true);
    if (code >= 32) {
      // Literal code unit — surrogate pairs pass through as two units, which
      // reassemble into the right code point in the JS string naturally.
      text += String.fromCharCode(code);
      continue;
    }
    switch (code) {
      case 13: // paragraph terminator
        paragraphs.push(text);
        text = "";
        break;
      case 10: // in-paragraph line break
        text += "\n";
        break;
      case 0:
      case 24: case 25: case 26: case 27: case 28: case 29: case 30: case 31:
        break; // 1-WCHAR char controls with no text representation
      case 9:
        i += 7; // tab is an 8-WCHAR inline control — skip its state, keep the tab
        text += "\t";
        break;
      default:
        i += 7; // remaining inline/extended controls: 8 WCHARs, no text
        break;
    }
  }
  if (text) paragraphs.push(text); // record ended without an explicit terminator
  return paragraphs;
}

/** One parsed record: tag/level from the header, payload location in bytes. */
interface HwpRecord {
  tag: number;
  level: number;
  start: number;
  size: number;
}

/** Split a section's byte stream into its tagged records. */
function parseRecords(section: Uint8Array, view: DataView): HwpRecord[] {
  const records: HwpRecord[] = [];
  let off = 0;
  while (off + 4 <= section.length) {
    // Record header: tagId = bits 0–9, level = 10–19, size = 20–31.
    const header = view.getUint32(off, true);
    off += 4;
    const tag = header & 0x3ff;
    const level = (header >>> 10) & 0x3ff;
    let size = (header >>> 20) & 0xfff;
    if (size === 0xfff) {
      // Sentinel: the real size didn't fit in 12 bits and follows as a uint32.
      if (off + 4 > section.length) throw new Error(ERR.corrupt("truncated record header"));
      size = view.getUint32(off, true);
      off += 4;
    }
    if (off + size > section.length) throw new Error(ERR.corrupt("record overruns section"));
    records.push({ tag, level, start: off, size });
    off += size;
  }
  return records;
}

/**
 * Render a table control's subtree (every record deeper than the control) as
 * one GFM table block. Each cell is a LIST_HEADER one level below the control,
 * whose paragraphs follow it in row-major order. On any structural surprise —
 * missing/short TABLE record, text before the first cell, cell count ≠
 * nRows×nCols — the cell texts are returned as plain paragraphs instead, so
 * nothing is ever dropped.
 */
function tableBlocks(view: DataView, subtree: HwpRecord[], ctrlLevel: number): string[] {
  const tableRec = subtree.find((r) => r.tag === HWPTAG_TABLE);
  const cellLevel = ctrlLevel + 1;

  // Collect paragraphs per cell, and flat (stream order) for the fallback.
  const cells: string[][] = [];
  const flat: string[] = [];
  let current: string[] | null = null;
  let surprised = tableRec === undefined || tableRec.size < 8;
  for (const rec of subtree) {
    if (rec.tag === HWPTAG_LIST_HEADER && rec.level === cellLevel) {
      current = [];
      cells.push(current);
    } else if (rec.tag === HWPTAG_PARA_TEXT) {
      const paragraphs = decodeParaText(view, rec.start, rec.size);
      flat.push(...paragraphs);
      // Text before any cell list (unexpected here) can't be placed in a grid.
      if (current) current.push(...paragraphs);
      else surprised = true;
    }
  }

  if (!surprised) {
    const nRows = view.getUint16(tableRec!.start + 4, true);
    const nCols = view.getUint16(tableRec!.start + 6, true);
    if (nRows >= 1 && nCols >= 1 && cells.length === nRows * nCols) {
      // Cell text flattens its paragraphs; pipes/newlines are escaped so they
      // can't break the row — mirroring the HWPX table renderer.
      const texts = cells.map((c) =>
        c.filter((p) => p.length > 0).join(" ").replace(/\|/g, "\\|").replace(/\n/g, " ").trim(),
      );
      const line = (row: string[]) => `| ${row.join(" | ")} |`;
      const rows = Array.from({ length: nRows }, (_, r) => texts.slice(r * nCols, (r + 1) * nCols));
      const [head, ...body] = rows;
      return [[line(head), `| ${Array(nCols).fill("---").join(" | ")} |`, ...body.map(line)].join("\n")];
    }
  }
  return flat;
}

/** Walk a section's records and collect its blocks: paragraphs in stream
 *  order, with recognized table controls rendered as GFM tables in place. */
function extractSectionBlocks(section: Uint8Array): string[] {
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  const records = parseRecords(section, view);
  const blocks: string[] = [];
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (rec.tag === HWPTAG_CTRL_HEADER && rec.size >= 4 && view.getUint32(rec.start, true) === CTRL_ID_TABLE) {
      // The control owns every following record at a deeper level.
      let end = i + 1;
      while (end < records.length && records[end].level > rec.level) end++;
      blocks.push(...tableBlocks(view, records.slice(i + 1, end), rec.level));
      i = end;
      continue;
    }
    if (rec.tag === HWPTAG_PARA_TEXT) blocks.push(...decodeParaText(view, rec.start, rec.size));
    i++;
  }
  return blocks;
}

/* ------------------------------------------------------------------------- *
 * Raw-deflate decompression (HWP compresses each section with windowBits −15)
 * ------------------------------------------------------------------------- */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // Native in Node 21+ and all modern browsers; the guard exists so an old
  // runtime fails with an actionable message instead of a ReferenceError.
  if (typeof DecompressionStream === "undefined") throw new Error(ERR.noInflate);
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // Fire-and-forget the write: awaiting it before reading can deadlock on big
  // payloads. Decode errors surface through the reader; swallow the duplicate.
  // (Cast: lib.dom's BufferSource insists on Uint8Array<ArrayBuffer>, but our
  // subarray views are typed with the wider ArrayBufferLike.)
  const writing = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close());
  writing.catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * Extract the document text of a binary HWP 5.x file as markdown-ish plain
 * text (paragraphs separated by blank lines, tables as GFM). Throws a
 * descriptive bilingual Error for encrypted, DRM'd, or pre-5.0 files.
 */
export async function hwpToText(buffer: ArrayBuffer): Promise<string> {
  const cfb = parseCfb(new Uint8Array(buffer));

  const headerEntry = cfb.entries.find((e) => e.type === 2 && e.name === "FileHeader");
  if (!headerEntry) throw new Error(ERR.notHwp);
  const header = parseFileHeader(cfb.readStream(headerEntry));

  // Flat name scan is safe here: `SectionN` streams only exist under BodyText
  // (ViewText appears solely in distribution documents, rejected above).
  const sections = cfb.entries
    .map((e) => ({ entry: e, match: e.type === 2 ? /^Section(\d+)$/.exec(e.name) : null }))
    .filter((s): s is { entry: CfbEntry; match: RegExpExecArray } => s.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

  const paragraphs: string[] = [];
  for (const { entry } of sections) {
    let bytes = cfb.readStream(entry);
    if (header.compressed) bytes = await inflateRaw(bytes);
    // Drop empty paragraphs: blank-line spacing already comes from the join.
    paragraphs.push(...extractSectionBlocks(bytes).filter((p) => p.length > 0));
  }

  return paragraphs.join("\n\n").replace(/\s+$/, "");
}
