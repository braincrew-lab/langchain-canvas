import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { CanvasElement, CanvasElementCollection, CanvasElementReference, CanvasElementSelectionProps } from "../protocol/elements";

export const ElementSelectionContext = createContext<CanvasElementSelectionProps>({});
export const useElementSelection = () => useContext(ElementSelectionContext);

export function sameElementReference(a: CanvasElementReference, b: CanvasElementReference): boolean {
  return a.path === b.path && a.revision === b.revision && a.element_id === b.element_id &&
    a.sheet_name === b.sheet_name && a.range === b.range;
}

/** Reject invalid source geometry rather than silently moving an element's target. */
export function hasPageBounds(element: CanvasElement, pageCount: number): boolean {
  const b = element.bounds;
  return !!b && Number.isInteger(element.page) && element.page! >= 1 && element.page! <= pageCount &&
    [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.x >= 0 && b.y >= 0 &&
    b.width > 0 && b.height > 0 && b.x + b.width <= 1.000001 && b.y + b.height <= 1.000001;
}

type ElementLoadState = { key: string; loader: CanvasElementSelectionProps["loadElements"]; status: "loading" | "ready" | "error"; collection?: CanvasElementCollection };

/** Abort and identity-gate results so a late response cannot target another document. */
export function usePageElements(path: string, revision: string | undefined, pageCount: number) {
  const { selectionMode, loadElements } = useElementSelection();
  const enabled = selectionMode === "elements";
  const key = JSON.stringify([path, revision]);
  const [state, setState] = useState<ElementLoadState | null>(null);
  useEffect(() => {
    if (!enabled || !revision || !loadElements) return;
    const controller = new AbortController();
    let active = true;
    setState({ key, loader: loadElements, status: "loading" });
    Promise.resolve().then(() => loadElements({ path, revision, signal: controller.signal })).then((collection) => {
      if (!active) return;
      if (collection.path !== path || collection.revision !== revision || !Array.isArray(collection.elements)) {
        throw new Error("Element metadata does not match the displayed document");
      }
      setState({ key, loader: loadElements, status: "ready", collection });
    }).catch(() => {
      if (active) setState({ key, loader: loadElements, status: "error" });
    });
    return () => { active = false; controller.abort(); };
  }, [enabled, key, path, revision, loadElements]);
  const current = enabled && state?.key === key && state.loader === loadElements ? state : null;
  const elements = useMemo(() => {
    const all = current?.collection?.elements ?? [];
    const sources = new Map<string, CanvasElement>();
    const ambiguous = new Set<string>();
    const fragments = new Set<string>();
    for (const element of all) {
      const source = sources.get(element.id);
      if (source && (source.kind !== element.kind ||
        Object.keys(source.locator).length !== Object.keys(element.locator).length ||
        Object.entries(source.locator).some(([key, value]) => element.locator[key] !== value))) ambiguous.add(element.id);
      sources.set(element.id, element);
    }
    return all.filter((element) => {
      if (!element.id || ambiguous.has(element.id) || !hasPageBounds(element, pageCount)) return false;
      const key = JSON.stringify([element.id, element.page, element.bounds]);
      if (fragments.has(key)) return false;
      fragments.add(key);
      return true;
    });
  }, [current?.collection, pageCount]);
  return {
    enabled,
    status: !revision || !loadElements ? "unavailable" as const : current?.status ?? "loading" as const,
    elements,
    unsupportedReason: current?.collection?.unsupported_reason,
    incomplete: (current?.collection?.elements.length ?? 0) > elements.length,
  };
}
