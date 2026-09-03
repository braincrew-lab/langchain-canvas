import { describe, expect, it } from "vitest";

import type { Artifact } from "../protocol/artifacts";
import { buildExportActions } from "./actions";
import { slugify } from "./download";

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
