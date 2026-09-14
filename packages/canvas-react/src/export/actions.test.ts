import { describe, expect, it, vi } from "vitest";

import type { Artifact } from "../protocol/artifacts";
import { buildExportActions } from "./actions";
import { slugify } from "./download";
import { PRINT_COLOR_CSS } from "./exporters";
import { printToPdf } from "./pdf";

vi.mock("./pdf", () => ({ printToPdf: vi.fn() }));

const artifact = (type: Artifact["type"], data: Artifact["data"]): Artifact => ({
  id: `a.${type}`,
  type,
  title: "Q1 Report",
  version: 1,
  status: "complete",
  data,
});

describe("buildExportActions", () => {
  it("lists the same entries the menu always had, in order", () => {
    const ids = buildExportActions(artifact("document", { content: "# Hi" }), {
      getRenderedHtml: () => "<h1>Hi</h1>",
      assetBaseUrl: null,
    }).map((a) => a.id);
    expect(ids).toEqual(["open-tab", "copy", "html", "pdf", "md", "docx"]);
  });

  it("offers PDF only for types that print faithfully", () => {
    const ids = buildExportActions(artifact("table", { columns: [], rows: [] }), {
      getRenderedHtml: () => null,
      assetBaseUrl: null,
    }).map((a) => a.id);
    expect(ids).toEqual(["open-tab", "copy", "html", "csv"]);
  });

  it("takes its labels from the host's map", () => {
    const [openTab, , html, , md] = buildExportActions(artifact("document", { content: "x" }), {
      getRenderedHtml: () => null,
      assetBaseUrl: null,
      labels: { exportOpenInTab: "새 탭에서 열기", exportHtml: "웹페이지", exportMarkdown: "마크다운" },
    });
    expect(openTab.label).toBe("새 탭에서 열기");
    expect(html.label).toBe("웹페이지");
    expect(md.label).toBe("마크다운");
  });

  it("prints a web page with the colours it was drawn with", async () => {
    const html = `<!doctype html><html><head></head><body style="background:#0b1020"><h1>Hi</h1></body></html>`;
    const pdf = buildExportActions(artifact("html", { html }), {
      getRenderedHtml: () => null,
      assetBaseUrl: null,
    }).find((a) => a.id === "pdf")!;
    await pdf.run();
    const call = vi.mocked(printToPdf).mock.calls.at(-1);
    const printed = call?.[0] ?? "";
    expect(printed).toContain(PRINT_COLOR_CSS);
    // cards are measured in the frame and kept on one page
    expect(call?.[1]).toEqual({ wholeBoxes: true });
    expect(printed).toContain('<body style="background:#0b1020"><h1>Hi</h1></body>');
  });
});

describe("slugify", () => {
  it("keeps letters of any script and folds the rest into dashes", () => {
    expect(slugify("Q1 Report!")).toBe("q1-report");
    expect(slugify("매출 보고서 (초안)")).toBe("매출-보고서-초안");
    expect(slugify("Ünïcode / path")).toBe("ünïcode-path");
  });

  it("falls back to a stem when nothing survives", () => {
    expect(slugify("!!!")).toBe("artifact");
    expect(slugify("")).toBe("artifact");
  });
});
