import { describe, expect, it } from "vitest";

import type { Artifact } from "../protocol/artifacts";
import { emptyCanvasState, mergePatch, reduceCanvas } from "./reconcile";

const doc = (over: Partial<Artifact> = {}): Artifact => ({
  id: "a1",
  type: "document",
  title: "Doc",
  version: 1,
  status: "streaming",
  data: { format: "markdown", content: "" },
  ...over,
});

describe("reduceCanvas", () => {
  it("creates an artifact, tracks order, and focuses it", () => {
    const s = reduceCanvas(emptyCanvasState(), { type: "canvas.create", artifact: doc() });
    expect(s.order).toEqual(["a1"]);
    expect(s.activeId).toBe("a1");
    expect(s.artifacts.a1.title).toBe("Doc");
    expect(s.history.a1).toHaveLength(1);
  });

  it("appends text at a dot-path", () => {
    let s = reduceCanvas(emptyCanvasState(), { type: "canvas.create", artifact: doc() });
    s = reduceCanvas(s, { type: "canvas.append", id: "a1", path: "content", text: "Hello " });
    s = reduceCanvas(s, { type: "canvas.append", id: "a1", path: "content", text: "world" });
    expect((s.artifacts.a1.data as { content: string }).content).toBe("Hello world");
  });

  it("merge-patches data without touching version history", () => {
    let s = reduceCanvas(emptyCanvasState(), {
      type: "canvas.create",
      artifact: doc({ type: "chart", data: { chart: "bar", xKey: "x", series: [], rows: [] } }),
    });
    s = reduceCanvas(s, { type: "canvas.patch", id: "a1", patch: { chart: "line" } });
    expect((s.artifacts.a1.data as { chart: string }).chart).toBe("line");
    expect(s.history.a1).toHaveLength(1); // in-place, no new version
  });

  it("pushes a new version snapshot on replace", () => {
    let s = reduceCanvas(emptyCanvasState(), { type: "canvas.create", artifact: doc() });
    s = reduceCanvas(s, { type: "canvas.replace", id: "a1", artifact: doc({ version: 2, title: "Doc v2" }) });
    expect(s.history.a1).toHaveLength(2);
    expect(s.artifacts.a1.title).toBe("Doc v2");
  });

  it("patches a single HTML node by its data-cid path", () => {
    const html = '<html><body><h1 data-cid="e-0">Old</h1><p data-cid="e-1">keep</p></body></html>';
    let s = reduceCanvas(emptyCanvasState(), {
      type: "canvas.create",
      artifact: doc({ type: "html", data: { html } }),
    });
    s = reduceCanvas(s, { type: "canvas.node_patch", id: "a1", cid: "e-0", html: "<h1>New</h1>" });
    const out = (s.artifacts.a1.data as { html: string }).html;
    expect(out).toContain("New");
    expect(out).not.toContain("Old");
    expect(out).toContain("keep"); // sibling untouched
  });

  it("is a no-op for events targeting an unknown id", () => {
    const s0 = emptyCanvasState();
    expect(reduceCanvas(s0, { type: "canvas.patch", id: "ghost", patch: { x: 1 } })).toBe(s0);
    expect(reduceCanvas(s0, { type: "canvas.status", id: "ghost", status: "complete" })).toBe(s0);
  });

  it("does not throw on a bad append path (leaves data unchanged)", () => {
    let s = reduceCanvas(emptyCanvasState(), { type: "canvas.create", artifact: doc() });
    const before = s.artifacts.a1.data;
    s = reduceCanvas(s, { type: "canvas.append", id: "a1", path: "nope.deep.path", text: "x" });
    expect(s.artifacts.a1.data).toEqual(before);
  });

  it("canvas.commit stamps the live tail as a described version (no duplicate snapshot)", () => {
    let s = reduceCanvas(emptyCanvasState(), { type: "canvas.create", artifact: doc() });
    s = reduceCanvas(s, { type: "canvas.patch", id: "a1", patch: { content: "edited" } });
    s = reduceCanvas(s, { type: "canvas.commit", id: "a1", description: "Manual edit: 1 change", revision: "v1" });

    expect(s.history.a1).toHaveLength(1);
    const latest = s.history.a1[0];
    expect(latest.meta?.commitDescription).toBe("Manual edit: 1 change");
    expect(latest.meta?.revision).toBe("v1");
    expect((latest.data as { content: string }).content).toBe("edited");
  });

  it("content after a commit opens a new working entry — the committed snapshot stays frozen", () => {
    let s = reduceCanvas(emptyCanvasState(), { type: "canvas.create", artifact: doc() });
    s = reduceCanvas(s, { type: "canvas.commit", id: "a1", description: "First cut", revision: "v1" });
    s = reduceCanvas(s, { type: "canvas.patch", id: "a1", patch: { content: "reworked" } });

    expect(s.history.a1).toHaveLength(2);
    const [frozen, working] = s.history.a1;
    expect((frozen.data as { content: string }).content).toBe(""); // untouched
    expect(frozen.meta?.commitDescription).toBe("First cut");
    expect((working.data as { content: string }).content).toBe("reworked");
    expect(working.meta?.commitDescription).toBeUndefined();
    expect(working.meta?.revision).toBe("v1"); // save baseline carries over
    expect(working.version).toBe(frozen.version + 1);
  });

  it("commit → patch → commit yields exactly one version per commit", () => {
    let s = reduceCanvas(emptyCanvasState(), { type: "canvas.create", artifact: doc() });
    s = reduceCanvas(s, { type: "canvas.commit", id: "a1", description: "First cut", revision: "v1" });
    s = reduceCanvas(s, { type: "canvas.patch", id: "a1", patch: { content: "reworked" } });
    s = reduceCanvas(s, { type: "canvas.commit", id: "a1", description: "Rework", revision: "v2" });

    expect(s.history.a1).toHaveLength(2);
    expect(s.history.a1.map((v) => v.meta?.commitDescription)).toEqual(["First cut", "Rework"]);
    expect(s.history.a1.map((v) => v.meta?.revision)).toEqual(["v1", "v2"]);
  });

  it("canvas.commit on an unknown id is a no-op", () => {
    const s0 = emptyCanvasState();
    expect(reduceCanvas(s0, { type: "canvas.commit", id: "ghost", description: "x" })).toBe(s0);
  });

  it("an unknown canvas.* event from a newer server never wipes state", () => {
    const s1 = reduceCanvas(emptyCanvasState(), { type: "canvas.create", artifact: doc() });
    const unknown = { type: "canvas.totally_new", id: "a1" } as unknown as Parameters<typeof reduceCanvas>[1];
    expect(reduceCanvas(s1, unknown)).toBe(s1);
  });
});

describe("mergePatch (RFC 7386)", () => {
  it("merges objects recursively", () => {
    expect(mergePatch({ a: 1, b: { c: 2 } }, { b: { d: 3 } })).toEqual({ a: 1, b: { c: 2, d: 3 } });
  });
  it("deletes keys set to null", () => {
    expect(mergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });
  it("replaces arrays and scalars wholesale", () => {
    expect(mergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    expect(mergePatch(5, "x")).toBe("x");
  });
});
