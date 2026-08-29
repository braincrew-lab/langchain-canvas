/**
 * Artifact data shapes — mirror of `langchain_canvas/protocol/artifacts.py`.
 *
 * An `Artifact` is transport-agnostic: `{ id, type, title, version, status,
 * data }`. `type` is a registry key resolved to a React component; `data` is the
 * type-specific payload that component reads. Keep this file in lockstep with
 * the Python module — a field here must exist there, and vice versa.
 */

export type ArtifactStatus = "streaming" | "complete" | "error";

export interface Artifact<TData = unknown> {
  /** Stable identity — the reconciliation key. */
  id: string;
  /** Registry key: "document" | "chart" | ... */
  type: string;
  /** Shown in the canvas header / tab. */
  title: string;
  /** 1-based; bumped on every `canvas.replace`. */
  version: number;
  status: ArtifactStatus;
  data: TData;
  meta?: Record<string, unknown>;
}

// --- built-in artifact data shapes ---------------------------------------------

/**
 * The base substrate: raw HTML, rendered in a sandboxed iframe. Everything a
 * canvas can show is ultimately HTML; `document` / `chart` / `table` are
 * structured conveniences the SDK renders for you, while `html` lets an agent
 * emit an arbitrary self-contained page (the Claude-Artifacts / Genspark model).
 */
export interface HtmlData {
  html: string;
}

export interface DocumentData {
  format: "markdown";
  content: string;
}

export interface ChartSeries {
  /** Column in `ChartData.rows` to plot. */
  key: string;
  label?: string;
  color?: string;
}

export interface ChartOptions {
  stacked?: boolean;
  yLabel?: string;
  /** Chart title shown above the plot. */
  title?: string;
  /** Per-slice colors for pie charts, index-aligned to `rows`. */
  colors?: string[];
}

export interface ChartData {
  chart: "line" | "bar" | "area" | "pie";
  /** Tidy/long-form rows, consumed directly by the charting library. */
  rows: Array<Record<string, string | number>>;
  /** Category / x-axis field. */
  xKey: string;
  series: ChartSeries[];
  options?: ChartOptions;
  /**
   * Optional raw ECharts `option`. When present it's rendered verbatim — an
   * escape hatch for agents/apps that already produce a full ECharts config
   * (the tidy `rows`/`series` model is ignored, and inline editing is disabled).
   */
  echartsOption?: Record<string, unknown>;
}

export interface TableColumn {
  key: string;
  label?: string;
  align?: "left" | "right" | "center";
}

export interface TableData {
  columns: TableColumn[];
  rows: Array<Record<string, string | number>>;
  /**
   * Opaque spreadsheet state (Fortune-sheet sheets) once the user has edited the
   * grid — carries merges, per-cell fonts/formats, and formulas that the simple
   * columns/rows shape can't hold. Present after the first interactive edit;
   * exporters prefer it over columns/rows.
   */
  sheet?: Array<Record<string, unknown>>;
}

/** A freely-positioned element on a "blank" slide (percent geometry, 0–100). */
/** One table cell's own look, where it differs from the table's. The cell's
 *  text lives in the table element's `rows`. */
export interface SlideTableCell {
  r: number;
  c: number;
  fill?: string;
  color?: string;
  bold?: boolean;
  align?: "left" | "center" | "right";
  fontSize?: number;
  colSpan?: number;
  rowSpan?: number;
}

