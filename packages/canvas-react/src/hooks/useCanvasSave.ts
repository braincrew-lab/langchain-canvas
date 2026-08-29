/**
 * `useCanvasSave` — debounced whole-artifact persistence for user edits.
 *
 * The store's `onUserEdit` handler fires per committed user edit (never for
 * agent streaming). This hook turns an `onSave` handler into a debounced
 * per-edit callback for that signal: after `debounceMs` of quiet it hands the
 * latest reconciled artifact to `onSave`. The host decides where it goes — a
 * `CanvasStore`-backed endpoint, local storage, anywhere.
 *
 * `<Canvas onSave={...}>` wires this automatically (composed with the host's
 * own `onUserEdit`, both sharing the store's single user-edit slot). Headless
 * hosts can call the hook themselves and register the returned callback via
 * `setOnUserEdit`.
 *
 * `baseRevision` is the artifact's last known store revision (stamped into
 * `meta.revision` by `canvas.commit` events); hosts pass it to their save
 * endpoint so a stale write can be rejected instead of overwriting.
 */

import { useEffect, useMemo, useRef } from "react";

import type { Artifact } from "../protocol/artifacts";

export interface CanvasSavePayload {
  artifactId: string;
  artifact: Artifact;
  /** Store revision the user's edit is based on, when known. */
  baseRevision: string | null;
}

export type CanvasSaveHandler = (payload: CanvasSavePayload) => void | Promise<void>;

const DEFAULT_DEBOUNCE_MS = 800;

/** The per-edit callback, with `flush` to hand every pending save through now. */
export type CanvasSaver = ((artifact: Artifact) => void) & { flush: () => Promise<void> };

export function useCanvasSave(
  onSave: CanvasSaveHandler | undefined,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): CanvasSaver | null {
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const latest = useRef<Map<string, Artifact>>(new Map());
  const handler = useRef(onSave);
  handler.current = onSave;
  const enabled = Boolean(onSave);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  return useMemo(() => {
    if (!enabled) return null;
    const fire = (id: string): Promise<void> | undefined => {
      timers.current.delete(id);
      const current = latest.current.get(id);
      if (!current || !handler.current) return undefined;
      latest.current.delete(id);
      return Promise.resolve(
        handler.current({
          artifactId: current.id,
          artifact: current,
          baseRevision: typeof current.meta?.revision === "string" ? current.meta.revision : null,
        }),
      );
    };
    const save = (artifact: Artifact) => {
      latest.current.set(artifact.id, artifact);
      const existing = timers.current.get(artifact.id);
      if (existing) clearTimeout(existing);
      timers.current.set(artifact.id, setTimeout(() => void fire(artifact.id), debounceMs));
    };
    // Everything still waiting goes now — before a message starts a run
    // that may write the same files, and before a version is named.
    const flush = async () => {
      const pending = Array.from(timers.current.keys());
      pending.forEach((id) => clearTimeout(timers.current.get(id)));
      await Promise.all(pending.map((id) => fire(id) ?? Promise.resolve()));
    };
    return Object.assign(save, { flush });
  }, [enabled, debounceMs]);
}
