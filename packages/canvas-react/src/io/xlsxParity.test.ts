// exceljs reads xlsx serial dates as UTC midnight and the formatter reads the
// local parts back, so the day a date cell shows depends on the machine's
// zone. Pin it, or this golden means something different in every timezone.
process.env.TZ = "UTC";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { xlsxToSheets } from "./xlsx";

/**
 * Golden-file parity with the Python twin (`langchain_canvas/xlsx_import.py`).
 *
 * Both readers take the same bytes and must land on the same sheets: a table
 * a person drags in and a table an agent builds have to look alike. The
 * fixture burns everything the importer reads — three sheets, string / number
 * / formula / date / boolean values, thousands / percent / currency / escaped
 * date formats, bold, italic, underline, size, face, rgb + theme + indexed +
 * tinted colours, a solid fill, three alignments and wrapping, a merge, five
 * border styles, stored column widths and row heights, a floating image, a
 * duplicate header label, an empty styled cell, an empty unstyled cell and a
 * blank row. A surface the fixture does not burn is one the twins can drift
 * on unnoticed.
 *
 * `xlsx-parity.json` is this side's output, checked in. When it changes, the
 * Python test fails too, and whichever reader moved has to be the one fixed.
 */
// jsdom does not give this module a file: URL, so resolve from the
// package root vitest runs in.
const here = join(process.cwd(), "src", "io", "__fixtures__");

describe("xlsx import parity", () => {
  it("converts the fixture into the golden sheets", async () => {
    const bytes = readFileSync(join(here, "xlsx-parity.xlsx"));
    const golden = JSON.parse(readFileSync(join(here, "xlsx-parity.json"), "utf8"));

    const got = await xlsxToSheets(
      bytes as unknown as ArrayBuffer,
      async () => (await import("exceljs")).default,
    );

    expect(JSON.parse(JSON.stringify(got))).toEqual(golden);
  });
});
