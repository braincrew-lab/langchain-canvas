/**
 * Host-supplied Export entries are appended — never replacing the built-ins.
 * Rendered with react-dom directly (no testing library in this package).
 */
import { act } from "react";
// @ts-expect-error — react-dom ships no types here and this package adds no
// devDependency for a single test; the runtime import is real.
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Artifact } from "../protocol/artifacts";
import { ExportMenu } from "./ExportMenu";

const deck: Artifact = {
  id: "a1",
  type: "slides",
  title: "Deck",
  version: 1,
  status: "complete",
  data: { slides: [{ title: "One" }] },
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

const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

describe("ExportMenu extras", () => {
  it("appends extras after the built-in entries and runs them on click", () => {
    const run = vi.fn();
    mount(
      <ExportMenu
        artifact={deck}
        getRenderedHtml={() => null}
        extras={[{ label: "PowerPoint", extension: "pptx", run }]}
      />,
    );
    click(host!.querySelector(".cv-export__btn")!);
    const items = [...host!.querySelectorAll('[role="menuitem"]')];
    expect(items.some((el) => el.textContent?.includes("HTML"))).toBe(true); // built-ins stay
    const last = items[items.length - 1];
    expect(last.textContent).toContain("PowerPoint");
    expect(last.textContent).toContain("pptx");
    click(last);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("renders no extra entries when the prop is absent", () => {
    mount(<ExportMenu artifact={deck} getRenderedHtml={() => null} />);
    click(host!.querySelector(".cv-export__btn")!);
    const labels = [...host!.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? "");
    expect(labels.join(" ")).not.toContain("PowerPoint");
  });
});