export interface SlideElement {
  id: string;
  type: "text" | "image" | "shape" | "table";
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  src?: string;
  fontSize?: number;
  bold?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
  /** Shape kind for `type: "shape"`. */
  shape?: "rect" | "ellipse" | "line";
  /** Fill (rect/ellipse) or stroke (line) color for a shape. */
  fill?: string;
  /** Outline color, independent of fill — a box drawn by its border alone. */
  stroke?: string;
  /** Outline weight in px, like `fontSize`. */
  strokeWidth?: number;
  /** Type face; without it line breaks land elsewhere than in the source file. */
  fontFamily?: string;
  /** Line box as a multiple of the font size. */
  lineHeight?: number;
  /** Where text sits in its box. */
  verticalAlign?: "top" | "middle" | "bottom";
  /** Colour band behind the words, the way a highlighter marks a heading. */
  highlight?: string;
  /** Space above the text, in px. */
  spaceBefore?: number;
  /** Space below the text, in px. */
  spaceAfter?: number;
  /** A table's words: a grid of strings, row-major. `stroke` draws the grid;
   *  `fill` / `color` / `fontSize` / `fontFamily` / `bold` / `align` are the
   *  cells' defaults. */
  rows?: string[][];
  /** The first row is a header row. */
  header?: boolean;
  /** Column widths as percent of the table's box; absent means equal shares. */
  colWidths?: number[];
  /** Row heights as percent of the table's box; absent means equal shares. */
  rowHeights?: number[];
  /** What single cells do differently. */
  cells?: SlideTableCell[];
}

export interface Slide {
  /** title · content (bullets) · section · image · two-column · blank (free canvas). */
  layout?: "title" | "content" | "section" | "image" | "two-column" | "blank";
  /** Freely-positioned elements for the "blank" layout. */
  elements?: SlideElement[];
  title?: string;
  subtitle?: string;
  bullets?: string[];
  /** Right-hand bullets for the "two-column" layout. */
  bullets2?: string[];
  /** Image (data: URL or https URL) for the "image" layout. */
  image?: string;
  /** Slide background color (hex). */
  background?: string;
  /** Slide text color (hex). */
  textColor?: string;
  /** Speaker notes (not shown on the slide; exported to the .pptx notes pane). */
  notes?: string;
  /** Content padding as a percent of the slide width (a safe margin around the
   *  free canvas). Applied in the editor, present view, thumbnails, and export. */
  padding?: number;
}

/** The deck's page size in inches — the coordinate space percent geometry
 *  refers to. Absent means the classic 16:9 canvas (10 x 5.625). When a
 *  template skin is attached, tools fill this with the skin's real page so
 *  the editor, the preview, and the exported file agree on one aspect
 *  ratio. */
export interface SlidePage {
  widthIn: number;
  heightIn: number;
}

export interface SlidesData {
  slides: Slide[];
  page?: SlidePage;
  /** Optional pptx skin: a canvas reference ("sources/brand.pptx") whose
   *  master and layouts the pptx export builds on. Export-time only — the
   *  canvas preview does not render the skin; a missing or unreadable skin
   *  degrades to the blank-layout export. */
  template?: string;
}

/**
 * A stored canvas file shown as itself — a window onto the store, not a copy.
 * `path` is the canvas-relative reference (`sources/photo.png`); the renderer
 * resolves it against the host's asset endpoint for display and download.
 * `cover` / `excerpt` / `detail` are *derived* previews (never stored).
 */
export interface FileData {
  path: string;
  name: string;
  mediaType?: string;
  size?: number;
  /** data: URI thumbnail of page one (page-renderable sources). */
  cover?: string;
  /** Short text sample, via the source converter. */
  excerpt?: string;
  /** One-line content summary ("3 pages", "5 slides"). */
  detail?: string;
}

// Concrete artifact aliases, handy for renderers that want a narrowed type.
export type HtmlArtifact = Artifact<HtmlData> & { type: "html" };
export type DocumentArtifact = Artifact<DocumentData> & { type: "document" };
export type ChartArtifact = Artifact<ChartData> & { type: "chart" };
export type TableArtifact = Artifact<TableData> & { type: "table" };
export type SlidesArtifact = Artifact<SlidesData> & { type: "slides" };
export type FileArtifact = Artifact<FileData> & { type: "file" };
export type KnownArtifact = HtmlArtifact | DocumentArtifact | ChartArtifact | TableArtifact | SlidesArtifact | FileArtifact;
