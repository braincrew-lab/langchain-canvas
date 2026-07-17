import { describe, expect, it } from "vitest";

import type { CanvasCreate } from "../protocol/events";
import { canImport, importFile, parseCsv } from "./importers";

// jsdom's File doesn't implement the Blob read methods, so back them with the body.
const file = (name: string, body: string): File =>
  Object.assign(new File([body], name, { type: "text/plain" }), {
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }) as File;
const created = (events: Awaited<ReturnType<typeof importFile>>) =>
  events.find((e): e is CanvasCreate => e.type === "canvas.create")!.artifact;

describe("parseCsv", () => {
  it("parses a header + rows", () => {
    const t = parseCsv("Name,Age\nAlice,30\nBob,25");
    expect(t.columns.map((c) => c.key)).toEqual(["Name", "Age"]);
    expect(t.rows).toEqual([
      { Name: "Alice", Age: 30 },
      { Name: "Bob", Age: 25 },
    ]);
  });

  it("keeps quoted commas and escaped quotes inside one field", () => {
    const t = parseCsv('Name,Role\nBob,"Designer, Lead"\nCarol,"Says ""hi"""');
    expect(t.rows[0].Role).toBe("Designer, Lead");
    expect(t.rows[1].Role).toBe('Says "hi"');
  });

  it("only coerces numbers that round-trip (IDs stay strings)", () => {
    const t = parseCsv("Code,Qty\n00123,5\n1e3,7\n0x10,9\n6.33,1");
    expect(t.rows[0].Code).toBe("00123"); // leading zero preserved
    expect(t.rows[0].Qty).toBe(5);
    expect(t.rows[1].Code).toBe("1e3"); // not 1000
    expect(t.rows[2].Code).toBe("0x10"); // not 16
    expect(t.rows[3].Code).toBe(6.33);
  });

  it("de-duplicates repeated header names", () => {
    const t = parseCsv("A,A,B\n1,2,3");
    expect(t.columns.map((c) => c.key)).toEqual(["A", "A (2)", "B"]);
    expect(t.rows[0]).toEqual({ A: 1, "A (2)": 2, B: 3 });
  });
});

describe("importFile routing", () => {
  it("CSV → table artifact", async () => {
    const a = created(await importFile(file("people.csv", "x,y\n1,2")));
    expect(a.type).toBe("table");
    expect(a.title).toBe("people");
    expect(a.status).toBe("complete");
  });

  it("Markdown → document artifact", async () => {
    const a = created(await importFile(file("notes.md", "# Hi")));
    expect(a.type).toBe("document");
    expect((a.data as { content: string }).content).toBe("# Hi");
  });

  it("HTML → html artifact (source preserved)", async () => {
    const a = created(await importFile(file("page.html", "<h1>Hi</h1>")));
    expect(a.type).toBe("html");
    expect((a.data as { html: string }).html).toBe("<h1>Hi</h1>");
  });

  it("a previously-exported artifact JSON is re-homed under a fresh id", async () => {
    const payload = JSON.stringify({ id: "old", type: "document", title: "T", version: 3, data: { format: "markdown", content: "x" } });
    const a = created(await importFile(file("art.json", payload)));
    expect(a.type).toBe("document");
    expect(a.version).toBe(1);
    expect(a.id).not.toBe("old");
  });

  it("rejects an unsupported extension", async () => {
    await expect(importFile(file("a.exe", "x"))).rejects.toThrow(/Unsupported/);
  });
});

describe("canImport", () => {
  it("accepts known extensions, rejects others", () => {
    expect(canImport(file("a.csv", ""))).toBe(true);
    expect(canImport(file("a.XLSX", ""))).toBe(true);
    expect(canImport(file("a.png", ""))).toBe(false);
  });
});
