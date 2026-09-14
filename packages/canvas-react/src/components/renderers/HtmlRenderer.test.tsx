/**
 * A read-only host shows a page to look at: the edit toolbar is left out and
 * the frame is flagged so the inspector wires nothing but asset resolution.
 * Rendered with react-dom directly (no testing library in this package).
 */
import { act } from "react";
// @ts-expect-error — react-dom ships no types here and this package adds no
// devDependency for a single test; the runtime import is real.
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Artifact, HtmlData } from "../../protocol/artifacts";
import { createCanvasStore } from "../../store/store";
import { CanvasProvider } from "../../store/context";
import { ChromeProvider, DEFAULT_LABELS, type CanvasChrome } from "../chrome";
import { HtmlRenderer } from "./HtmlRenderer";

const page: Artifact<HtmlData> = {
  id: "dash.html",
  type: "html",
  title: "Dash",
  version: 1,
  status: "complete",
  data: { html: "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>" },
};

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function mount(
  readOnly: boolean,
  { chrome, artifact = page }: { chrome?: Partial<CanvasChrome>; artifact?: Artifact<HtmlData> } = {},
) {
  const store = createCanvasStore();
  store.getState().applyEvent({ type: "canvas.create", artifact });
  store.getState().setReadOnly(readOnly);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <CanvasProvider store={store}>
        <ChromeProvider chrome={chrome}>
          <HtmlRenderer artifact={artifact} />
        </ChromeProvider>
      </CanvasProvider>,
    ),
  );
}

describe("HtmlRenderer readOnly", () => {
  it("draws the edit toolbar and wires the inspector by default", () => {
    mount(false);
    expect(host!.querySelectorAll(".cv-html-add").length).toBeGreaterThan(0);
    expect(host!.textContent).toContain(DEFAULT_LABELS.modeCode);
    expect(host!.querySelector("iframe")?.getAttribute("srcdoc")).not.toContain("window.__LCX_READONLY=true");
  });

  it("read-only leaves out the toolbar and flags the frame", () => {
    mount(true);
    expect(host!.querySelectorAll(".cv-html-add").length).toBe(0);
    expect(host!.textContent).not.toContain(DEFAULT_LABELS.modeCode);
    expect(host!.querySelector("iframe")?.getAttribute("srcdoc")).toContain("window.__LCX_READONLY=true");
    // the device-width switch is the one control that stays
    expect(host!.querySelectorAll(".cv-html-seg button").length).toBe(3);
  });
});

describe("HtmlRenderer preview width switch", () => {
  it("a host can leave the switch out of the edit toolbar", () => {
    mount(false, { chrome: { htmlPreviewWidth: false } });
    expect(host!.querySelectorAll(".cv-html-add").length).toBeGreaterThan(0);
    expect(host!.textContent).not.toContain(DEFAULT_LABELS.viewportMobile);
    // only the design / code switch is left
    expect(host!.querySelectorAll(".cv-html-seg button").length).toBe(2);
    expect(host!.querySelector("iframe")?.style.width).toBe("100%");
  });

  it("read-only without the switch draws no toolbar at all", () => {
    mount(true, { chrome: { htmlPreviewWidth: false } });
    expect(host!.querySelector(".cv-html-bar")).toBeNull();
    expect(host!.querySelector("iframe")?.style.width).toBe("100%");
  });

  it("a read-only fixed-ratio slide draws no empty toolbar", () => {
    if (typeof ResizeObserver === "undefined") {
      vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    }
    mount(true, { artifact: { ...page, meta: { ratio: "16:9" } } });
    expect(host!.querySelector(".cv-html-bar")).toBeNull();
    expect(host!.querySelector("iframe")).not.toBeNull();
  });
});
