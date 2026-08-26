/**
 * Where a table sits on the page, kept apart from how its text is aligned.
 *
 * Word has two alignments that read alike and mean different things. A
 * paragraph's own alignment (`w:pPr/w:jc`) says where its text sits in the
 * column. A table's (`w:tblPr/w:jc`) and a row's (`w:trPr/w:jc`) say where
 * that *block* sits between the page margins — the text inside is untouched
 * and keeps whatever each paragraph asked for.
 *
 * The preview collapses the second kind into the first: block alignment
 * arrives as an inline `text-align` on the `<table>` or `<tr>`, which CSS
 * then hands down to every cell and paragraph inside. A table asked to sit in
 * the middle of the page comes out with all of its text centred, and a form
 * whose answers are marked in the left column has those marks in the middle
 * of the row instead. Measured against the same file rendered by an office
 * suite, that moves the first checkbox of a row from 56pt to as far as 289pt.
 *
 * So this undoes the collapse after rendering: the block alignment is taken
 * off the table and its rows, and put back as block placement where the page
 * can express it — margins, the way the preview itself already handles the
 * table case. Nothing else is touched. A cell or paragraph that stated its
 * own alignment still has it, because that alignment was never on the block.
 *
 * The stored file is not read and not written here; this is a display fix.
 */

/** How many blocks were reinterpreted, for tests and for callers that count. */
export interface AlignmentFix {
  /** Rows whose block alignment was taken off the text. */
  rows: number;
  /** Tables given block placement the rows had been carrying. */
  placed: number;
}

/** Block alignments that move an element, and the margins that do it. */
const PLACEMENT: Readonly<Record<string, readonly [string, string]>> = {
  // [margin-left, margin-right] — an empty string leaves the side alone.
  center: ["auto", "auto"],
  right: ["auto", ""],
};

/** The rows a table owns, without the rows of any table nested inside it. */
function ownRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.rows ?? []);
}

/**
 * Take an inline `text-align` off an element and report what it said.
 *
 * Only inline styles are read. On a `<table>` or `<tr>` the preview writes
 * one exactly when the file gave that block an alignment, so there is nothing
 * else it could be; a rule from a stylesheet is left alone.
 */
function takeBlockAlignment(element: HTMLElement): string {
  const stated = element.style.textAlign;
  if (stated) element.style.removeProperty("text-align");
  return stated;
}

/** Whether the table already sits where something else put it. */
function placed(table: HTMLTableElement): boolean {
  return Boolean(table.style.marginLeft || table.style.marginRight);
}

/**
 * The one alignment every row agreed on, or `""` if they did not all agree.
 *
 * Placement is a property of the block, so it can only be moved onto the
 * table when the whole table asked for the same thing. Rows that disagree
 * keep the preview's placement instead of getting a made-up one: a page
 * cannot put one row of a table in the middle and leave the next on the left,
 * and guessing which row wins would move text the file never moved.
 */
function agreedAlignment(rows: readonly string[]): string {
  if (rows.length === 0) return "";
  const first = rows[0];
  return rows.every((value) => value === first) ? first : "";
}

/**
 * Read block alignment as placement, everywhere in a rendered document.
 *
 * Safe to call more than once: the second pass finds nothing left to take.
 */
export function separateBlockAlignment(root: HTMLElement): AlignmentFix {
  const fix: AlignmentFix = { rows: 0, placed: 0 };
  for (const table of Array.from(root.querySelectorAll("table"))) {
    takeBlockAlignment(table);
    const rows = ownRows(table);
    const stated = rows
      .map((row) => takeBlockAlignment(row))
      .filter((value) => value !== "");
    fix.rows += stated.length;
    // Every row said the same thing, and nothing has placed the table yet —
    // then that is where the table goes.
    if (stated.length !== rows.length || placed(table)) continue;
    const margins = PLACEMENT[agreedAlignment(stated)];
    if (!margins) continue;
    if (margins[0]) table.style.marginLeft = margins[0];
    if (margins[1]) table.style.marginRight = margins[1];
    fix.placed += 1;
  }
  return fix;
}
