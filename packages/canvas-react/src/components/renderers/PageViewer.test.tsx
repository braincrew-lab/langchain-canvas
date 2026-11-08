import { act, StrictMode } from "react";
// @ts-expect-error — this package uses react-dom directly without its optional types.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasProvider, createCanvasStore } from "../../hooks/useCanvasStore";
import { PageViewer, type PageViewerProps } from "./PageViewer";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let viewport: HTMLDivElement;
let notifyResize: () => void;
let store = createCanvasStore();
let createdImages: HTMLImageElement[];

function renderViewer(path = "slides.pptx", version: number | string = 1, props: Partial<PageViewerProps> = {}) {
  act(() => root.render(<CanvasProvider store={store}><PageViewer path={path} name={path} pageCount={8} pageBaseUrl="/page?path=" version={version} {...props} /></CanvasProvider>));
}

function loadPage(image: HTMLImageElement, width: number, height: number) {
  Object.defineProperties(image, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  act(() => image.dispatchEvent(new Event("load")));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  createdImages = [];
  vi.stubGlobal("Image", function Image() {
    const image = document.createElement("img");
    createdImages.push(image);
    return image;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  store = createCanvasStore();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { notifyResize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  renderViewer();
  viewport = host.querySelector<HTMLDivElement>(".cv-pages__main")!;
  Object.defineProperties(viewport, { clientHeight: { value: 600, configurable: true }, scrollHeight: { value: 1640, configurable: true } });
  viewport.scrollTo = (options: ScrollToOptions | number = {}, y: number = 0) => {
    viewport.scrollTop = typeof options === "number" ? y : options.top ?? 0;
  };
  host.querySelectorAll(".cv-pages__sheet").forEach((page, index) => {
    Object.defineProperty(page, "offsetTop", { value: 24 + index * 200, configurable: true });
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps the final short slide selected when the viewport clamps at the bottom", () => {
  viewport.scrollTop = 1040;
  act(() => {
    viewport.dispatchEvent(new Event("scroll"));
    vi.runAllTimers();
  });
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("8 / 8");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.disabled).toBe(true);
});

it("leaves vertical reading keys native while retaining explicit page navigation", () => {
  for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp"]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => viewport.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
  act(() => viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("2 / 8");
  expect(viewport.scrollTop).toBe(200);
});

it("keeps the selected page across baseline zoom steps and fit restoration", () => {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="4 / 8"]')!.click());
  viewport.scrollLeft = 180;
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  expect(host.querySelector(".cv-pages__percentage")?.textContent).toBe("100%");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
  expect(host.querySelector(".cv-pages__percentage")?.textContent).toBe("110%");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
  expect(host.querySelector(".cv-pages__percentage")?.textContent).toBe("100%");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Fit width"]')!.click());
  expect(host.querySelector('[aria-label="Fit width"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("4 / 8");
  expect(viewport.scrollLeft).toBe(180);
});

it("does not advance past a selected slide shorter than the viewport tracking inset", () => {
  host.querySelectorAll(".cv-pages__sheet").forEach((page, index) => {
    Object.defineProperty(page, "offsetTop", { value: 24 + index * 100 });
  });
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="3 / 8"]')!.click());
  act(() => {
    viewport.dispatchEvent(new Event("scroll"));
    vi.runAllTimers();
  });
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("3 / 8");
});

it("allows horizontal arrow keys to pan a zoomed page instead of changing pages", () => {
  Object.defineProperties(viewport, { clientWidth: { value: 320 }, scrollWidth: { value: 800 } });
  const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  act(() => viewport.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("1 / 8");
});

it("keeps the selected page when scroll tracking runs before resize re-anchoring", () => {
  let width = 320;
  Object.defineProperty(viewport, "clientWidth", { get: () => width });
  act(() => { notifyResize(); vi.runAllTimers(); });
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="3 / 8"]')!.click());
  width = 1000;
  Object.defineProperty(viewport, "scrollHeight", { value: 8000 });
  host.querySelectorAll(".cv-pages__sheet").forEach((page, index) => {
    Object.defineProperty(page, "offsetTop", { value: 24 + index * 800 });
  });
  act(() => {
    viewport.dispatchEvent(new Event("scroll"));
    vi.runAllTimers();
  });
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("3 / 8");
  act(() => { notifyResize(); vi.runAllTimers(); });
  expect(viewport.scrollTop).toBe(1600);
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("3 / 8");
});

it("requests enough raster pixels after device density changes without changing pages", () => {
  Object.defineProperty(viewport, "clientWidth", { value: 1100 });
  viewport.style.padding = "24px";
  act(() => { notifyResize(); vi.runAllTimers(); });
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Fit width"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="3 / 8"]')!.click());
  vi.stubGlobal("devicePixelRatio", 2);
  act(() => window.dispatchEvent(new Event("resize")));
  const image = host.querySelectorAll<HTMLImageElement>(".cv-pages__page")[2];
  expect(new URL(image.src).searchParams.get("width")).toBe("2880");
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("3 / 8");
});

it("uses the viewport padding when navigating narrow fitted pages", () => {
  viewport.style.paddingTop = "16px";
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="3 / 8"]')!.click());
  expect(viewport.scrollTop).toBe(408);
  act(() => { viewport.dispatchEvent(new Event("scroll")); vi.runAllTimers(); });
  expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("3 / 8");
});

it("defaults slides to whole-page fit and Word to width fit", () => {
  expect(host.querySelector('[aria-label="Fit whole page"]')?.getAttribute("aria-pressed")).toBe("true");
  renderViewer("report.docx");
  expect(host.querySelector('[aria-label="Fit width"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("Page 1");
});

it("uses each loaded slide's aspect ratio and available height for whole-page fit", () => {
  viewport.style.padding = "24px";
  act(() => notifyResize());
  const images = host.querySelectorAll<HTMLImageElement>(".cv-pages__page");
  Object.defineProperties(images[0], { naturalWidth: { value: 1200 }, naturalHeight: { value: 1600 } });
  Object.defineProperties(images[1], { naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 } });
  act(() => {
    images[0].dispatchEvent(new Event("load"));
    images[1].dispatchEvent(new Event("load"));
  });
  const sheets = host.querySelectorAll<HTMLElement>(".cv-pages__sheet");
  expect(Number.parseFloat(sheets[0].style.width)).toBe(414);
  expect(Number.parseFloat(sheets[1].style.width)).toBe(736);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Fit width"]')!.click());
  expect(Number.parseFloat(sheets[0].style.width)).toBe(952);
});

it("keeps the first valid per-page ratio when rounded raster dimensions change", () => {
  const images = host.querySelectorAll<HTMLImageElement>(".cv-pages__page");
  loadPage(images[0], 0, 1600);
  expect(images[0].style.aspectRatio).toBe("");
  loadPage(images[0], 1200, 1600);
  loadPage(images[1], 1600, 1200);
  const sheet = host.querySelector<HTMLElement>(".cv-pages__sheet")!;
  const width = sheet.style.width;
  const source = images[0].src;
  viewport.scrollTop = 350;
  viewport.scrollLeft = 90;
  loadPage(images[0], 1201, 1600);
  loadPage(images[1], 2400, 1801);
  expect(images[0].style.aspectRatio).toBe("0.75");
  expect(images[1].style.aspectRatio).toBe(String(4 / 3));
  expect(sheet.style.width).toBe(width);
  expect(images[0].src).toBe(source);
  expect(viewport.scrollTop).toBe(350);
  expect(viewport.scrollLeft).toBe(90);
});

it("preserves reading DOM, focus and position while rotating only the page ticket", () => {
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=first&path=" });
  const image = host.querySelector<HTMLImageElement>(".cv-pages__page")!;
  const sheet = host.querySelector<HTMLElement>(".cv-pages__sheet")!;
  loadPage(image, 1200, 1600);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="4 / 8"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Thumbnails"]')!.click());
  viewport.scrollTop = 650;
  viewport.scrollLeft = 120;
  viewport.focus();
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=second&path=" });
  expect(host.querySelector(".cv-pages__main")).toBe(viewport);
  expect(host.querySelector(".cv-pages__sheet")).toBe(sheet);
  expect(host.querySelector(".cv-pages__page")).toBe(image);
  expect(new URL(image.src).searchParams.get("ticket")).toBe("first");
  const renewal = createdImages.find((candidate) => candidate.src.includes("ticket=second") && candidate.src.includes("page=1&"))!;
  loadPage(renewal, 1200, 1600);
  expect(host.querySelector(".cv-pages__page")).toBe(renewal);
  expect(new URL(renewal.src).searchParams.get("ticket")).toBe("second");
  expect(document.activeElement).toBe(viewport);
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("4 / 8");
  expect(host.querySelector(".cv-pages__percentage")?.textContent).toBe("100%");
  expect(host.querySelector(".cv-pages__rail")).toBeNull();
  expect(viewport.scrollTop).toBe(650);
  expect(viewport.scrollLeft).toBe(120);
  expect(renewal.style.aspectRatio).toBe("0.75");
});

it("clears committed pixels immediately when a page ticket is removed", () => {
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=first&path=" });
  const image = host.querySelector<HTMLImageElement>(".cv-pages__page")!;
  loadPage(image, 1200, 1600);
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?path=" });
  expect(host.querySelector(".cv-pages__main")).toBe(viewport);
  expect(host.querySelector(".cv-pages__page")).not.toBe(image);
  expect(image.isConnected).toBe(false);
  expect(image.getAttribute("src")).toBeNull();
});

it("restores learned ratios before images load on a tab remount with a renewed ticket", () => {
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=first&path=" });
  const image = host.querySelector<HTMLImageElement>(".cv-pages__page")!;
  loadPage(image, 1200, 1600);
  const width = host.querySelector<HTMLElement>(".cv-pages__sheet")!.style.width;
  act(() => root.render(<CanvasProvider store={store}><div>Other tab</div></CanvasProvider>));
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=second&path=" });
  const restored = host.querySelector<HTMLImageElement>(".cv-pages__page")!;
  expect(restored).not.toBe(image);
  expect(restored.style.aspectRatio).toBe("0.75");
  expect(host.querySelector<HTMLElement>(".cv-pages__sheet")!.style.width).toBe(width);
  loadPage(restored, 1201, 1600);
  expect(restored.style.aspectRatio).toBe("0.75");
  act(() => root.render(<CanvasProvider store={store}><div>Other tab</div></CanvasProvider>));
  store = createCanvasStore();
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=second&path=" });
  expect(host.querySelector<HTMLImageElement>(".cv-pages__page")!.style.aspectRatio).toBe("");
});

it("replaces mounted reading DOM and layout state when the provider store changes", () => {
  const image = host.querySelector<HTMLImageElement>(".cv-pages__page")!;
  loadPage(image, 1200, 1600);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="4 / 8"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  viewport.scrollTop = 650;
  viewport.scrollLeft = 120;
  store = createCanvasStore();
  renderViewer();
  const next = host.querySelector<HTMLDivElement>(".cv-pages__main")!;
  expect(next).not.toBe(viewport);
  expect(viewport.isConnected).toBe(false);
  expect(image.isConnected).toBe(false);
  expect(next.scrollTop).toBe(0);
  expect(next.scrollLeft).toBe(0);
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("1 / 8");
  expect(host.querySelector('[aria-label="Fit whole page"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector<HTMLImageElement>(".cv-pages__page")!.style.aspectRatio).toBe("");
});

it("retries failed pages on a new ticket without replacing healthy pages or reading state", () => {
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=first&path=" });
  const images = host.querySelectorAll<HTMLImageElement>(".cv-pages__page");
  loadPage(images[0], 1200, 1600);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="4 / 8"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  act(() => images[0].dispatchEvent(new Event("error")));
  expect(host.querySelector(".cv-pages__error")).not.toBeNull();
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=first&path=" });
  expect(host.querySelector(".cv-pages__error")).not.toBeNull();
  viewport.scrollTop = 650;
  viewport.scrollLeft = 120;
  renderViewer("slides.pptx", 1, { pageBaseUrl: "/page?ticket=second&path=" });
  expect(host.querySelector(".cv-pages__error")).toBeNull();
  expect(host.querySelector(".cv-pages__main")).toBe(viewport);
  const renewed = host.querySelectorAll<HTMLImageElement>(".cv-pages__page");
  expect(renewed[1]).toBe(images[1]);
  expect(new URL(renewed[0].src).searchParams.get("ticket")).toBe("second");
  expect(renewed[0].style.aspectRatio).toBe("0.75");
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("4 / 8");
  expect(host.querySelector(".cv-pages__percentage")?.textContent).toBe("100%");
  expect(viewport.scrollTop).toBe(650);
  expect(viewport.scrollLeft).toBe(120);
  act(() => renewed[0].dispatchEvent(new Event("error")));
  expect(host.querySelector(".cv-pages__error")).not.toBeNull();
});

it.each([
  ["origin", "https://first.example", "https://second.example"],
  ["endpoint", "/threads/one/page", "/threads/one/preview"],
  ["thread", "/threads/one/", "/threads/two/"],
  ["snapshot", "snapshot=s1", "snapshot=s2"],
  ["URL revision", "revision=r1", "revision=r2"],
  ["general auth", "auth=a1", "auth=a2"],
  ["token", "token=t1", "token=t2"],
  ["access token", "access_token=b1", "access_token=b2"],
  ["other query field", "variant=preview", "variant=original"],
])("resets reading state and ratios when the semantic source %s changes", (_label, from, to) => {
  const pageBaseUrl = "https://first.example/threads/one/page?ticket=first&snapshot=s1&revision=r1&auth=a1&token=t1&access_token=b1&variant=preview&path=";
  renderViewer("slides.pptx", 1, { pageBaseUrl });
  const previous = host.querySelector<HTMLDivElement>(".cv-pages__main")!;
  loadPage(host.querySelector<HTMLImageElement>(".cv-pages__page")!, 1200, 1600);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Thumbnails"]')!.click());
  previous.scrollTop = 650;
  previous.scrollLeft = 120;
  renderViewer("slides.pptx", 1, { pageBaseUrl: pageBaseUrl.replace(from, to) });
  const next = host.querySelector<HTMLDivElement>(".cv-pages__main")!;
  expect(next).not.toBe(previous);
  expect(previous.isConnected).toBe(false);
  expect(next.scrollTop).toBe(0);
  expect(next.scrollLeft).toBe(0);
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("1 / 8");
  expect(host.querySelector('[aria-label="Fit whole page"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".cv-pages__rail")).not.toBeNull();
  expect(host.querySelector<HTMLImageElement>(".cv-pages__page")!.style.aspectRatio).toBe("");
});

it("resets ratios and reading preferences on an authoritative revision change at the same version", () => {
  renderViewer("slides.pptx", 1, { revision: "revision-one" });
  const previous = host.querySelector<HTMLDivElement>(".cv-pages__main")!;
  loadPage(host.querySelector<HTMLImageElement>(".cv-pages__page")!, 1200, 1600);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  previous.scrollTop = 350;
  renderViewer("slides.pptx", 1, { revision: "revision-two" });
  expect(host.querySelector(".cv-pages__main")).not.toBe(previous);
  expect(host.querySelector<HTMLDivElement>(".cv-pages__main")!.scrollTop).toBe(0);
  expect(host.querySelector('[aria-label="Fit whole page"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector<HTMLImageElement>(".cv-pages__page")!.style.aspectRatio).toBe("");
});

it("does not interpret toolbar arrow keys as page navigation", () => {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
  for (const key of ["ArrowRight", "PageDown", "End"]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => button.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("1 / 8");
  }
});

function editPage(value: string) {
  act(() => host.querySelector<HTMLButtonElement>(".cv-pages__page-number")!.click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="Go to page"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

it("accepts direct page destinations, clamps high values and leaves invalid input editable", () => {
  let input = editPage("999");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("8 / 8");
  input = editPage("2.5");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(host.querySelector(".cv-pages__input-error")?.textContent).toBe("Enter a page number within this document");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("8 / 8");
  expect(host.querySelector(".cv-pages__page-input")).toBeNull();
});

it("uses container width for automatic thumbnails but retains an explicit choice", () => {
  const container = host.querySelector<HTMLElement>(".cv-pages")!;
  Object.defineProperty(container, "clientWidth", { value: 360, configurable: true });
  act(() => notifyResize());
  expect(host.querySelector(".cv-pages__rail")).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Thumbnails"]')!.click());
  expect(host.querySelector(".cv-pages__rail")).not.toBeNull();
  Object.defineProperty(container, "clientWidth", { value: 280 });
  act(() => notifyResize());
  expect(host.querySelector(".cv-pages__rail")).not.toBeNull();
});

it("restores page, zoom, scroll and thumbnail preference across tab unmount and resets revisions", () => {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="4 / 8"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Thumbnails"]')!.click());
  viewport.scrollTop = 650;
  viewport.scrollLeft = 120;
  act(() => root.render(<CanvasProvider store={store}><div>Other tab</div></CanvasProvider>));
  renderViewer();
  viewport = host.querySelector<HTMLDivElement>(".cv-pages__main")!;
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("4 / 8");
  expect(host.querySelector(".cv-pages__percentage")?.textContent).toBe("100%");
  expect(host.querySelector(".cv-pages__rail")).toBeNull();
  expect(viewport.scrollTop).toBe(650);
  expect(viewport.scrollLeft).toBe(120);
  renderViewer("slides.pptx", 2);
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("1 / 8");
  expect(host.querySelector('[aria-label="Fit whole page"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".cv-pages__rail")).not.toBeNull();
  expect(host.querySelector<HTMLDivElement>(".cv-pages__main")!.scrollTop).toBe(0);
  renderViewer("other.pptx", 2);
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("1 / 8");
});

it("keeps the reading center in both axes instead of jumping to the page top on zoom", () => {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  Object.defineProperty(viewport, "scrollHeight", { value: 10000 });
  const sheet = host.querySelector<HTMLElement>(".cv-pages__sheet")!;
  Object.defineProperties(sheet, {
    offsetWidth: { get: () => Number.parseFloat(sheet.style.width) },
    offsetHeight: { get: () => Number.parseFloat(sheet.style.width) * 1.25 },
    offsetLeft: { value: 24 },
  });
  host.querySelectorAll(".cv-pages__sheet").forEach((node, index) => {
    Object.defineProperty(node, "offsetTop", { value: 24 + index * 2028 });
  });
  viewport.scrollTop = 724;
  viewport.scrollLeft = 324;
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
  expect(viewport.scrollTop).toBeCloseTo(824);
  expect(viewport.scrollLeft).toBeCloseTo(404);
});

it("starts thumbnails collapsed in a narrow container even when the browser window is wide", () => {
  act(() => root.render(<CanvasProvider store={store}><div /></CanvasProvider>));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  vi.stubGlobal("innerWidth", 1400);
  renderViewer("narrow.docx");
  expect(host.querySelector(".cv-pages__rail")).toBeNull();
  expect(host.querySelector('[aria-label="Thumbnails"]')?.getAttribute("aria-pressed")).toBe("false");
});

it("preserves the reading point when a fitted page resizes with its container", () => {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Fit width"]')!.click());
  let width = 1000;
  Object.defineProperty(viewport, "clientWidth", { get: () => width });
  Object.defineProperty(viewport, "scrollHeight", { value: 10000 });
  const sheets = host.querySelectorAll<HTMLElement>(".cv-pages__sheet");
  sheets.forEach((sheet, index) => Object.defineProperties(sheet, {
    offsetWidth: { get: () => Number.parseFloat(sheet.style.width) },
    offsetHeight: { get: () => Number.parseFloat(sheet.style.width) * 1.25 },
    offsetLeft: { value: 0 },
    offsetTop: { get: () => 24 + index * (Number.parseFloat(sheet.style.width) * 1.25 + 28) },
  }));
  viewport.scrollTop = 324;
  act(() => { viewport.dispatchEvent(new Event("scroll")); vi.runAllTimers(); });
  width = 800;
  act(() => notifyResize());
  expect(viewport.scrollTop).toBeCloseTo(204);
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("1 / 8");
});

it.each([[650, 4], [1040, 8]])("persists page tracking when unmounted before the scroll frame at %s", (scrollTop, expectedPage) => {
  viewport.scrollTop = scrollTop;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("1 / 8");
  act(() => root.render(<CanvasProvider store={store}><div>Other tab</div></CanvasProvider>));
  renderViewer();
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe(`${expectedPage} / 8`);
  expect(host.querySelector<HTMLDivElement>(".cv-pages__main")!.scrollTop).toBe(scrollTop);
});

it("preserves the saved reading anchor through StrictMode measurement cleanup on remount", () => {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!.click());
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("cv-pages__sheet") ? Number.parseFloat(this.style.width) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".cv-pages__sheet, .cv-pages__page") ? 2000 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("cv-pages__sheet")
      ? 24 + Array.prototype.indexOf.call(this.parentElement!.children, this) * 2028 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(17000);
  Object.defineProperty(viewport, "scrollHeight", { value: 17000 });
  host.querySelectorAll(".cv-pages__sheet").forEach((sheet, index) => {
    Object.defineProperty(sheet, "offsetTop", { value: 24 + index * 2028 });
  });
  act(() => host.querySelector<HTMLButtonElement>('.cv-pages__thumb[aria-label="4 / 8"]')!.click());
  viewport.scrollTop = 6584;
  viewport.scrollLeft = 120;
  act(() => { viewport.dispatchEvent(new Event("scroll")); vi.runAllTimers(); });
  act(() => root.render(<CanvasProvider store={store}><div>Other tab</div></CanvasProvider>));
  act(() => root.render(<StrictMode><CanvasProvider store={store}>
    <PageViewer path="slides.pptx" name="slides.pptx" pageCount={8} pageBaseUrl="/page?path=" version={1} />
  </CanvasProvider></StrictMode>));
  expect(host.querySelector(".cv-pages__page-number")?.textContent).toBe("4 / 8");
  expect(host.querySelector(".cv-pages__percentage")?.textContent).toBe("100%");
  expect(host.querySelector<HTMLDivElement>(".cv-pages__main")!.scrollTop).toBeCloseTo(6584);
  expect(host.querySelector<HTMLDivElement>(".cv-pages__main")!.scrollLeft).toBeCloseTo(120);
});
