import { lazy } from "react";

import type { ArtifactRegistry } from "../../registry/registry";
import { HtmlRenderer } from "./HtmlRenderer";

// The `html` substrate is eager — it's the lightweight base (a sandboxed iframe,
// no third-party runtime). The structured renderers each pull a sizeable library
// (recharts / react-markdown / @fortune-sheet), so they're lazy: their code and
// deps split into on-demand chunks and only reach a consumer's bundle when an
// artifact of that type actually renders. A `<Canvas>` that only shows web pages
// never downloads recharts or react-markdown.
const ChartRenderer = lazy(() => import("./ChartRenderer").then((m) => ({ default: m.ChartRenderer })));
const DocumentRenderer = lazy(() => import("./DocumentRenderer").then((m) => ({ default: m.DocumentRenderer })));
const TableRenderer = lazy(() => import("./TableRenderer").then((m) => ({ default: m.TableRenderer })));
const SlidesRenderer = lazy(() => import("./SlidesRenderer").then((m) => ({ default: m.SlidesRenderer })));

export { HtmlRenderer, DocumentRenderer, ChartRenderer, TableRenderer, SlidesRenderer };

/**
 * The batteries-included renderers. `html` is the base substrate (sandboxed
 * iframe); the rest are structured conveniences, lazily loaded. Pass to
 * `<Canvas registry />` or merge with your own. They render under `<Canvas>`'s
 * Suspense boundary, so the on-demand chunks resolve transparently.
 */
export const builtinRenderers: ArtifactRegistry = {
  html: HtmlRenderer,
  document: DocumentRenderer,
  chart: ChartRenderer,
  table: TableRenderer,
  slides: SlidesRenderer,
};
