/**
 * The workbook a read-only TableRenderer hands to Fortune-sheet. Fortune is
 * replaced by a probe that captures its `data` prop, so the test sees exactly
 * what would be drawn. Rendered with react-dom directly (no testing library in
 * this package).
 */
import { act } from "react";
// @ts-expect-error — react-dom ships no types here and this package adds no
// devDependency for a single test; the runtime import is real.
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Artifact, TableData } from "../../protocol/artifacts";
import { createCanvasStore } from "../../store/store";
import { CanvasProvider } from "../../store/context";
import { ChromeProvider } from "../chrome";
import { TableRenderer, selectionRange } from "./TableRenderer";
import { ElementSelectionContext } from "../../hooks/elementSelection";
import type { CanvasElementSelectionProps } from "../../protocol/elements";
import type { Selection } from "@fortune-sheet/core";
import type * as WorkbookReading from "./workbookReading";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const probe = vi.hoisted(() => ({
  data: undefined as Array<Record<string, unknown>> | undefined,
  hooks: undefined as Record<string, unknown> | undefined,
  allowEdit: undefined as boolean | undefined,
}));

vi.mock("@fortune-sheet/react", () => ({
  Workbook: (props: { data: Array<Record<string, unknown>>; hooks?: Record<string, unknown>; allowEdit?: boolean }) => {
    probe.data = props.data;
    probe.hooks = props.hooks;
    probe.allowEdit = props.allowEdit;
    return null;
  },
}));

// DOM tab synchronization is covered by workbookReading tests; this probe drives
// the renderer's inspection callback without pretending to mount Fortune's DOM.
vi.mock("./workbookReading", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkbookReading>();
  return { ...actual, connectWorkbookReading: (
    _root: unknown, _workbook: unknown, _view: unknown, _ids: unknown, _labels: unknown,
    inspect: (sheetId: string, selection: Selection) => void,
  ) => Object.assign(() => {}, { selectionChanged: inspect, select: inspect }) };
});

// The workbook as the host parsed it: a title in B1, an empty row, and one
// formatted value in B3. `columns`/`rows` are the lossy first-sheet projection.
const workbook: Artifact<TableData> = {
  id: "sales.xlsx",
  type: "table",
  title: "Sales",
  version: 1,
  status: "complete",
  data: {
    columns: [
      { key: "A", label: "A" },
      { key: "B", label: "월별 매출" },
      { key: "C", label: "C" },
    ],
    rows: [{ B: 128000000 }],
    sheet: [
      {
        name: "요약",
        celldata: [
          { r: 0, c: 1, v: { v: "월별 매출", m: "월별 매출" } },
          { r: 2, c: 1, v: { v: 128000000, m: "128,000,000", ct: { fa: "#,##0", t: "n" } } },
        ],
      },
    ],
  },
};

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  probe.data = undefined;
  probe.hooks = undefined;
  probe.allowEdit = undefined;
});

async function mountReadOnly(artifact: Artifact<TableData>, selection: CanvasElementSelectionProps = {}): Promise<void> {
  const store = createCanvasStore();
  store.getState().applyEvent({ type: "canvas.create", artifact });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <CanvasProvider store={store}>
        <ChromeProvider>
          <ElementSelectionContext.Provider value={selection}>
            <TableRenderer artifact={artifact} readOnly elementSource={{ path: artifact.id, revision: "r1" }} />
          </ElementSelectionContext.Provider>
        </ChromeProvider>
      </CanvasProvider>,
    );
  });
  // The grid is a lazy import; wait for the probe to receive its data.
  for (let i = 0; i < 50 && !probe.data; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("TableRenderer read-only workbook", () => {
  it("should mount a read-only workbook with the parsed sheet", async () => {
    await mountReadOnly(workbook);

    const celldata = probe.data![0].celldata as Array<{ r: number; c: number; v: { v?: unknown; ct?: { fa?: string } } }>;
    const value = celldata.find((cell) => cell.r === 2 && cell.c === 1);
    expect(value?.v.ct?.fa).toBe("#,##0");
    expect(celldata.find((cell) => cell.r === 0 && cell.c === 0)).toBeUndefined();
  });

  it("should paint a read-only workbook with the sheet painter hooks", async () => {
    await mountReadOnly(workbook);

    expect(typeof probe.hooks?.beforeRenderCell).toBe("function");
    expect(typeof probe.hooks?.afterRenderCell).toBe("function");
    expect(typeof probe.hooks?.afterCellMouseDown).toBe("function");
  });

  it("should mount a read-only workbook whose only sheet holds a picture", async () => {
    const chartOnly: Artifact<TableData> = {
      ...workbook,
      id: "chart.xlsx",
      data: {
        columns: [],
        rows: [],
        sheet: [{ name: "차트", celldata: [], images: [{ id: "chart_0", src: "data:image/png;base64,AAAA" }] }],
      },
    };

    await mountReadOnly(chartOnly);

    expect((probe.data![0].images as unknown[]).length).toBe(1);
  });

  it("adds the true selected rectangle and native sheet name without enabling edits", async () => {
    const onAddElement = vi.fn();
    await mountReadOnly(workbook, { selectionMode: "elements", onAddElement });
    const afterSelectionChange = probe.hooks!.afterSelectionChange as (sheetId: string, selection: Selection) => void;
    act(() => afterSelectionChange(String(probe.data![0].id), { row: [0, 2], column: [1, 3], row_focus: 1, column_focus: 2 }));
    const button = host!.querySelector<HTMLButtonElement>(".cv-elements__range button")!;
    expect(button.disabled).toBe(false);
    expect(host!.querySelector(".cv-elements__range")!.textContent).toContain("요약!B1:D3");
    act(() => button.click());
    expect(onAddElement).toHaveBeenCalledWith(
      { path: "sales.xlsx", revision: "r1", element_id: "sheet-range", sheet_name: "요약", range: "B1:D3" },
      { id: "sheet-range", kind: "sheet-range", label: "요약!B1:D3", locator: { sheet_name: "요약", range: "B1:D3" } },
    );
    expect(probe.allowEdit).toBe(false);
    expect((probe.hooks!.beforeUpdateCell as () => boolean)()).toBe(false);
    expect((probe.hooks!.beforePaste as () => boolean)()).toBe(false);
  });

  it("keeps staging absent by default", async () => {
    await mountReadOnly(workbook);
    expect(host!.querySelector(".cv-elements__range")).toBeNull();
  });

  it("normalizes reversed range bounds without substituting the focused cell", () => {
    expect(selectionRange({ row: [9, 0], column: [27, 25], row_focus: 5, column_focus: 26 })).toBe("Z1:AB10");
    expect(selectionRange({ row: [0, 0], column: [0, 0] })).toBe("A1");
    expect(selectionRange({ row: [-1, 0], column: [0, 0] })).toBeNull();
    expect(selectionRange({ row: [0, 1048576], column: [0, 0] })).toBeNull();
    expect(selectionRange({ row: [0, 100], column: [0, 100] })).toBeNull();
  });

  it("disables range staging when the host has no add callback", async () => {
    await mountReadOnly(workbook, { selectionMode: "elements" });
    const changed = probe.hooks!.afterSelectionChange as (sheetId: string, selection: Selection) => void;
    act(() => changed(String(probe.data![0].id), { row: [0, 0], column: [0, 0] }));
    expect(host!.querySelector<HTMLButtonElement>(".cv-elements__range button")!.disabled).toBe(true);
  });
});
