/**
 * The host's seam into the panel chrome: every user-facing string the package
 * renders (`labels`) and every optional piece of chrome it can leave out
 * (`chrome`). Both default to what the package always did, so a host that
 * passes nothing sees no change; a host that localises passes a partial map
 * and only those keys move.
 *
 * Catalog names (slide themes, HTML templates, font stacks) and default content
 * ("New slide", "Column 1") stay in the renderers on purpose — they are data
 * the person edits, not chrome.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface CanvasLabels {
  // panel
  busy: string;
  dropToOpen: string;
  loading: string;
  noRenderer: (type: string) => string;
  emptyTitle: string;
  emptyHint: string;
  emptyOpen: string;
  emptyFormats: string;
  emptyFormatsAny: string;

  // header
  statusWriting: string;
  statusError: string;
  statusReady: string;
  undo: string;
  redo: string;
  undoRedoGroup: string;
  versionsGroup: string;
  previousVersion: string;
  nextVersion: string;
  openVersions: string;
  versionsList: string;
  versionOf: (n: number, total: number) => string;
  versionItem: (n: number) => string;
  snapshot: string;
  viewingVersion: (n: number, total: number) => string;
  backToLatest: string;

  // export menu
  exportMenu: string;
  exportOpenInTab: string;
  exportCopyHtml: string;
  exportCopied: string;
  exportHtml: string;
  exportPdf: string;
  exportMarkdown: string;
  exportWord: string;
  exportCsv: string;
  exportJson: string;

  // renderer boundary
  renderFailed: string;

  // file card + docx preview
  download: string;
  firstPage: (name: string) => string;
  previewOf: (name: string) => string;
  docxBanner: string;
  docxWords: (n: number) => string;
  docxPointingAt: (address: string) => string;
  docxSubstituted: (fonts: string) => string;
  docxShapesHidden: (n: number) => string;
  docxBulletsRedrawn: (fonts: string) => string;
  docxNoPageNumbers: string;
  docxShapesHiddenHint: string;
  docxBulletsRedrawnHint: string;

  // renderer states
  tableLoading: string;
  tableWaiting: string;
  tableCalculating: string;
  chartWaiting: string;
  slidesEmpty: string;
  slideTableEmpty: string;

  // table tool strip
  addColumn: string;
  addRow: string;
  sortBy: string;
  sortPick: string;
  ascending: string;
  descending: string;
  filterRows: string;
  filterPlaceholder: string;
  tableHint: string;

  // chart editor
  chartTitle: string;
  chartTitlePlaceholder: string;
  editData: string;
  done: string;
  seriesName: string;
  remove: string;
  axisLabelPlaceholder: string;
  yAxis: string;
  stacked: string;
  seriesColor: string;
  sliceColor: (name: string) => string;
  addChartRow: string;
  downloadPng: string;
  downloadPngTitle: string;

  // slides toolbar
  addText: string;
  addTextTitle: string;
  addTable: string;
  addTableTitle: string;
  addImage: string;
  addImageTitle: string;
  addShape: string;
  addShapeTitle: string;
  addSlide: string;
  layoutPick: string;
  layoutPickTitle: string;
  backgroundColor: string;
  padding: string;
  paddingTitle: string;
  theme: string;
  themePick: string;
  backgroundImage: string;
  backgroundImageTitle: string;
  present: string;
  presentTitle: string;
  moveUp: string;
  moveDown: string;
  duplicateSlide: string;
  deleteSlide: string;
  previousSlide: string;
  nextSlide: string;
  speakerNotes: string;

  // slide element toolbar
  fontSize: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  duplicate: string;
  bringForward: string;
  sendBack: string;
  deleteElement: string;
  textColor: string;
  fillColor: string;
  gridLineColor: string;
  dragToResizeColumn: string;

  // document editor
  bold: string;
  italic: string;
  inlineCode: string;
  heading1: string;
  heading2: string;
  bulletList: string;
  numberedList: string;
  quote: string;
  link: string;
  clickToEdit: string;
  readingTime: (words: number, minutes: number) => string;

  // html editor
  viewportDesktop: string;
  viewportTablet: string;
  viewportMobile: string;
  pagePick: string;
  pagePickTitle: string;
  sectionPick: string;
  sectionPickTitle: string;
  outlinePick: string;
  outlinePickTitle: string;
  slideLayoutPickTitle: string;
  slideThemePickTitle: string;
  shapePick: string;
  shapePickTitle: string;
  fontPick: string;
  fontPickTitle: string;
  group: string;
  ungroup: string;
  groupHint: string;
  groupNeedsTwo: string;
  htmlSource: string;
  previewWidth: string;
  addLabel: string;
  selectionLabel: string;
  slideBackgroundImage: string;
  a11yCheck: string;
  a11yCheckTitle: string;
  a11yOk: string;
  a11yIssues: (n: number) => string;
  dismiss: string;
  modeDesign: string;
  modeCode: string;

  // style panel
  styleText: string;
  styleBackground: string;
  styleSize: string;
  styleWeight: string;
  styleAlign: string;
  styleLineHeight: string;
  styleLetterSpacing: string;
  stylePadding: string;
  styleRadius: string;
  styleWidth: string;
  styleGradient: string;
  styleSolidColor: string;
}

export const DEFAULT_LABELS: CanvasLabels = {
  busy: "Agent is working…",
  dropToOpen: "Drop to open on the canvas",
  loading: "Loading…",
  noRenderer: (type) => `No renderer registered for type “${type}”.`,
  emptyTitle: "Nothing on the canvas yet",
  emptyHint: "Ask for a report or a chart — or open a file to edit it here.",
  emptyOpen: "Open file",
  emptyFormats: "CSV · Excel · Markdown · HTML · JSON",
  emptyFormatsAny: "Any file — tables and pages open here, the rest goes to the agent",

  statusWriting: "Writing…",
  statusError: "Error",
  statusReady: "Ready",
  undo: "Undo (⌘Z)",
  redo: "Redo (⌘⇧Z)",
  undoRedoGroup: "Undo and redo",
  versionsGroup: "Version history",
  previousVersion: "Previous version",
  nextVersion: "Next version",
  openVersions: "Open version history",
  versionsList: "Versions",
  versionOf: (n, total) => `v${n} / ${total}`,
  versionItem: (n) => `v${n}`,
  snapshot: "Snapshot",
  viewingVersion: (n, total) => `Viewing v${n} of ${total} — read-only.`,
  backToLatest: "Back to latest",

  exportMenu: "Export ▾",
  exportOpenInTab: "Open in new tab ↗",
  exportCopyHtml: "Copy HTML",
  exportCopied: "Copied ✓",
  exportHtml: "HTML",
  exportPdf: "PDF",
  exportMarkdown: "Markdown",
  exportWord: "Word",
  exportCsv: "CSV",
  exportJson: "JSON",

  renderFailed: "This artifact couldn’t be displayed",

  download: "Download",
  firstPage: (name) => `${name} — first page`,
  previewOf: (name) => `${name} preview`,
  docxBanner: "Preview only — to change it, ask in chat or select some text.",
  docxWords: (n) => `${n.toLocaleString()} words`,
  docxPointingAt: (address) => `pointing at [${address}]`,
  docxSubstituted: (fonts) => `substituted: ${fonts}`,
  docxShapesHidden: (n) =>
    n === 1
      ? "1 shape not shown — download the file to see it"
      : `${n} shapes not shown — download the file to see them`,
  docxBulletsRedrawn: (fonts) => `bullets redrawn: ${fonts}`,
  docxNoPageNumbers:
    "The preview keeps the document's own page breaks; it does not repaginate, so it states no page number.",
  docxShapesHiddenHint:
    "This document draws shapes the preview cannot show. They are in the file — a download opens with them in place.",
  docxBulletsRedrawnHint:
    "This document writes its list bullets as characters in a symbol font's own private area, which no other font can draw. They are shown here as the standard characters that mean the same mark; the stored file is unchanged.",

  tableLoading: "Loading spreadsheet…",
  tableWaiting: "Waiting for data…",
  tableCalculating: "Calculating…",
  chartWaiting: "Waiting for data…",
  slidesEmpty: "No slides yet…",
  slideTableEmpty: "table: no rows",

  addColumn: "＋ Column",
  addRow: "＋ Row",
  sortBy: "Sort by column",
  sortPick: "Sort…",
  ascending: "Ascending",
  descending: "Descending",
  filterRows: "Filter rows",
  filterPlaceholder: "Filter…",
  tableHint: "Right-click a header for more, or drag to edit",

  chartTitle: "Chart title",
  chartTitlePlaceholder: "Chart title…",
  editData: "Edit data",
  done: "Done",
  seriesName: "Series name",
  remove: "Remove",
  axisLabelPlaceholder: "label…",
  yAxis: "Y-axis",
  stacked: "Stacked",
  seriesColor: "Series color",
  sliceColor: (name) => `Color: ${name}`,
  addChartRow: "+ Add row",
  downloadPng: "⤓ PNG",
  downloadPngTitle: "Download as PNG",

  addText: "+ Text",
  addTextTitle: "Add text box",
  addTable: "+ Table",
  addTableTitle: "Add table",
  addImage: "+ Image",
  addImageTitle: "Add image",
  addShape: "+ Shape",
  addShapeTitle: "Add a shape",
  addSlide: "+ Add slide",
  layoutPick: "Layout…",
  layoutPickTitle: "Apply a layout",
  backgroundColor: "Background color",
  padding: "Pad",
  paddingTitle: "Content padding (% of slide)",
  theme: "Theme",
  themePick: "Theme…",
  backgroundImage: "🖼 BG",
  backgroundImageTitle: "Background image",
  present: "▶ Present",
  presentTitle: "Present (full screen)",
  moveUp: "Move up",
  moveDown: "Move down",
  duplicateSlide: "Duplicate slide",
  deleteSlide: "Delete slide",
  previousSlide: "Previous slide",
  nextSlide: "Next slide",
  speakerNotes: "Speaker notes…",

  fontSize: "Font size",
  alignLeft: "Align left",
  alignCenter: "Align center",
  alignRight: "Align right",
  duplicate: "Duplicate",
  bringForward: "Bring forward",
  sendBack: "Send back",
  deleteElement: "Delete",
  textColor: "Text color",
  fillColor: "Fill color",
  gridLineColor: "Grid line color",
  dragToResizeColumn: "Drag to resize the column",

  bold: "Bold",
  italic: "Italic",
  inlineCode: "Inline code",
  heading1: "Heading 1",
  heading2: "Heading 2",
  bulletList: "Bullet list",
  numberedList: "Numbered list",
  quote: "Quote",
  link: "Link",
  clickToEdit: "Click to edit",
  readingTime: (words, minutes) => `${words} words · ${minutes} min read`,

  viewportDesktop: "Desktop",
  viewportTablet: "Tablet",
  viewportMobile: "Mobile",
  pagePick: "Page…",
  pagePickTitle: "Start from a full page template (replaces the page)",
  sectionPick: "Section…",
  sectionPickTitle: "Insert a section template",
  outlinePick: "Outline…",
  outlinePickTitle: "Jump to a heading",
  slideLayoutPickTitle: "Insert a slide layout",
  slideThemePickTitle: "Apply a slide theme",
  shapePick: "Shape…",
  shapePickTitle: "Insert a shape",
  fontPick: "Font…",
  fontPickTitle: "Slide font",
  group: "⊞ Group",
  ungroup: "⊟ Ungroup",
  groupHint: "Group — they'll move together",
  groupNeedsTwo: "Select 2+ elements (Shift-click, or drag a box) to group",
  htmlSource: "HTML source",
  previewWidth: "Preview width",
  addLabel: "Add",
  selectionLabel: "Selection",
  slideBackgroundImage: "Slide background image",
  a11yCheck: "♿ Check",
  a11yCheckTitle: "Accessibility check",
  a11yOk: "♿ No accessibility issues found",
  a11yIssues: (n) => `♿ ${n} accessibility issue${n > 1 ? "s" : ""}`,
  dismiss: "Dismiss",
  modeDesign: "Design",
  modeCode: "Code",

  styleText: "Text",
  styleBackground: "Background",
  styleSize: "Size",
  styleWeight: "Weight",
  styleAlign: "Align",
  styleLineHeight: "Line height",
  styleLetterSpacing: "Letter spacing",
  stylePadding: "Padding",
  styleRadius: "Radius",
  styleWidth: "Width",
  styleGradient: "Gradient",
  styleSolidColor: "Solid color (clear image)",
};

/** Optional chrome. Every flag defaults to `true` — the package's own look. */
export interface CanvasChrome {
  /** The per-artifact header row (title, status, actions). */
  header: boolean;
  statusBadge: boolean;
  undoRedo: boolean;
  versions: boolean;
  exportMenu: boolean;
  /** The "Preview only" note above a Word preview. */
  docxBanner: boolean;
  /** The word-count / font-substitution line under a Word preview. */
  docxStatus: boolean;
  /** The "mime · size · detail" facts under a file card's name. */
  fileFacts: boolean;
}

export const DEFAULT_CHROME: CanvasChrome = {
  header: true,
  statusBadge: true,
  undoRedo: true,
  versions: true,
  exportMenu: true,
  docxBanner: true,
  docxStatus: true,
  fileFacts: true,
};

const ChromeContext = createContext<{ labels: CanvasLabels; chrome: CanvasChrome }>({
  labels: DEFAULT_LABELS,
  chrome: DEFAULT_CHROME,
});

export function ChromeProvider({
  labels,
  chrome,
  children,
}: {
  labels?: Partial<CanvasLabels>;
  chrome?: Partial<CanvasChrome>;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({
      labels: { ...DEFAULT_LABELS, ...labels },
      chrome: { ...DEFAULT_CHROME, ...chrome },
    }),
    [labels, chrome],
  );
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

export function useLabels(): CanvasLabels {
  return useContext(ChromeContext).labels;
}

export function useChrome(): CanvasChrome {
  return useContext(ChromeContext).chrome;
}
