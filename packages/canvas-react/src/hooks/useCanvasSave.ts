/**
 * `useCanvasSave` — debounced whole-artifact save for user edits.
 *
 * Subscribes to the store's `userEditSeq` (bumped by `applyUserEvent` only, so
 * agent streaming never triggers a save) and, after `debounceMs` of quiet,
 * hands the edited artifact to `onSave`. The host decides where it goes — a
 * `CanvasStore`-backed endpoint, local storage, anywhere.
 *
 * `baseRevision` is the artifact's last known store revision (stamped into
 * `meta.revision` by `canvas.commit` events); hosts pass it to their save
 * endpoint so a stale write can be rejected instead of overwriting.
 */

import { useEffect, useRef } from "react";

import type { Artifact } from "../protocol/artifacts";
import { useCanvasStore, useCanvasStoreApi } from "../store/context";

export interface CanvasSavePayload {
  artifactId: string;
  artifact: Artifact;
  /** Store revision the user's edit is based on, when known. */
  baseRevision: string | null;
}

export type CanvasSaveHandler = (payload: CanvasSavePayload) => void | Promise<void>;

const DEFAULT_DEBOUNCE_MS = 800;

export function useCanvasSave(onSave: CanvasSaveHandler | undefined, debounceMs = DEFAULT_DEBOUNCE_MS) {
  const storeApi = useCanvasStoreApi();
  const userEditSeq = useCanvasStore((s) => s.userEditSeq);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the artifacts already-saved seq so a re-render without edits is a no-op.
  const savedSeq = useRef(0);

  useEffect(() => {
    if (!onSave || userEditSeq === 0 || userEditSeq === savedSeq.current) return;
    if (timer.current) clearTimeout(timer.current);
    const seq = userEditSeq;
    timer.current = setTimeout(() => {
      savedSeq.current = seq;
      const { canvas } = storeApi.getState();
      const active = canvas.activeId ? canvas.artifacts[canvas.activeId] : null;
      if (!active) return;
      void onSave({
        artifactId: active.id,
        artifact: active,
        baseRevision: typeof active.meta?.revision === "string" ? active.meta.revision : null,
      });
    }, debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [onSave, userEditSeq, debounceMs, storeApi]);
}
