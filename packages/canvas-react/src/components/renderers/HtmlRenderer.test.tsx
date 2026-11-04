/**
 * A read-only host shows a page to look at: the edit toolbar is left out and
 * the frame is flagged so selection and editing remain disabled.
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
  {
    chrome,
    artifact = page,
    assetBaseUrl,
  }: { chrome?: Partial<CanvasChrome>; artifact?: Artifact<HtmlData>; assetBaseUrl?: string } = {},
) {
  const store = createCanvasStore();
  store.getState().applyEvent({ type: "canvas.create", artifact });
  store.getState().setReadOnly(readOnly);
  if (assetBaseUrl !== undefined) store.getState().setAssetBaseUrl(assetBaseUrl);
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
  return store;
}

describe("HtmlRenderer readOnly", () => {
  it("draws the edit toolbar by default", () => {
    mount(false);
    expect(host!.querySelectorAll(".cv-html-add").length).toBeGreaterThan(0);
    expect(host!.textContent).toContain(DEFAULT_LABELS.modeCode);
  });

  it("read-only leaves out editing controls", () => {
    mount(true);
    expect(host!.querySelectorAll(".cv-html-add").length).toBe(0);
    expect(host!.textContent).not.toContain(DEFAULT_LABELS.modeCode);
    // the device-width switch is the one control that stays
    expect(host!.querySelectorAll(".cv-html-seg button").length).toBe(3);
  });
});

describe("HtmlRenderer iframe sandbox", () => {
  it("is allow-scripts only on the non-slide (web page) iframe", () => {
    mount(false);
    expect(host!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("is allow-scripts only on the fixed-aspect slide iframe", () => {
    if (typeof ResizeObserver === "undefined") {
      vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    }
    mount(false, { artifact: { ...page, meta: { ratio: "16:9" } } });
    expect(host!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  });
});

describe("HtmlRenderer srcDoc CSP", () => {
  it("carries a meta CSP as the first head element, independent of any route or parent CSP", () => {
    mount(false);
    const srcDoc = host!.querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(srcDoc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    const doc = new DOMParser().parseFromString(srcDoc, "text/html");
    const meta = doc.head?.firstElementChild;
    expect(meta?.tagName.toLowerCase()).toBe("meta");
    expect(meta?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(meta?.getAttribute("content")).not.toContain("connect-src");
  });

  function contentOf(host: HTMLDivElement): string {
    const srcDoc = host.querySelector("iframe")!.getAttribute("srcdoc")!;
    const doc = new DOMParser().parseFromString(srcDoc, "text/html");
    return doc.head!.firstElementChild!.getAttribute("content")!;
  }

  it("allows an absolute asset base URL's own origin, derived automatically (no assetOrigins prop path exists)", () => {
    mount(false, { assetBaseUrl: "https://cdn.example.com/files/" });
    const content = contentOf(host!);
    expect(content).toContain("https://cdn.example.com");
    expect(content).not.toContain("connect-src");
  });

  it("resolves a relative asset base URL to the parent page's origin, not the opaque srcDoc iframe origin", () => {
    mount(false, { assetBaseUrl: "/api/canvas/files/" });
    const content = contentOf(host!);
    expect(content).toContain(window.location.origin);
    expect(content).not.toContain("connect-src");
  });

  it("omits any asset origin when no asset base URL is configured", () => {
    mount(false);
    const content = contentOf(host!);
    expect(content).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'");
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

it("rejects frame edits in read-only mode and forwards Escape only from its own frame", () => {
  const store = mount(true);
  const frame = host!.querySelector("iframe")!;
  const edited = vi.fn();
  store.getState().setOnUserEdit(edited);
  const keys: string[] = [];
  host!.addEventListener("keydown", (event) => keys.push(event.key));
  act(() => window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow,
    data: { source: "langchain-canvas", type: "doc_edit", html: "<p>Changed</p>" },
  })));
  expect(store.getState().canvas.artifacts[page.id].data).toEqual(page.data);
  expect(edited).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new MessageEvent("message", {
    source: window,
    data: { source: "langchain-canvas", type: "viewer_escape" },
  })));
  expect(keys).toEqual([]);
  act(() => window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow,
    data: { source: "langchain-canvas", type: "viewer_escape" },
  })));
  expect(keys).toEqual(["Escape"]);
});
