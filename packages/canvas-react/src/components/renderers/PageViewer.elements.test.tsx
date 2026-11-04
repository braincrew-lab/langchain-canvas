import { act } from "react";
// @ts-expect-error — react-dom is a peer dependency without optional types here.
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasProvider, createCanvasStore } from "../../hooks/useCanvasStore";
import { ElementSelectionContext } from "../../hooks/elementSelection";
import type { CanvasElement, CanvasElementCollection, CanvasElementLoadRequest, CanvasElementSelectionProps } from "../../protocol/elements";
import { PageViewer } from "./PageViewer";

let host: HTMLDivElement;
let root: Root;
let store = createCanvasStore();
const element: CanvasElement = { id: "shape-3", kind: "shape", label: "Revenue", page: 1,
  bounds: { x: .1, y: .2, width: .3, height: .4 }, locator: { slide_index: 0, shape_id: 3 } };
const collection = (path = "slides.pptx", revision = "r1", elements = [element]): CanvasElementCollection => ({
  path, revision, blob_sha256: "abc", elements,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  store = createCanvasStore();
  store.getState().setReadOnly(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(options: CanvasElementSelectionProps, path = "slides.pptx", revision: string | undefined = "r1") {
  await act(async () => root.render(<CanvasProvider store={store}>
    <ElementSelectionContext.Provider value={options}>
      <PageViewer path={path} name={path} pageCount={2} pageBaseUrl="/page?path=" version={revision} revision={revision} />
    </ElementSelectionContext.Provider>
  </CanvasProvider>));
}
function loadImage() {
  const image = host.querySelector<HTMLImageElement>(".cv-pages__page")!;
  Object.defineProperties(image, { naturalWidth: { value: 1600, configurable: true }, naturalHeight: { value: 900, configurable: true } });
  act(() => image.dispatchEvent(new Event("load")));
}

it("leaves existing readonly rendering unchanged until explicitly enabled", async () => {
  const loadElements = vi.fn(async () => collection());
  await render({ loadElements, onAddElement: vi.fn() });
  loadImage();
  expect(loadElements).not.toHaveBeenCalled();
  expect(host.querySelector(".cv-elements__target")).toBeNull();
  expect(host.querySelector(".cv-elements__status")).toBeNull();
  expect(store.getState().readOnly).toBe(true);
});

it("stages the exact source target with normalized bounds and controlled feedback", async () => {
  const loadElements = vi.fn(async () => collection());
  const onAddElement = vi.fn();
  await render({ selectionMode: "elements", loadElements, onAddElement });
  expect(host.querySelector(".cv-elements__target")).toBeNull();
  loadImage();
  const target = host.querySelector<HTMLButtonElement>(".cv-elements__target")!;
  expect(target.style.left).toBe("10%");
  expect(target.style.top).toBe("20%");
  expect(target.style.width).toBe("30%");
  expect(target.style.height).toBe("40%");
  expect(target.tabIndex).toBe(0);
  act(() => { target.focus(); target.click(); });
  expect(document.activeElement).toBe(target);
  const reference = { path: "slides.pptx", revision: "r1", element_id: "shape-3" };
  expect(onAddElement).toHaveBeenCalledWith(reference, element);
  expect(onAddElement.mock.calls[0][1]).not.toBe(element);
  expect(onAddElement.mock.calls[0][1].locator).not.toBe(element.locator);
  await render({ selectionMode: "elements", loadElements, onAddElement, selectedElements: [reference] });
  expect(target.getAttribute("aria-pressed")).toBe("true");
  expect(store.getState().readOnly).toBe(true);
  expect(store.getState().selections).toEqual([]);
});

it("never stages targets when the host removes its callback", async () => {
  await render({ selectionMode: "elements", loadElements: async () => collection() });
  loadImage();
  expect(host.querySelector<HTMLButtonElement>(".cv-elements__target")!.disabled).toBe(true);
});

it("shows loader failures, empty metadata and unsupported reasons", async () => {
  await render({ selectionMode: "elements", loadElements: async () => { throw new Error("network"); } });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  await render({ selectionMode: "elements", loadElements: async () => collection("slides.pptx", "r1", []) });
  expect(host.textContent).toContain("No selectable elements");
  await render({ selectionMode: "elements", loadElements: async () => ({ ...collection("slides.pptx", "r1", []), unsupported_reason: "Ambiguous source mapping" }) });
  expect(host.textContent).toContain("Ambiguous source mapping");
});

it("does not request metadata without an authoritative revision", async () => {
  const loadElements = vi.fn(async () => collection());
  await render({ selectionMode: "elements", loadElements }, "slides.pptx", "");
  expect(loadElements).not.toHaveBeenCalled();
  expect(host.textContent).toContain("unavailable");
});

it("rejects metadata for another revision and invalid or ambiguous geometry", async () => {
  await render({ selectionMode: "elements", loadElements: async () => collection("slides.pptx", "old") });
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await render({ selectionMode: "elements", loadElements: async () => collection("slides.pptx", "r1", [
    element, { ...element, locator: { shape_id: 99 } }, { ...element, id: "outside", bounds: { x: .9, y: 0, width: .2, height: .1 } },
  ]) });
  loadImage();
  expect(host.querySelectorAll(".cv-elements__target")).toHaveLength(0);
  expect(host.textContent).toContain("cannot be mapped safely");
});

it("aborts cross-file requests and discards their late results even if the loader ignores abort", async () => {
  // ES2021 / Node 20 is the package's supported baseline (no withResolvers).
  let resolveOld!: (value: CanvasElementCollection) => void;
  const pending = new Promise<CanvasElementCollection>((resolve) => { resolveOld = resolve; });
  let oldSignal!: AbortSignal;
  const loadElements = vi.fn(({ path, signal }: CanvasElementLoadRequest) => {
    if (path === "slides.pptx") {
      oldSignal = signal;
      return pending;
    }
    return Promise.resolve(collection(path, "r1", [{ ...element, id: "new", label: "New target" }]));
  });
  await render({ selectionMode: "elements", loadElements, onAddElement: vi.fn() });
  expect(host.textContent).toContain("Loading selectable");
  await render({ selectionMode: "elements", loadElements, onAddElement: vi.fn() }, "other.docx");
  expect(oldSignal.aborted).toBe(true);
  await act(async () => resolveOld(collection()));
  loadImage();
  const targets = host.querySelectorAll(".cv-elements__target");
  expect(targets).toHaveLength(1);
  expect(targets[0].getAttribute("aria-label")).toContain("New target");
});

it("renders repeated source elements across pages without changing their attachment identity", async () => {
  const onAddElement = vi.fn();
  await render({ selectionMode: "elements", onAddElement, loadElements: async () => collection("slides.pptx", "r1", [
    element, { ...element, page: 2 },
  ]) });
  for (const image of host.querySelectorAll<HTMLImageElement>(".cv-pages__page")) {
    Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 } });
    act(() => image.dispatchEvent(new Event("load")));
  }
  const targets = host.querySelectorAll<HTMLButtonElement>(".cv-elements__target");
  expect(targets).toHaveLength(2);
  act(() => { targets[0].click(); targets[1].click(); });
  expect(onAddElement.mock.calls[0][0]).toEqual(onAddElement.mock.calls[1][0]);
});
