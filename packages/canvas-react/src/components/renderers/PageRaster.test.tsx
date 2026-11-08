import { act, useState, type ReactNode } from "react";
// @ts-expect-error — this package uses react-dom directly without its optional types.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasProvider, createCanvasStore } from "../../hooks/useCanvasStore";
import { PageRaster } from "./PageRaster";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let store = createCanvasStore();
let images: HTMLImageElement[];
let loaded = vi.fn();
let failed = vi.fn();
let capturedErrors = vi.fn();
let capturedLoads = vi.fn();

function RasterHost({ children }: { children: ReactNode }) {
  const [unavailable, setUnavailable] = useState(false);
  return <div className="cv-pages__main"
    onErrorCapture={(event) => {
      if (!(event.target instanceof HTMLImageElement)) return;
      capturedErrors(event.target, event.target.isConnected);
      setUnavailable(true);
    }}
    onLoadCapture={(event) => {
      if (!(event.target instanceof HTMLImageElement) || event.target.naturalWidth <= 0) return;
      capturedLoads(event.target, event.target.isConnected);
      setUnavailable(false);
    }}>
    <button disabled={unavailable}>Select</button>
    <div className="cv-elements__page">{children}</div>
  </div>;
}

function renderRaster(width = 1920, source = "ticket-one", scope = "document-one", loading: "eager" | "lazy" = "eager") {
  act(() => root.render(<CanvasProvider store={store}>
    <RasterHost>
    <PageRaster scope={scope} source={source} src={`/page?ticket=${source}&width=${width}`} width={width}
      alt="Slide 1" aspectRatio={16 / 9} loading={loading} onLoad={loaded} onError={failed} />
    </RasterHost>
  </CanvasProvider>));
}

function renderCopies(widths: number[], scopes: string[] = []) {
  act(() => root.render(<CanvasProvider store={store}><RasterHost>
    {widths.map((width, index) => <PageRaster key={index} scope={scopes[index] ?? "document-one"} source="ticket-one"
      src={`/page?ticket=ticket-one&width=${width}`} width={width} alt={`Copy ${index + 1}`}
      loading="eager" onLoad={loaded} onError={failed} />)}
  </RasterHost></CanvasProvider>));
}

function closeTab() {
  act(() => root.render(<CanvasProvider store={store}><RasterHost><div>Other tab</div></RasterHost></CanvasProvider>));
}

