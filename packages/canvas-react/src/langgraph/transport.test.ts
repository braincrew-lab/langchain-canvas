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
      {
        artifactId: "01-intro.html",
        cid: "e-0-2",
        selector: "h1.title",
        tag: "h1",
        text: "Hello",
        outerHtml: '<h1 class="title">Hello</h1>',
      },
    ]);
    expect(framed).toContain("make it red");
    expect(framed).toContain("`01-intro.html`");
    expect(framed).toContain("`h1.title`");
    expect(framed).toContain('<h1 class="title">Hello</h1>');
    expect(framed).toContain("read_canvas");
    expect(framed).toContain("edit_canvas");
  });

  it("does not send the agent looking for the screen's own attributes", () => {
    // The inspector strips data-cid before anything is stored, so an
    // instruction naming it points at markup the file never had.
    const framed = withSelections("make it red", [
      {
        artifactId: "01-intro.html",
        cid: "e-0-2",
        selector: "h1.title",
        tag: "h1",
        outerHtml: '<h1 class="title">Hello</h1>',
      },
    ]);
    expect(framed).not.toContain("data-cid=e-0-2");
    expect(framed).not.toContain("keep the data-cid");
  });

  it("frames a document selection with the words, not the moving number", () => {
    const framed = withSelections("make this polite", [
      {
        artifactId: "Editing - plan.docx",
        cid: "p37",
        selector: "[p37]",
        tag: "p",
        text: "본 자료는 정보 제공 목적으로만 작성되었습니다.",
      },
    ]);
    expect(framed).toContain("make this polite");
    expect(framed).toContain("`Editing - plan.docx`");
    expect(framed).toContain("[p37]");
    expect(framed).toContain("본 자료는 정보 제공 목적으로만 작성되었습니다.");
    // The document tools take an anchor; the html-only instruction would send
    // the agent looking for outer HTML that a .docx does not have.
    expect(framed).toContain("insert_document_paragraph");
    expect(framed).toContain("text anchor");
    expect(framed).not.toContain("data-cid");
    expect(framed).not.toContain("outer HTML");
  });

  it("keeps the two framings apart by the file, not by who set the selection", () => {
    const page = { cid: "e-0-2", selector: "h1", tag: "h1" };
    expect(withSelections("x", [{ ...page, artifactId: "a.html" }])).toContain(
      "exact markup from the file",
    );
    expect(withSelections("x", [{ ...page, artifactId: "A.DOCX" }])).toContain("text anchor");
  });
});
