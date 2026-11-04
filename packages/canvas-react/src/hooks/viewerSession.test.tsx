import { act } from "react";
// @ts-expect-error — direct React DOM runtime without optional type package.
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CanvasProvider, createCanvasStore } from "./useCanvasStore";
import { useViewerSession } from "./viewerSession";

it("keeps reading state per store and revision while reset clears it", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const store = createCanvasStore();
  const another = createCanvasStore();
  let latest = { current: { page: 1 } };
  function Probe({ revision }: { revision: number }) {
    latest = useViewerSession("page:report", revision, () => ({ page: 1 }));
    return null;
  }
  const mount = (revision: number, target = store) => act(() => root.render(<CanvasProvider key={target === store ? "a" : "b"} store={target}><Probe revision={revision} /></CanvasProvider>));
  try {
    mount(1);
    latest.current.page = 4;
    act(() => root.render(null));
    mount(1);
    expect(latest.current.page).toBe(4);
    mount(1, another);
    expect(latest.current.page).toBe(1);
    mount(2);
    expect(latest.current.page).toBe(1);
    latest.current.page = 3;
    act(() => root.render(null));
    store.getState().reset();
    mount(2);
    expect(latest.current.page).toBe(1);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
