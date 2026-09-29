/** withCspPrefix — the srcDoc CSP prefix that must survive every <head>-search bypass. */

import { describe, expect, it } from "vitest";

import { deriveAssetOrigin, withCspPrefix } from "./csp-prefix";

const CSP_PREFIX = '<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="';

function assertCspIsFirst(result: string) {
  expect(result.startsWith(CSP_PREFIX)).toBe(true);
  const doc = new DOMParser().parseFromString(result, "text/html");
  const meta = doc.head?.firstElementChild;
  expect(meta?.tagName.toLowerCase()).toBe("meta");
  expect(meta?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
  expect(meta?.getAttribute("content")).not.toContain("connect-src");
}

function assertNoModelDoctypeRemains(result: string) {
  // Exactly one doctype declaration total — ours. A model-supplied doctype
  // (single or duplicated) must not survive alongside it.
  expect((result.match(/<!doctype/gi) ?? []).length).toBe(1);
}

describe("withCspPrefix — bypass inputs", () => {
  const cases: Record<string, string> = {
    "leading <script>": `<script>var trap = "<head>";</script><html><head><title>t</title></head><body>hi</body></html>`,
    "<head> inside a comment": `<!doctype html><!-- <head> --><html><head><title>t</title></head><body>hi</body></html>`,
    '"<head>" inside a script string': `<!doctype html><script>var s = "<head>";</script><html><head></head><body>hi</body></html>`,
    "uppercase <HEAD>": `<!DOCTYPE HTML><html><HEAD><title>t</title></HEAD><body>hi</body></html>`,
    "no head": `<!doctype html><html><body><p>hi</p></body></html>`,
    "BOM + doctype": `﻿<!doctype html><html><head></head><body>hi</body></html>`,
    "duplicate doctype": `<!doctype html><!doctype html><html><head></head><body>hi</body></html>`,
  };

  for (const [name, input] of Object.entries(cases)) {
    it(`${name} — CSP meta is still the first head element and the model doctype is gone`, () => {
      const result = withCspPrefix(input, ["https://cdn.example.com"]);
      assertCspIsFirst(result);
      assertNoModelDoctypeRemains(result);
    });
  }
});

describe("withCspPrefix — asset origins", () => {
  function directivesOf(content: string): Record<string, string> {
    return Object.fromEntries(
      content.split("; ").map((d) => {
        const [name, ...rest] = d.split(" ");
        return [name, rest.join(" ")];
      }),
    );
  }

  it("adds asset origins to img/style/font only, never script/default, and omits connect-src", () => {
    const result = withCspPrefix("<html><head></head><body></body></html>", ["https://cdn.example.com"]);
    const doc = new DOMParser().parseFromString(result, "text/html");
    const content = doc.head!.firstElementChild!.getAttribute("content")!;
    const directives = directivesOf(content);
    expect(directives["img-src"]).toContain("https://cdn.example.com");
    expect(directives["style-src"]).toContain("https://cdn.example.com");
    expect(directives["font-src"]).toContain("https://cdn.example.com");
    expect(directives["script-src"]).not.toContain("https://cdn.example.com");
    expect(directives["default-src"]).toBe("'none'");
    expect(content).not.toContain("connect-src");
    expect(content).not.toContain("frame-src");
    expect(directives["form-action"]).toBe("'none'");
  });

  it("defaults to no asset origins", () => {
    const result = withCspPrefix("<html><head></head><body></body></html>");
    const doc = new DOMParser().parseFromString(result, "text/html");
    const content = doc.head!.firstElementChild!.getAttribute("content")!;
    const directives = directivesOf(content);
    expect(directives["img-src"]).toBe("data: blob:");
    expect(directives["style-src"]).toBe("'unsafe-inline'");
    expect(directives["font-src"]).toBe("data:");
  });
});

describe("deriveAssetOrigin", () => {
  it("returns null when there is no asset base URL", () => {
    expect(deriveAssetOrigin(null)).toBeNull();
    expect(deriveAssetOrigin(undefined)).toBeNull();
    expect(deriveAssetOrigin("")).toBeNull();
  });

  it("resolves an absolute asset base URL to its own origin", () => {
    expect(deriveAssetOrigin("https://cdn.example.com/files/")).toBe("https://cdn.example.com");
    expect(deriveAssetOrigin("https://cdn.example.com:8443/files/")).toBe("https://cdn.example.com:8443");
  });

  it("resolves a relative asset base URL to the parent page's origin (window.location), not an opaque srcDoc origin", () => {
    expect(deriveAssetOrigin("/api/canvas/files/")).toBe(window.location.origin);
  });
});
