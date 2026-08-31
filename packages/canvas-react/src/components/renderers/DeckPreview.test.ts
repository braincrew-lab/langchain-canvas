import React, { act } from "react";
// @ts-expect-error -- react-dom runtime is installed without its type package
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeckThumbRail } from "./DeckThumbRail";
import { DeckStage } from "./DeckStage";
import { CanvasProvider, createCanvasStore } from "../../hooks/useCanvasStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders every visible thumbnail with the same viewport as the stage", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const slides = Array.from({ length: 9 }, (_, i) => ({
    slideId: `s${i}`, title: `Page ${i}`, styleCss: "", bodyHtml: `<h1>Page ${i}</h1>`,
  }));
  try {
    act(() => root.render(React.createElement(React.Fragment, null,
      React.createElement(DeckThumbRail, { slides, ratio: "4:3", activeSlideId: "s8", onSelect() {}, onReorder() {} }),
      React.createElement(DeckStage, { artifactId: "deck", slide: slides[8], ratio: "4:3" }),
    )));
    const thumbs = container.querySelectorAll<HTMLIFrameElement>(".cv-deck__thumb-frame");
    expect(thumbs).toHaveLength(9);
    const stage = container.querySelector<HTMLIFrameElement>(".cv-html")!;
    expect(stage.style.width).toBe("1280px");
    expect(stage.style.height).toBe("960px");
    for (const thumb of thumbs) {
      expect(thumb.style.width).toBe(stage.style.width);
      expect(thumb.style.height).toBe(stage.style.height);
      expect((thumb.parentElement as HTMLElement).style.aspectRatio).toBe("1280 / 960");
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("forwards style edits only to the matching deck's active editing frame", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const store = createCanvasStore();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(React.createElement(CanvasProvider, { store, children:
      React.createElement(DeckStage, { artifactId: "deck", ratio: "16:9", slide: { slideId: "s1", title: "Page", styleCss: "", bodyHtml: '<p data-node-id="t">Text</p>' } }),
    })));
    const frame = container.querySelector<HTMLIFrameElement>("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => store.getState().sendIframeCommand({ artifactId: "other", type: "set_style", cid: "t", prop: "fontSize", value: "32px" }));
    expect(post).not.toHaveBeenCalled();
    act(() => store.getState().sendIframeCommand({ artifactId: "deck", type: "set_style", cid: "t", prop: "fontSize", value: "32px" }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "set_style", prop: "fontSize", value: "32px" }), "*");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
