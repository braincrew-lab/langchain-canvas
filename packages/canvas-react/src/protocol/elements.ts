/** Source-bound semantic metadata supplied by the host, separate from editing selections. */
export interface CanvasElement {
  id: string;
  kind: "paragraph" | "table" | "image" | "shape" | "text" | "chart" | "sheet-range";
  label: string;
  text?: string;
  page?: number;
  /** Normalized top-left bounds relative to the rendered source page. */
  bounds?: { x: number; y: number; width: number; height: number };
  locator: Record<string, string | number>;
}

export interface CanvasElementReference {
  path: string;
  revision: string;
  published_snapshot_id?: string;
  element_id: string;
  sheet_name?: string;
  range?: string;
}

export interface CanvasElementCollection {
  path: string;
  revision: string;
  blob_sha256: string;
  elements: CanvasElement[];
  unsupported_reason?: string;
}

export interface CanvasElementLoadRequest {
  path: string;
  revision: string;
  signal: AbortSignal;
}

export interface CanvasElementSelectionProps {
  /** Explicit opt-in to host-directed references; never grants editing permission. */
  selectionMode?: "elements";
  /** Load authoritative metadata for exactly this file revision. */
  loadElements?: (request: CanvasElementLoadRequest) => Promise<CanvasElementCollection>;
  /** Stage a fresh reference snapshot. Omit to disable staging controls. */
  onAddElement?: (reference: CanvasElementReference, element: CanvasElement) => void;
  /** Controlled attachment feedback, independent of the legacy editor selection. */
  selectedElements?: readonly CanvasElementReference[];
}
