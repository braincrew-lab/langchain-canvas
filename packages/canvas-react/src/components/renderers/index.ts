import type { ArtifactRegistry } from "../../registry/registry";
import { ChartRenderer } from "./ChartRenderer";
import { DocumentRenderer } from "./DocumentRenderer";
import { HtmlRenderer } from "./HtmlRenderer";
import { SlidesRenderer } from "./SlidesRenderer";
import { TableRenderer } from "./TableRenderer";

export { HtmlRenderer, DocumentRenderer, ChartRenderer, TableRenderer, SlidesRenderer };

/**
 * The batteries-included renderers. `html` is the base substrate (sandboxed
 * iframe); the rest are structured conveniences. Pass to `<Canvas registry />`
 * or merge with your own. Kept separate from the headless core so apps that ship
 * custom renderers don't pull in `react-markdown` / `recharts`.
 */
export const builtinRenderers: ArtifactRegistry = {
  html: HtmlRenderer,
  document: DocumentRenderer,
  chart: ChartRenderer,
  table: TableRenderer,
  slides: SlidesRenderer,
};
