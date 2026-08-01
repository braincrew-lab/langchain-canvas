/**
 * langgraphTransport helpers: thread-id mapping parity and selection framing.
 */

import { describe, expect, it } from "vitest";

import { threadUuid, withSelections } from "./transport";

describe("threadUuid", () => {
  it("passes real UUIDs through unchanged", async () => {
    const id = "019fbe63-0685-7651-9bcd-babcdebbc46c";
    expect(await threadUuid(id)).toBe(id);
  });

  it("matches the Python bridge's uuid5 mapping for non-UUID ids", async () => {
    // uuid5(NAMESPACE_URL, "canvas-thread:my-thread-1") computed with CPython.
    expect(await threadUuid("my-thread-1")).toBe("2637a20a-f225-5f47-8523-5be09f0d1998");
  });

  it("is deterministic", async () => {
    expect(await threadUuid("abc")).toBe(await threadUuid("abc"));
  });
});

describe("withSelections", () => {
  it("returns the message untouched with no selections", () => {
    expect(withSelections("hi", [])).toBe("hi");
  });

  it("frames a targeted edit around the selected elements", () => {
    const framed = withSelections("make it red", [
      { artifactId: "01-intro.html", cid: "e-0-2", selector: "h1.title", tag: "h1" },
    ]);
    expect(framed).toContain("make it red");
    expect(framed).toContain("`01-intro.html`");
    expect(framed).toContain("`h1.title` (data-cid=e-0-2)");
    expect(framed).toContain("read_canvas");
    expect(framed).toContain("edit_canvas");
  });
});
