/**
 * Telling a table's place on the page from the alignment of its text.
 *
 * The rules under test are the ones that keep a block alignment from reaching
 * the words: it comes off the table and its rows, an alignment a cell or
 * paragraph stated for itself survives, and the table is only moved when
 * every row asked for the same move and nothing has moved it already.
 */

import { describe, expect, it } from "vitest";

import { separateBlockAlignment } from "./docxAlignment";

/** A rendered table, written the way the preview writes one. */
function render(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

const ROW = (align: string, cell = "<p>x</p>") =>
  `<tr${align ? ` style="text-align: ${align};"` : ""}><td>${cell}</td></tr>`;

describe("separateBlockAlignment", () => {
  it("takes a row's block alignment off its text", () => {
    const host = render(`<table>${ROW("center")}</table>`);
    expect(separateBlockAlignment(host).rows).toBe(1);
    expect(host.querySelector("tr")!.style.textAlign).toBe("");
  });

  it("leaves an alignment a paragraph stated for itself", () => {
    const host = render(
      `<table>${ROW("center", '<p style="text-align: right;">x</p>')}</table>`,
    );
    separateBlockAlignment(host);
    expect(host.querySelector("p")!.style.textAlign).toBe("right");
  });

  it("leaves an alignment a cell stated for itself", () => {
    const host = render(
      '<table><tr style="text-align: center;">' +
        '<td style="text-align: right;"><p>x</p></td></tr></table>',
    );
    separateBlockAlignment(host);
    expect(host.querySelector("td")!.style.textAlign).toBe("right");
  });

  it("puts the move the rows agreed on onto the table", () => {
    const host = render(`<table>${ROW("center")}${ROW("center")}</table>`);
    expect(separateBlockAlignment(host).placed).toBe(1);
    const table = host.querySelector("table")!;
    expect(table.style.marginLeft).toBe("auto");
    expect(table.style.marginRight).toBe("auto");
  });

  it("moves a right-aligned table by its left margin only", () => {
    const host = render(`<table>${ROW("right")}</table>`);
    separateBlockAlignment(host);
    const table = host.querySelector("table")!;
    expect(table.style.marginLeft).toBe("auto");
    expect(table.style.marginRight).toBe("");
  });

  it("leaves a table that is already placed where it is", () => {
    const host = render(
      `<table style="margin-left: auto; margin-right: auto;">${ROW("right")}</table>`,
    );
    const fix = separateBlockAlignment(host);
    expect(fix.rows).toBe(1);
    expect(fix.placed).toBe(0);
    expect(host.querySelector("table")!.style.marginRight).toBe("auto");
  });

  it("does not move a table whose rows disagree", () => {
    const host = render(`<table>${ROW("center")}${ROW("right")}</table>`);
    const fix = separateBlockAlignment(host);
    expect(fix.rows).toBe(2);
    expect(fix.placed).toBe(0);
    expect(host.querySelector("table")!.style.marginLeft).toBe("");
  });

  it("does not move a table only some of whose rows asked", () => {
    const host = render(`<table>${ROW("center")}${ROW("")}</table>`);
    expect(separateBlockAlignment(host).placed).toBe(0);
  });

  it("does not move a table for an alignment that is not a place", () => {
    const host = render(`<table>${ROW("justify")}${ROW("justify")}</table>`);
    const fix = separateBlockAlignment(host);
    expect(fix.rows).toBe(2);
    expect(fix.placed).toBe(0);
  });

  it("takes the table's own block alignment off its text", () => {
    const host = render(
      '<table style="text-align: justify;"><tr><td><p>x</p></td></tr></table>',
    );
    separateBlockAlignment(host);
    expect(host.querySelector("table")!.style.textAlign).toBe("");
  });

  it("counts a nested table's rows against the nested table", () => {
    const host = render(
      '<table><tr style="text-align: center;"><td>' +
        `<table>${ROW("right")}</table>` +
        "</td></tr></table>",
    );
    const fix = separateBlockAlignment(host);
    expect(fix.rows).toBe(2);
    // The inner table stands alone: its own row asked, so it gets the move.
    expect(host.querySelectorAll("table")[1].style.marginLeft).toBe("auto");
  });

  it("finds nothing left to take on a second pass", () => {
    const host = render(`<table>${ROW("center")}</table>`);
    separateBlockAlignment(host);
    expect(separateBlockAlignment(host)).toEqual({ rows: 0, placed: 0 });
  });

  it("reports nothing for a table that never asked", () => {
    const host = render(`<table>${ROW("")}</table>`);
    expect(separateBlockAlignment(host)).toEqual({ rows: 0, placed: 0 });
  });
});
