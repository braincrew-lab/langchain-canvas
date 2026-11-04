import { act } from "react";
// @ts-expect-error — react-dom is used directly without optional declaration packages.
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasProvider, createCanvasStore } from "../../hooks/useCanvasStore";
import { FileRenderer } from "./FileRenderer";
import type { Artifact, FileData } from "../../protocol/artifacts";

let root: Root;
let host: HTMLDivElement;
let store = createCanvasStore();
const fetchFile = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchFile);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  store = createCanvasStore();
  store.setState({ assetBaseUrl: "/files?path=", pageBaseUrl: "/pages?path=" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function wordFile(data: Partial<FileData> = {}): Artifact<FileData> {
  return {
    id: "report.docx", type: "file", title: "Report", version: 1, status: "complete",
    data: { path: "report.docx", name: "Report.docx", ...data },
  };
}

async function renderFile(artifact: Artifact<FileData>) {
  await act(async () => root.render(
    <CanvasProvider store={store}><FileRenderer artifact={artifact} /></CanvasProvider>,
  ));
}

function expectNoTextPreview() {
  expect(host.querySelector(".cv-docx, .cv-docx-file__modes, .cv-docx__pagination, .cv-file__excerpt")).toBeNull();
  expect(host.textContent).not.toContain("Select text");
  expect(fetchFile).not.toHaveBeenCalled();
}

it("shows Word page images without requiring an asset endpoint or offering text selection", async () => {
  store.setState({ assetBaseUrl: null });
  await renderFile(wordFile({ pageCount: 2, excerpt: "Extracted Word text" }));
  expect(host.querySelectorAll(".cv-pages__sheet")).toHaveLength(2);
  expectNoTextPreview();
  const page = host.querySelector(".cv-pages__sheet img")!;
  act(() => {
    page.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    page.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  expect(store.getState().selections).toEqual([]);
});

it.each(["metadata", "endpoint"])("switches from fallback to page images when Word %s arrives", async (late) => {
  if (late === "endpoint") store.setState({ pageBaseUrl: null });
  let artifact = wordFile({ pageCount: late === "metadata" ? undefined : 2, cover: "/cover.png" });
  await renderFile(artifact);
  expect(host.querySelector(".cv-file__cover")).not.toBeNull();
  expectNoTextPreview();

  artifact = { ...artifact, data: { ...artifact.data, pageCount: 2 } };
  act(() => store.setState({ pageBaseUrl: "/pages?path=" }));
  await renderFile(artifact);
  expect(host.querySelectorAll(".cv-pages__sheet")).toHaveLength(2);
  expect(host.querySelector(".cv-file__cover")).toBeNull();
  expectNoTextPreview();

  await renderFile({ ...artifact, version: 2, data: { ...artifact.data, pageCount: 3 } });
  expect(host.querySelectorAll(".cv-pages__sheet")).toHaveLength(3);
  expectNoTextPreview();
});

it.each(["grid", "cover", "file"])("keeps the %s fallback without rendering selectable Word content", async (fallback) => {
  store.setState({ pageBaseUrl: null });
  await renderFile(wordFile({
    pageCount: 2,
    excerpt: "Extracted Word text",
    ...(fallback === "grid" ? { grids: ["/grid.png"] } : {}),
    ...(fallback === "cover" ? { cover: "/cover.png" } : {}),
  }));
  expect(host.querySelector(".cv-pages")).toBeNull();
  expect(host.querySelector(".cv-file__card")?.textContent).toContain("Report.docx");
  expect(host.querySelectorAll(".cv-file__grid")).toHaveLength(fallback === "grid" ? 1 : 0);
  expect(host.querySelectorAll(".cv-file__cover")).toHaveLength(fallback === "cover" ? 1 : 0);
  expect(host.textContent).not.toContain("Extracted Word text");
  expectNoTextPreview();
});

it("does not expose a Word excerpt when only the MIME type identifies the document", async () => {
  await renderFile(wordFile({
    path: "stored-file", name: "Report",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    excerpt: "Extracted Word text",
  }));
  expect(host.querySelector(".cv-file__card")?.textContent).toContain("Report");
  expect(host.textContent).not.toContain("Extracted Word text");
  expectNoTextPreview();
});

it("preserves text excerpts for other stored file formats", async () => {
  await renderFile(wordFile({ path: "notes.txt", name: "notes.txt", excerpt: "Plain text excerpt" }));
  expect(host.querySelector(".cv-file__excerpt")?.textContent).toBe("Plain text excerpt");
});