function load(image: HTMLImageElement, width = 1920, height = 1080) {
  Object.defineProperties(image, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  act(() => image.dispatchEvent(new Event("load")));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  images = [];
  vi.stubGlobal("Image", function Image() {
    const image = document.createElement("img");
    images.push(image);
    return image;
  });
  store = createCanvasStore();
  loaded = vi.fn();
  failed = vi.fn();
  capturedErrors = vi.fn();
  capturedLoads = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("holds decoded pixels through upgrade decode and reuses the actual high-water node after shrink and reopen", async () => {
  renderRaster();
  const original = images[0];
  load(original);
  renderRaster(2880);
  const upgrade = images[1];
  // This package targets ES2021, before Promise.withResolvers.
  let finishDecode!: () => void;
  upgrade.decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
  expect(host.querySelector("img")).toBe(original);
  expect(original.src).toContain("width=1920");
  expect(upgrade.isConnected).toBe(false);
  load(upgrade, 2880, 1620);
  expect(host.querySelector("img")).toBe(original);
  await act(async () => { finishDecode(); });
  expect(host.querySelector("img")).toBe(upgrade);
  expect(original.isConnected).toBe(false);
  renderRaster(1920);
  expect(host.querySelector("img")).toBe(upgrade);
  expect(upgrade.src).toContain("width=2880");
  closeTab();
  expect(upgrade.isConnected).toBe(false);
  renderRaster();
  expect(host.querySelector("img")).toBe(upgrade);
  expect(upgrade.src).toContain("width=2880");
  expect(images).toHaveLength(2);
});

it("keeps an unvisited page natively lazy without spawning detached upgrade requests", () => {
  renderRaster(1920, "ticket-one", "document-one", "lazy");
  const image = images[0];
  renderRaster(2400, "ticket-one", "document-one", "lazy");
  expect(images).toHaveLength(1);
  expect(host.querySelector("img")).toBe(image);
  expect(image.loading).toBe("lazy");
  expect(image.src).toContain("width=2400");
  load(image, 2400, 1350);
  renderRaster(2880, "ticket-one", "document-one", "lazy");
  expect(images).toHaveLength(2);
  expect(images[1].loading).toBe("eager");
  expect(host.querySelector("img")).toBe(image);
});

it("fails closed on an indistinguishable same-credential transport denial and retries without cached pixels", () => {
  renderRaster();
  const original = images[0];
  load(original);
  renderRaster(2400);
  const denied = images[1];
  act(() => denied.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")).toBeNull();
  expect(original.getAttribute("src")).toBeNull();
  expect(failed).toHaveBeenCalledOnce();
  expect(capturedErrors).toHaveBeenCalledOnce();
  expect(capturedErrors).toHaveBeenCalledWith(denied, true);
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  closeTab();
  renderRaster();
  expect(images).toHaveLength(3);
  expect(host.querySelector("img")).not.toBe(original);
  load(images[2]);
  expect(host.querySelector("img")).toBe(images[2]);
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
});

it("hands off mounted pixels on ticket renewal but never leases another ticket's cached node", () => {
  renderRaster();
  const original = images[0];
  load(original);
  renderRaster(1920, "ticket-two");
  expect(host.querySelector("img")).toBe(original);
  expect(original.src).toContain("ticket=ticket-one");
  const renewed = images[1];
  load(renewed);
  expect(host.querySelector("img")).toBe(renewed);
  expect(original.getAttribute("src")).toBeNull();
  closeTab();
  renderRaster(1920, "ticket-three");
  expect(host.querySelector("img")).not.toBe(renewed);
  expect(images).toHaveLength(3);
});

it("drops old pixels rather than masking a denied credential renewal", () => {
  renderRaster();
  const original = images[0];
  load(original);
  renderRaster(1920, "ticket-two");
  act(() => images[1].dispatchEvent(new Event("error")));
  expect(host.querySelector("img")).toBeNull();
  expect(original.getAttribute("src")).toBeNull();
  expect(failed).toHaveBeenCalledOnce();
  closeTab();
  renderRaster();
  expect(host.querySelector("img")).not.toBe(original);
});

it("immediately clears committed pixels when the source scope or ticket-presence boundary changes", () => {
  renderRaster();
  const original = images[0];
  load(original);
  renderRaster(1920, "", "document-one:no-ticket");
  expect(original.isConnected).toBe(false);
  expect(original.getAttribute("src")).toBeNull();
  expect(host.querySelector("img")).toBe(images[1]);
  load(images[1]);
  renderRaster(1920, "", "document-two:no-ticket");
  expect(images[1].isConnected).toBe(false);
  expect(host.querySelector("img")).toBe(images[2]);
});

it("ignores a superseded upgrade decode after a document change", async () => {
  renderRaster();
  load(images[0]);
  renderRaster(2880);
  const upgrade = images[1];
  let finishDecode!: () => void;
  upgrade.decode = () => new Promise<void>((resolve) => { finishDecode = resolve; });
  load(upgrade, 2880, 1620);
  renderRaster(1920, "ticket-two", "document-two");
  const current = images[2];
  await act(async () => { finishDecode(); });
  expect(host.querySelector("img")).toBe(current);
  expect(upgrade.isConnected).toBe(false);
  expect(upgrade.getAttribute("src")).toBeNull();
});

it("invalidates cached and mounted rasters on store reset and ignores late decode completion", async () => {
  renderRaster(1920, "cached");
  const cached = images[0];
  load(cached);
  closeTab();
  renderRaster();
  const original = images[1];
  load(original);
  renderRaster(2880);
  const upgrade = images[2];
  let finishDecode!: () => void;
  upgrade.decode = () => new Promise<void>((resolve) => { finishDecode = resolve; });
  load(upgrade, 2880, 1620);
  act(() => store.getState().reset());
  expect(host.querySelector("img")).toBeNull();
  expect(original.getAttribute("src")).toBeNull();
  expect(cached.getAttribute("src")).toBeNull();
  await act(async () => { finishDecode(); });
  expect(host.querySelector("img")).toBeNull();
  expect(failed).toHaveBeenCalledOnce();
  closeTab();
  renderRaster(1920, "cached");
  expect(host.querySelector("img")).not.toBe(cached);
});

it("leases cached nodes exclusively when the same page has simultaneous consumers", () => {
  renderRaster();
  const cached = images[0];
  load(cached);
  closeTab();
  act(() => root.render(<CanvasProvider store={store}>
    {[1, 2].map((id) => <PageRaster key={id} scope="document-one" source="ticket-one"
      src="/page?ticket=ticket-one&width=1920" width={1920} alt={`Slide ${id}`} loading="eager"
      onLoad={loaded} onError={failed} />)}
  </CanvasProvider>));
  const mounted = host.querySelectorAll("img");
  expect(mounted).toHaveLength(2);
  expect(mounted[0]).toBe(cached);
  expect(mounted[1]).not.toBe(cached);
  expect(images).toHaveLength(2);
});

it("bounds detached decoded nodes by page count and evicts the oldest lease", () => {
  let oldest!: HTMLImageElement;
  for (let page = 0; page < 17; page++) {
    renderRaster(1920, `page-${page}`, `scope-${page}`);
    const image = images[images.length - 1];
    if (page === 0) oldest = image;
    load(image, 100, 100);
    closeTab();
  }
  expect(oldest.getAttribute("src")).toBeNull();
  const recent = images[images.length - 1];
  renderRaster(1920, "page-16", "scope-16");
  expect(host.querySelector("img")).toBe(recent);
  closeTab();
  renderRaster(1920, "page-0", "scope-0");
  expect(host.querySelector("img")).not.toBe(oldest);
});

it("bounds detached pixel cost and does not retain a single oversized raster", () => {
  renderRaster(4000, "large-one");
  const first = images[0];
  load(first, 4000, 2500);
  closeTab();
  renderRaster(4000, "large-two");
  const second = images[1];
  load(second, 4000, 2500);
  closeTab();
  expect(first.getAttribute("src")).toBeNull();
  renderRaster(5000, "oversized");
  const oversized = images[2];
  load(oversized, 5000, 4000);
  closeTab();
  expect(oversized.getAttribute("src")).toBeNull();
  renderRaster(4000, "large-two");
  expect(host.querySelector("img")).toBe(second);
});

it("treats decode rejection as a failed request without masking denied renewal", async () => {
  renderRaster();
  const original = images[0];
  load(original);
  renderRaster(2880);
  images[1].decode = vi.fn().mockRejectedValue(new Error("decode failed"));
  load(images[1], 2880, 1620);
  await act(async () => {});
  expect(host.querySelector("img")).toBe(original);
  expect(failed).not.toHaveBeenCalled();
  renderRaster(2880, "ticket-two");
  images[2].decode = vi.fn().mockRejectedValue(new Error("renewal decode failed"));
  load(images[2], 2880, 1620);
  await act(async () => {});
  expect(host.querySelector("img")).toBeNull();
  expect(original.getAttribute("src")).toBeNull();
  expect(failed).toHaveBeenCalledOnce();
  expect(capturedErrors).toHaveBeenCalledOnce();
  expect(capturedErrors).toHaveBeenCalledWith(images[2], true);
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
});

it("ignores a late ticket decode when another renewal has superseded it", async () => {
  renderRaster();
  const original = images[0];
  load(original);
  renderRaster(1920, "ticket-two");
  const superseded = images[1];
  let finishDecode!: () => void;
  superseded.decode = () => new Promise<void>((resolve) => { finishDecode = resolve; });
  load(superseded);
  renderRaster(1920, "ticket-three");
  const current = images[2];
  await act(async () => { finishDecode(); });
  expect(host.querySelector("img")).toBe(original);
  expect(superseded.getAttribute("src")).toBeNull();
  load(current);
  expect(host.querySelector("img")).toBe(current);
  expect(failed).not.toHaveBeenCalled();
});

it("does not lease cached pixels across document scope or store boundaries", () => {
  renderRaster();
  const original = images[0];
  load(original);
  closeTab();
  renderRaster(1920, "ticket-one", "snapshot-two");
  expect(host.querySelector("img")).not.toBe(original);
  closeTab();
  store = createCanvasStore();
  renderRaster();
  expect(host.querySelector("img")).not.toBe(original);
  expect(images).toHaveLength(3);
});

it("defers visited offscreen resolution and renewal requests until the stable page wrapper approaches the viewport", () => {
  let intersect!: (visible: boolean) => void;
  let observed: Element | undefined;
  let options: IntersectionObserverInit | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void, init: IntersectionObserverInit) {
      intersect = (visible) => callback([{ isIntersecting: visible }]);
      options = init;
    }
    observe(target: Element) { observed = target; }
    disconnect = disconnect;
  });
  renderRaster(1920, "ticket-one", "document-one", "lazy");
  const original = images[0];
  load(original);
  expect(observed).toBe(host.querySelector(".cv-elements__page"));
  expect(options?.root).toBe(host.querySelector(".cv-pages__main"));
  expect(options?.rootMargin).toBe("400px 0px");
  renderRaster(2400, "ticket-one", "document-one", "lazy");
  renderRaster(2880, "ticket-one", "document-one", "lazy");
  expect(images).toHaveLength(1);
  expect(host.querySelector("img")).toBe(original);
  act(() => intersect(true));
  expect(images).toHaveLength(2);
  expect(images[1].src).toContain("width=2880");
  load(images[1], 2880, 1620);
  act(() => intersect(false));
  renderRaster(2880, "ticket-two", "document-one", "lazy");
  expect(images).toHaveLength(2);
  expect(host.querySelector("img")).toBe(images[1]);
  act(() => intersect(true));
  expect(images).toHaveLength(3);
  expect(images[2].src).toContain("ticket=ticket-two");
  closeTab();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("reports a detached renewal denial to host capture and clears unavailable state after successful retry", () => {
  renderRaster();
  load(images[0]);
  renderRaster(1920, "ticket-two");
  const denied = images[1];
  act(() => denied.dispatchEvent(new Event("error")));
  expect(capturedErrors).toHaveBeenCalledOnce();
  expect(capturedErrors).toHaveBeenCalledWith(denied, true);
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(host.querySelector("img")).toBeNull();
  closeTab();
  renderRaster(1920, "ticket-two");
  load(images[2]);
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
});

it("announces a committed detached image and a cached remount so host availability can recover", () => {
  renderRaster();
  load(images[0]);
  const thumbnail = document.createElement("img");
  host.querySelector(".cv-pages__main")!.appendChild(thumbnail);
  act(() => thumbnail.dispatchEvent(new Event("error")));
  thumbnail.remove();
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  renderRaster(1920, "ticket-two");
  const renewed = images[1];
  capturedLoads.mockClear();
  load(renewed);
  expect(capturedLoads).toHaveBeenCalledOnce();
  expect(capturedLoads).toHaveBeenCalledWith(renewed, true);
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  closeTab();
  host.querySelector(".cv-pages__main")!.appendChild(thumbnail);
  act(() => thumbnail.dispatchEvent(new Event("error")));
  thumbnail.remove();
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  capturedLoads.mockClear();
  renderRaster(1920, "ticket-two");
  expect(host.querySelector("img")).toBe(renewed);
  expect(capturedLoads).toHaveBeenCalledOnce();
  expect(capturedLoads).toHaveBeenCalledWith(renewed, true);
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  expect(images).toHaveLength(2);
});

it("revokes another active same-source lease on denial so unmount cannot repopulate the cache", () => {
  renderCopies([1920, 1920]);
  const first = images[0];
  const second = images[1];
  load(first);
  load(second);
  renderCopies([1920, 2880]);
  const denied = images[2];
  act(() => denied.dispatchEvent(new Event("error")));
  expect(host.querySelectorAll("img")).toHaveLength(0);
  expect(first.getAttribute("src")).toBeNull();
  expect(second.getAttribute("src")).toBeNull();
  expect(failed).toHaveBeenCalledTimes(2);
  expect(capturedErrors).toHaveBeenCalledWith(denied, true);
  expect(capturedErrors).toHaveBeenCalledWith(first, true);
  closeTab();
  renderRaster();
  const retry = images[3];
  expect(host.querySelector("img")).toBe(retry);
  expect(retry).not.toBe(first);
  expect(retry).not.toBe(second);
  load(retry);
  closeTab();
  renderRaster();
  expect(host.querySelector("img")).toBe(retry);
  expect(images).toHaveLength(4);
});

it("cancels a peer's in-flight decode on source denial without poisoning a fresh retry", async () => {
  renderCopies([1920, 1920]);
  load(images[0]);
  load(images[1]);
  renderCopies([2880, 2400]);
  const late = images[2];
  const denied = images[3];
  let finishDecode!: () => void;
  late.decode = () => new Promise<void>((resolve) => { finishDecode = resolve; });
  load(late, 2880, 1620);
  act(() => denied.dispatchEvent(new Event("error")));
  expect(host.querySelectorAll("img")).toHaveLength(0);
  expect(late.getAttribute("src")).toBeNull();
  expect(failed).toHaveBeenCalledTimes(2);
  closeTab();
  renderRaster();
  const retry = images[4];
  load(retry);
  await act(async () => { finishDecode(); });
  expect(host.querySelector("img")).toBe(retry);
  expect(late.isConnected).toBe(false);
  expect(loaded).toHaveBeenCalledTimes(3);
  expect(failed).toHaveBeenCalledTimes(2);
  closeTab();
  renderRaster();
  expect(host.querySelector("img")).toBe(retry);
  expect(images).toHaveLength(5);
});

it("does not revoke a different document scope sharing the same credential source", () => {
  const scopes = ["different-document", "document-one"];
  renderCopies([1920, 1920], scopes);
  const unrelated = images[0];
  load(unrelated);
  load(images[1]);
  renderCopies([1920, 2880], scopes);
  act(() => images[2].dispatchEvent(new Event("error")));
  expect(host.querySelectorAll("img")).toHaveLength(1);
  expect(host.querySelector("img")).toBe(unrelated);
  expect(failed).toHaveBeenCalledOnce();
  closeTab();
  renderRaster(1920, "ticket-one", "different-document");
  expect(host.querySelector("img")).toBe(unrelated);
  expect(images).toHaveLength(3);
});
