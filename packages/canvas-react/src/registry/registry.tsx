/**
 * The artifact registry — maps an artifact `type` to the React component that
 * draws it. This is the seam that decouples the wire (data) from rendering
 * (components): the backend only ever ships `{ type, data }`, and the frontend
 * resolves `type` to a renderer here.
 *
 * Adding a new artifact type is a two-line change: define its data shape in the
 * protocol, then register a renderer. Nothing in the transport or reconciler
 * changes.
 */

import { createContext, useContext, type ComponentType, type ReactNode } from "react";

import type { Artifact } from "../protocol/artifacts";

export interface RendererProps<TData = unknown> {
  artifact: Artifact<TData>;
}

export type ArtifactRenderer = ComponentType<RendererProps<any>>;

export type ArtifactRegistry = Record<string, ArtifactRenderer>;

const RegistryContext = createContext<ArtifactRegistry>({});

export interface CanvasRegistryProviderProps {
  registry: ArtifactRegistry;
  children: ReactNode;
}

export function CanvasRegistryProvider({ registry, children }: CanvasRegistryProviderProps) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

/** Resolve the renderer for an artifact type, or `undefined` if unregistered. */
export function useRenderer(type: string): ArtifactRenderer | undefined {
  return useContext(RegistryContext)[type];
}

/** Merge registries — later entries win. Handy for extending the built-ins. */
export function mergeRegistries(...registries: ArtifactRegistry[]): ArtifactRegistry {
  return Object.assign({}, ...registries);
}
