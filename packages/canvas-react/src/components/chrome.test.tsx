/**
 * The host's chrome seam: `labels` replaces strings, `chrome` leaves pieces
 * out, and both default to the package's own look when omitted.
 * Rendered with react-dom directly (no testing library in this package).
 */
import { act } from "react";
// @ts-expect-error — react-dom ships no types here and this package adds no
// devDependency for a single test; the runtime import is real.
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { Artifact, FileData } from "../protocol/artifacts";
import { createCanvasStore } from "../store/store";
import { CanvasProvider } from "../store/context";
import { Canvas } from "./Canvas";
import { ChromeProvider, DEFAULT_LABELS } from "./chrome";
import { FileRenderer } from "./renderers/FileRenderer";

const doc: Artifact = {
  id: "report.md",
  type: "document",
  title: "Report",
  version: 1,
  status: "complete",
  data: { content: "# Hello" },
};

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(ui: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
}

function storeWith(artifact: Artifact) {
  const store = createCanvasStore();
  store.getState().applyEvent({ type: "canvas.create", artifact });
  return store;
}

describe("Canvas labels + chrome", () => {
  it("renders the package's own strings when nothing is passed", () => {
    mount(
      <CanvasProvider store={storeWith(doc)}>
        <Canvas />
      </CanvasProvider>,
    );
    expect(host!.querySelector(".cv-badge")?.textContent).toBe(DEFAULT_LABELS.statusReady);
    expect(host!.querySelector(".cv-export__btn")?.textContent).toBe(DEFAULT_LABELS.exportMenu);
  });

  it("swaps only the strings the host overrides", () => {
    mount(
      <CanvasProvider store={storeWith(doc)}>
        <Canvas labels={{ statusReady: "준비됨", exportMenu: "내보내기" }} />
      </CanvasProvider>,
    );
    expect(host!.querySelector(".cv-badge")?.textContent).toBe("준비됨");
    expect(host!.querySelector(".cv-export__btn")?.textContent).toBe("내보내기");
    // an un-overridden label keeps its default
    expect(host!.querySelector(".cv-undo button")?.getAttribute("title")).toBe(DEFAULT_LABELS.undo);
  });

  it("leaves out the chrome the host turns off", () => {
    mount(
      <CanvasProvider store={storeWith(doc)}>
        <Canvas chrome={{ statusBadge: false, exportMenu: false, undoRedo: false }} />
      </CanvasProvider>,
    );
    expect(host!.querySelector(".cv-header")).not.toBeNull(); // header itself stays
    expect(host!.querySelector(".cv-badge")).toBeNull();
    expect(host!.querySelector(".cv-export")).toBeNull();
    expect(host!.querySelector(".cv-undo")).toBeNull();
  });

  it("leaves out a file card's download link when the host has its own door", () => {
    const upload: Artifact<FileData> = {
      id: "sources/scan.pdf",
      type: "file",
      title: "scan.pdf",
      version: 1,
      status: "complete",
      data: { path: "sources/scan.pdf", name: "scan.pdf", mediaType: "application/pdf", size: 12 },
    };
    const store = storeWith(upload);
    store.getState().setAssetBaseUrl("http://host/file?path=");
    // The built-in renderer is lazy inside <Canvas>; render it directly.
    mount(
      <CanvasProvider store={store}>
        <ChromeProvider chrome={{ fileDownload: false }}>
          <FileRenderer artifact={upload} />
        </ChromeProvider>
      </CanvasProvider>,
    );
    expect(host!.querySelector(".cv-file__card b")?.textContent).toBe("scan.pdf");
    expect(host!.querySelector(".cv-file__download")).toBeNull();
  });

  it("drops the whole header when asked", () => {
    mount(
      <CanvasProvider store={storeWith(doc)}>
        <Canvas chrome={{ header: false }} />
      </CanvasProvider>,
    );
    expect(host!.querySelector(".cv-header")).toBeNull();
    expect(host!.querySelector(".cv-body")).not.toBeNull(); // the artifact still renders
  });

  it("publishes the rendered-HTML getter for a host-drawn export control", () => {
    const store = storeWith(doc);
    mount(
      <CanvasProvider store={store}>
        <Canvas chrome={{ exportMenu: false }} />
      </CanvasProvider>,
    );
    const getter = store.getState().renderedHtml;
    expect(typeof getter).toBe("function");
    // The body is on screen (the lazy renderer may still be loading in jsdom),
    // so the getter returns markup rather than null.
    expect(typeof getter!()).toBe("string");
  });
});
