/**
 * `useArtifactPatch` — let a renderer commit an inline edit back to the store.
 *
 * Editing an artifact on the canvas is just a client-side `canvas.patch`: it
 * flows through the exact same reconciler an agent's edits do, so the edited
 * value is the one that renders, versions, and exports. Renderers stay in sync
 * with the single source of truth instead of holding a private copy.
 */

import { useCallback } from "react";

import { useCanvasStore } from "./useCanvasStore";

export function useArtifactPatch(id: string) {
  // A user edit — routed through applyUserEvent so it lands on the undo stack.
  const applyUserEvent = useCanvasStore((s) => s.applyUserEvent);
  return useCallback(
    (patch: Record<string, unknown>) => applyUserEvent({ type: "canvas.patch", id, patch }),
    [applyUserEvent, id],
  );
}
