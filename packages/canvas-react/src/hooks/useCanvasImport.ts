/**
 * `useCanvasImport` — open local files onto the canvas.
 *
 * Turns a `File` (from a file picker or a drag-and-drop) into canvas events and
 * applies them through the store, so the imported document/sheet/page becomes a
 * first-class artifact you can edit and re-export. Returns the id of the last
 * artifact created so callers can focus it.
 */

import { useCallback, useRef } from "react";

import type { Artifact } from "../protocol/artifacts";
import { canImport, importFile } from "../io/importers";
import { useCanvasStoreApi } from "./useCanvasStore";

export interface CanvasImportOptions {
  /**
   * Fired once per successfully imported file with the artifact that now
   * renders on the canvas — the hook for a host to persist an imported
   * table/document to its store right away.
   */
  onImported?: (artifact: Artifact, file: File) => void;
  /**
   * Fired once per file that could not be imported — either an unsupported
   * extension or a parse/validation failure thrown by `importFile`.
   */
  onImportError?: (file: File, error: Error) => void;
}

export function useCanvasImport({ onImported, onImportError }: CanvasImportOptions = {}) {
  const api = useCanvasStoreApi();
  const imported = useRef(onImported);
  imported.current = onImported;
  const importError = useRef(onImportError);
  importError.current = onImportError;

  const importFiles = useCallback(
    async (files: Iterable<File>): Promise<string | null> => {
      let lastId: string | null = null;
      for (const file of files) {
        if (!canImport(file)) {
          importError.current?.(file, new Error(`Unsupported file type "${file.name}"`));
          continue;
        }
        try {
          const events = await importFile(file);
          api.getState().applyEvents(events);
          const created = events.find((e) => e.type === "canvas.create");
          if (created && created.type === "canvas.create") {
            lastId = created.artifact.id;
            api.getState().setActiveArtifact(lastId);
            imported.current?.(created.artifact, file);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[langchain-canvas] import failed:", file.name, err);
          importError.current?.(file, err instanceof Error ? err : new Error(String(err)));
        }
      }
      return lastId;
    },
    [api],
  );

  return { importFiles, canImport };
}
