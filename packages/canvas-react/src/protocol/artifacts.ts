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

/**
 * A PDF shown in the browser's native viewer. `src` is a `data:application/pdf`
 * URL (self-contained, the common case for agent/file-sourced PDFs), a `blob:`
 * URL, or an `https:` URL the host is allowed to frame.
 */
export interface PdfData {
  src: string;
  /** Optional original filename, used for the download attribute. */
  filename?: string;
}

/** A freely-positioned element on a "blank" slide (percent geometry, 0–100). */
export interface SlideElement {
  id: string;
  type: "text" | "image" | "shape";
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
  /** Editor-only grouping: elements sharing a `group` id select and move as
   *  one. Purely additive — exporters and the presenter ignore it. */
  group?: string;
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
  /** Theme accent color (hex) — used by quick layouts and new shapes for rules,
   *  section numbers, and stats. Set by the theme presets. */
  accent?: string;
  /** Font stack for the slide's text (system fonts only, no external loads).
   *  Set by the theme presets; cascades to every element. */
  fontFamily?: string;
  /** Speaker notes (not shown on the slide; exported to the .pptx notes pane). */
  notes?: string;
  /** Content padding as a percent of the slide width (a safe margin around the
   *  free canvas). Applied in the editor, present view, thumbnails, and export. */
  padding?: number;
}

export interface SlidesData {
  slides: Slide[];
}

// Concrete artifact aliases, handy for renderers that want a narrowed type.
export type HtmlArtifact = Artifact<HtmlData> & { type: "html" };
export type DocumentArtifact = Artifact<DocumentData> & { type: "document" };
export type ChartArtifact = Artifact<ChartData> & { type: "chart" };
export type TableArtifact = Artifact<TableData> & { type: "table" };
export type SlidesArtifact = Artifact<SlidesData> & { type: "slides" };
export type PdfArtifact = Artifact<PdfData> & { type: "pdf" };
export type KnownArtifact = HtmlArtifact | DocumentArtifact | ChartArtifact | TableArtifact | SlidesArtifact | PdfArtifact;
