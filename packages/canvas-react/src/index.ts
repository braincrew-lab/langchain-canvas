/**
 * @braincrew-lab/langchain-canvas — a live canvas for LangChain agents.
 *
 *     import { Canvas, useCanvasStream } from "@braincrew-lab/langchain-canvas";
 *     import "@braincrew-lab/langchain-canvas/styles.css";
 *
 * The public surface is small on purpose: one hook (`useCanvasStream`), one
 * component (`<Canvas />`), and the wire types. Everything else — the
 * reconciler, the store, the registry — is exported for advanced/headless use.
 *
 * The package entry is a Client Component boundary (`"use client"`), so it drops
 * straight into a Next.js App Router / RSC host without the consumer having to
 * add their own boundary. Pure, server-safe helpers (the reconciler, wire types,
 * exporters/importers) can be imported from their own modules if needed.
 */

// wire protocol (mirrors `langchain_canvas.protocol`)
export * from "./protocol";

// low-level client (reconciler + SSE parser) for headless integrations
export * from "./client";

// store + hooks
export { CanvasProvider, useCanvasStore, useCanvasStoreApi, createCanvasStore } from "./hooks/useCanvasStore";
export type { CanvasStore, ChatMessage, IframeCommand, CanvasProviderProps } from "./hooks/useCanvasStore";
export { useCanvasStream } from "./hooks/useCanvasStream";
export type { UseCanvasStreamOptions } from "./hooks/useCanvasStream";
export { useCanvasReplay } from "./hooks/useCanvasReplay";
export { useArtifactPatch } from "./hooks/useArtifactPatch";

// schema fixtures — render the canvas with no backend
export { scenarios } from "./fixtures/scenarios";
export type { Scenario } from "./fixtures/scenarios";

// registry
export { CanvasRegistryProvider, useRenderer, mergeRegistries } from "./registry/registry";
export type { ArtifactRegistry, ArtifactRenderer, RendererProps } from "./registry/registry";

// components
export { Canvas } from "./components/Canvas";
export type { CanvasProps } from "./components/Canvas";
export { ExportMenu } from "./components/ExportMenu";
export { SelectionBar } from "./components/SelectionBar";
export { StylePanel } from "./components/StylePanel";
export { ArtifactCard } from "./components/ArtifactCard";
export {
  builtinRenderers,
  HtmlRenderer,
  DocumentRenderer,
  ChartRenderer,
  TableRenderer,
  SlidesRenderer,
} from "./components/renderers";

// export layer (artifact → file)
export { downloadBlob, slugify } from "./export/download";
export { dataExporters, toStandaloneHtml, slidesToPrintHtml } from "./export/exporters";
export type { FileExport } from "./export/exporters";
export { printToPdf } from "./export/pdf";

// import layer (file → artifact) — round-trip
export { importFile, parseCsv, canImport, IMPORTABLE_EXTENSIONS } from "./io/importers";
export { useCanvasImport } from "./hooks/useCanvasImport";
