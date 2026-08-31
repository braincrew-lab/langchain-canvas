import React, { act } from "react";
// @ts-expect-error -- react-dom runtime is installed without its type package
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExportMenu } from "./ExportMenu";
import { CanvasProvider } from "../store/context";
import { createCanvasStore } from "../store/store";
import { downloadBlob } from "../export/download";

vi.mock("../export/download", () => ({ downloadBlob: vi.fn(), slugify: () => "deck" }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("exports current slide HTML and shows a server error so the user can retry", async () => {
  const store = createCanvasStore();
  store.getState().setExportUrl("http://localhost:8005/api/canvas/test/export");
  const html = '<html><body><template data-slide-id="s1"><h1>Unsaved edit</h1></template></body></html>';
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: "Renderer unavailable" }) });
  vi.stubGlobal("fetch", fetcher);
  try {
    act(() => root.render(React.createElement(CanvasProvider, { store, children:
      React.createElement(ExportMenu, { artifact: { id: "deck.slides.html", type: "slides", title: "Deck", status: "complete", version: 1, data: { html } }, getRenderedHtml: () => '<iframe></iframe>' }),
    })));
    act(() => container.querySelector<HTMLButtonElement>(".cv-export__btn")!.click());
    const pptx = () => [...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(b => b.textContent?.includes(".pptx"))!;
    expect(pptx()).toBeDefined();
    await act(async () => pptx().click());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ path: "deck.slides.html", target: "pptx", content: html });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Renderer unavailable");
    expect(pptx().disabled).toBe(false);
    fetcher.mockResolvedValue({ ok: true, blob: async () => new Blob(["PPTX"]) });
    await act(async () => pptx().click());
    expect(downloadBlob).toHaveBeenCalledWith("deck.pptx", expect.any(String), expect.any(Blob));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>(".cv-export__btn")!.click());
    const htmlOption = [...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(b => b.textContent?.trim() === "HTML .html")!;
    await act(async () => htmlOption.click());
    expect(downloadBlob).toHaveBeenLastCalledWith("deck.slides.html", "text/html", html);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
