/**
 * Store wiring — provider + hooks.
 *
 * `<CanvasProvider>` creates one isolated store and shares it via context, so an
 * app can host several independent canvas/chat instances. Without a provider,
 * everything falls back to a single lazily-created default store, so the simple
 * `useCanvasStream()` + `<Canvas/>` usage works with zero setup.
 *
 * Components read slices with `useCanvasStore(selector)`; imperative code (the
 * stream hook) grabs the raw store via `useCanvasStoreApi()`.
 */

import { createContext, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { createCanvasStore, type CanvasStore } from "./store";

const CanvasStoreContext = createContext<StoreApi<CanvasStore> | null>(null);

let defaultStore: StoreApi<CanvasStore> | null = null;
const getDefaultStore = () => (defaultStore ??= createCanvasStore());

export interface CanvasProviderProps {
  children: ReactNode;
  /** Bring your own store (e.g. shared across trees); one is created otherwise. */
  store?: StoreApi<CanvasStore>;
}

export function CanvasProvider({ children, store }: CanvasProviderProps) {
  const [instance] = useState(() => store ?? createCanvasStore());
  return <CanvasStoreContext.Provider value={instance}>{children}</CanvasStoreContext.Provider>;
}

/** The raw store API for the nearest provider (or the default store). */
export function useCanvasStoreApi(): StoreApi<CanvasStore> {
  return useContext(CanvasStoreContext) ?? getDefaultStore();
}

/** Subscribe to a slice of the canvas store. */
export function useCanvasStore<T>(selector: (state: CanvasStore) => T): T {
  return useStore(useCanvasStoreApi(), selector);
}
