/**
 * Which canvas files are edited through a copy.
 *
 * An upload under `sources/` stays the person's original; the tools put an
 * editable copy at the canvas root under a name derived from it. Once that
 * copy exists the upload's own tab says nothing the copy does not — so the
 * tab bar shows the copy alone. The names are the Python tools' rules,
 * parity-pinned in `test_protocol_parity.py`.
 */

export const SOURCES_PREFIX = "sources/";
/** In front of a Word copy's name (see `_WORKING_COPY_MARKER` in tools.py). */
export const WORKING_COPY_MARKER = "Editing - ";

/** The canvas-root ids a copy of `sourceId` may live under. */
export function workingCopyIds(sourceId: string): string[] {
  if (!sourceId.startsWith(SOURCES_PREFIX)) return [];
  const name = sourceId.slice(SOURCES_PREFIX.length);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (ext === "pptx") return [`${stem}.slides.json`];
  if (ext === "xlsx") return [`${stem}.table.json`];
  // A source already carrying the marker (an exported copy uploaded again)
  // gets its copy under the same name — the Python rule, not a doubled marker.
  if (ext === "docx") return [name.startsWith(WORKING_COPY_MARKER) ? name : WORKING_COPY_MARKER + name];
  return [];
}

/** The ids the tab bar shows: every artifact except a source whose copy is open. */
export function visibleTabs(order: string[]): string[] {
  const present = new Set(order);
  return order.filter((id) => !workingCopyIds(id).some((copy) => present.has(copy)));
}
