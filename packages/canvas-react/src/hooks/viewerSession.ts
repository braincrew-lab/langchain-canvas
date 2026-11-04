import { useCanvasStoreApi } from "./useCanvasStore";

type Store = ReturnType<typeof useCanvasStoreApi>;
type Entry = { revision: string | number; value: unknown };
const sessions = new WeakMap<Store, Map<string, Entry>>();
const MAX_VIEWERS = 32;

/** Ephemeral reading preferences, isolated by Canvas store and document revision. */
export function useViewerSession<T>(key: string, revision: string | number, initial: () => T): { current: T } {
  const store = useCanvasStoreApi();
  let entries = sessions.get(store);
  if (!entries) {
    entries = new Map();
    sessions.set(store, entries);
    const registry = entries;
    store.subscribe((state, previous) => {
      if (state.canvas !== previous.canvas && state.canvas.order.length === 0) registry.clear();
    });
  }
  let entry = entries.get(key);
  if (!entry || entry.revision !== revision) {
    entry = { revision, value: { current: initial() } };
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > MAX_VIEWERS) entries.delete(entries.keys().next().value!);
  }
  // Each caller owns a namespaced key and its state shape; no external data enters this map.
  const reference = entry.value as { current: T };
  return reference;
}
