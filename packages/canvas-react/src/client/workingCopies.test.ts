import { describe, expect, it } from "vitest";

import { visibleTabs, workingCopyIds } from "./workingCopies";

describe("a source with a working copy has no tab of its own", () => {
  it("names the copy each kind of upload is edited through", () => {
    expect(workingCopyIds("sources/deck.pptx")).toEqual(["deck.slides.html"]);
    expect(workingCopyIds("sources/book.xlsx")).toEqual(["book.table.json"]);
    expect(workingCopyIds("sources/memo.docx")).toEqual(["Editing - memo.docx"]);
    expect(workingCopyIds("sources/photo.png")).toEqual([]);
    expect(workingCopyIds("notes.md")).toEqual([]);
  });

  it("hides the source once its copy is on the canvas, and not before", () => {
    expect(visibleTabs(["sources/deck.pptx", "notes.md"])).toEqual(["sources/deck.pptx", "notes.md"]);
    expect(visibleTabs(["sources/deck.pptx", "deck.slides.html"])).toEqual(["deck.slides.html"]);
    expect(visibleTabs(["sources/memo.docx", "Editing - memo.docx", "sources/photo.png"])).toEqual([
      "Editing - memo.docx",
      "sources/photo.png",
    ]);
  });
});
