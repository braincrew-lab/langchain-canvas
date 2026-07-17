/**
 * `useCanvasImport` — open local files onto the canvas.
 *
 * Turns a `File` (from a file picker or a drag-and-drop) into canvas events and
 * applies them through the store, so the imported document/sheet/page becomes a
 * first-class artifact you can edit and re-export. Returns the id of the last
 * artifact created so callers can focus it.
 */

import { useCallback } from "react";

import { canImport, importFile } from "../io/importers";
import { useCanvasStoreApi } from "./useCanvasStore";

export function useCanvasImport() {
  const api = useCanvasStoreApi();

  const importFiles = useCallback(
    async (files: Iterable<File>): Promise<string | null> => {
      let lastId: string | null = null;
      for (const file of files) {
        if (!canImport(file)) continue;
        try {
          const events = await importFile(file);
          api.getState().applyEvents(events);
          const created = events.find((e) => e.type === "canvas.create");
          if (created && created.type === "canvas.create") {
            lastId = created.artifact.id;
            api.getState().setActiveArtifact(lastId);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[langchain-canvas] import failed:", file.name, err);
        }
      }
      return lastId;
    },
    [api],
  );

  return { importFiles, canImport };
}
