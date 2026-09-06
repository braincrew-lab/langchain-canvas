/** `withInspector` wires the in-frame editor; `readOnly` keeps only asset resolution. */
import { describe, expect, it } from "vitest";

import { withInspector } from "./inspector";

const page = '<!doctype html><html><head></head><body><h1>Hi</h1><img src="assets/a.png"></body></html>';

describe("withInspector", () => {
  it("wires the editor by default", () => {
    const out = withInspector(page, "http://h/file?path=");
    expect(out).toContain('window.__LCX_ASSET_BASE="http://h/file?path="');
    expect(out).not.toContain("window.__LCX_READONLY=true");
    expect(out.indexOf("<script data-lcx>")).toBeLessThan(out.lastIndexOf("</body>"));
  });

  it("read-only keeps asset resolution and tells the script to stop after it", () => {
    const out = withInspector(page, "http://h/file?path=", { readOnly: true });
    expect(out).toContain('window.__LCX_ASSET_BASE="http://h/file?path="');
    expect(out).toContain("window.__LCX_READONLY=true");
    expect(out).toContain("if (window.__LCX_READONLY) return;");
  });

  it("read-only without an asset base still flags the script", () => {
    const out = withInspector(page, undefined, { readOnly: true });
    expect(out).not.toContain("window.__LCX_ASSET_BASE=");
    expect(out).toContain("window.__LCX_READONLY=true");
  });
});
