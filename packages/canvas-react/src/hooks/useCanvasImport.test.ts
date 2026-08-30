import React, { act, type ReactNode } from "react";
// @ts-expect-error -- @types/react-dom is not installed in this package; runtime module exists
import { createRoot as createRootUntyped } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasProvider } from "../store/context";
import { createCanvasStore, type CanvasStore } from "../store/store";
import type { StoreApi } from "zustand/vanilla";
import type { Artifact } from "../protocol/artifacts";
import { useCanvasImport, type CanvasImportOptions } from "./useCanvasImport";

/** Minimal typed surface of the react-dom/client `Root` handle — @types/react-dom
 *  isn't a devDependency of this package (see the @ts-expect-error above), so the
 *  raw import resolves to `any`; this local type restores type safety for callers. */
type Root = { render(node: ReactNode): void; unmount(): void };
const createRoot = createRootUntyped as (container: Element) => Root;

// React's act() warns unless this is set — see React 19 test-environment docs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's File doesn't implement the Blob read methods, so back them with the body
// (mirrors src/io/importers.test.ts:6-10).
const file = (name: string, body: string): File =>
  Object.assign(new File([body], name, { type: "text/plain" }), {
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }) as File;

type ImportFiles = ReturnType<typeof useCanvasImport>["importFiles"];

/** Renders `useCanvasImport` inside a real `CanvasProvider` and hands the caller
 *  its `importFiles` function via a mutable capture ref, so the test can invoke
 *  the hook's behavior without any React Testing Library dependency. */
function HookHarness({
  options,
  captured,
}: {
  options: CanvasImportOptions;
  captured: { importFiles: ImportFiles | null };
}): null {
  const { importFiles } = useCanvasImport(options);
  captured.importFiles = importFiles;
  return null;
}

interface Harness {
  store: StoreApi<CanvasStore>;
  captured: { importFiles: ImportFiles | null };
  onImported: ReturnType<typeof vi.fn>;
  onImportError: ReturnType<typeof vi.fn>;
  root: Root;
  container: HTMLDivElement;
}

function mountHarness(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const store = createCanvasStore();
  const captured: { importFiles: ImportFiles | null } = { importFiles: null };
  const onImported = vi.fn();
  const onImportError = vi.fn();

  act(() => {
    root.render(
      React.createElement(CanvasProvider, {
        store,
        children: React.createElement(HookHarness, { options: { onImported, onImportError }, captured }),
      }),
    );
  });

  return { store, captured, onImported, onImportError, root, container };
}

function unmountHarness(harness: Harness): void {
  act(() => {
    harness.root.unmount();
  });
  harness.container.remove();
}

describe("useCanvasImport", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) unmountHarness(harness);
  });

  it("reports an unsupported extension via onImportError without importing", async () => {
    harness = mountHarness();
    const badFile = file("a.png", "not-an-image");

    let result: string | null = null;
    await act(async () => {
      result = await harness.captured.importFiles!([badFile]);
    });

    expect(result).toBeNull();
    expect(harness.onImported).not.toHaveBeenCalled();
    expect(harness.onImportError).toHaveBeenCalledTimes(1);
    const [calledFile, calledError] = harness.onImportError.mock.calls[0] as [File, Error];
    expect(calledFile).toBe(badFile);
    expect(calledError).toBeInstanceOf(Error);
    expect(calledError.message).toMatch(/Unsupported/);
  });

  it("reports an importer throw (legacy deck JSON) via onImportError without importing", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    harness = mountHarness();
    const legacyDeckJson = file(
      "old.json",
      JSON.stringify({ type: "slides", data: { slides: [] } }),
    );

    let result: string | null = null;
    await act(async () => {
      result = await harness.captured.importFiles!([legacyDeckJson]);
    });

    expect(result).toBeNull();
    expect(harness.onImported).not.toHaveBeenCalled();
    expect(harness.onImportError).toHaveBeenCalledTimes(1);
    const [calledFile, calledError] = harness.onImportError.mock.calls[0] as [File, Error];
    expect(calledFile).toBe(legacyDeckJson);
    expect(calledError).toBeInstanceOf(Error);
    expect(calledError.message).toMatch(/Legacy slide deck JSON/);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("imports a supported file, calls onImported once, and activates the artifact", async () => {
    harness = mountHarness();
    const notesFile = file("notes.md", "# Notes\n\nHello.");

    let result: string | null = null;
    await act(async () => {
      result = await harness.captured.importFiles!([notesFile]);
    });

    expect(harness.onImportError).not.toHaveBeenCalled();
    expect(harness.onImported).toHaveBeenCalledTimes(1);
    const [calledArtifact, calledFile] = harness.onImported.mock.calls[0] as [Artifact, File];
    expect(calledArtifact.type).toBe("document");
    expect(calledFile).toBe(notesFile);
    expect(result).toBe(calledArtifact.id);
    expect(harness.store.getState().canvas.activeId).toBe(calledArtifact.id);
  });
});
