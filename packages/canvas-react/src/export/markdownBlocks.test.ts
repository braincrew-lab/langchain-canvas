/**
 * The markdown block parser, held to the golden the Python twin
 * (`canvas-py/src/langchain_canvas/exporters.py::_markdown_blocks`) wrote for
 * the shared fixture. Change the parse on one side only and one of the two
 * suites fails (plan §U5 test 2).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import golden from "./markdownBlocks.golden.json";
import { markdownBlocks } from "./markdownBlocks";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(HERE, "__fixtures__", "parity-document.md"), "utf8");

describe("markdownBlocks", () => {
  it("reproduces the blocks the Python twin wrote", () => {
    const blocks = markdownBlocks(FIXTURE);
    expect(blocks.map((b) => b[0])).toEqual(golden.map((b) => b[0]));
    expect(blocks).toEqual(golden);
  });

  it("keeps a link as literal text and breaks a paragraph only at a two-space line end", () => {
    const [para] = markdownBlocks("first  \nsecond\nthird [x](https://x)");
    expect(para).toEqual(["para", [{ text: "first\nsecond third [x](https://x)", bold: false, italic: false, strike: false, code: false }]]);
  });

  it("drops an image whose data URI is not valid base64 to its alt text", () => {
    expect(markdownBlocks("![alt](data:image/png;base64,***)")).toEqual([
      ["para", [{ text: "alt", bold: false, italic: false, strike: false, code: false }]],
    ]);
    expect(markdownBlocks("![](https://x/a.png)")).toEqual([]);
  });
});
