import { describe, expect, it, vi } from "vitest";

import { createCanvasStore } from "./store";
import type { Artifact } from "../protocol/artifacts";

function htmlArtifact(id: string, html: string): Artifact {
  return { id, type: "html", title: "Page", version: 1, status: "complete", data: { html } };
}

describe("store onUserEdit write-back hook", () => {
  it("fires with the reconciled artifact after a user edit", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("a1", "<p>hi</p>") });

    const spy = vi.fn();
    store.getState().setOnUserEdit(spy);
    store.getState().applyUserEvent({ type: "canvas.patch", id: "a1", patch: { html: "<p>edited</p>" } });

    expect(spy).toHaveBeenCalledTimes(1);
    const edited = spy.mock.calls[0][0] as Artifact;
    expect(edited.id).toBe("a1");
    expect((edited.data as { html: string }).html).toBe("<p>edited</p>");
  });

  it("does NOT fire for agent-driven updates (applyEvents / applyEvent)", () => {
    const store = createCanvasStore();
    const spy = vi.fn();
    store.getState().setOnUserEdit(spy);

    store.getState().applyEvents([
      { type: "canvas.create", artifact: htmlArtifact("a1", "<p>hi</p>") },
      { type: "canvas.replace", id: "a1", artifact: htmlArtifact("a1", "<p>v2</p>") },
    ]);
    store.getState().applyEvent({ type: "canvas.patch", id: "a1", patch: { html: "<p>agent</p>" } });

    expect(spy).not.toHaveBeenCalled();
  });

  it("stops firing once the handler is cleared", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("a1", "<p>hi</p>") });
    const spy = vi.fn();
    store.getState().setOnUserEdit(spy);
    store.getState().setOnUserEdit(null);
    store.getState().applyUserEvent({ type: "canvas.patch", id: "a1", patch: { html: "<p>x</p>" } });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("remote data writes are counted on meta.remoteSeq", () => {
  it("bumps for agent patches and not for the person's own edits", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("a1", "<p>hi</p>") });
    expect(store.getState().canvas.artifacts.a1.meta?.remoteSeq).toBe(1);
    store.getState().applyEvent({ type: "canvas.patch", id: "a1", patch: { html: "<p>agent</p>" } });
    expect(store.getState().canvas.artifacts.a1.meta?.remoteSeq).toBe(2);
    store.getState().applyUserEvent({ type: "canvas.patch", id: "a1", patch: { html: "<p>person</p>" } });
    expect(store.getState().canvas.artifacts.a1.meta?.remoteSeq).toBe(2);
    store.getState().applyEvent({ type: "canvas.commit", id: "a1", description: "saved", revision: "v2" });
    expect(store.getState().canvas.artifacts.a1.meta?.remoteSeq).toBe(2);
  });
});

describe("a busy canvas refuses hand edits", () => {
  it("drops applyUserEvent while busy and takes it again after", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("a1", "<p>hi</p>") });
    store.getState().setBusy(true);
    store.getState().applyUserEvent({ type: "canvas.patch", id: "a1", patch: { html: "<p>mine</p>" } });
    expect((store.getState().canvas.artifacts.a1.data as { html: string }).html).toBe("<p>hi</p>");
    store.getState().setBusy(false);
    store.getState().applyUserEvent({ type: "canvas.patch", id: "a1", patch: { html: "<p>mine</p>" } });
    expect((store.getState().canvas.artifacts.a1.data as { html: string }).html).toBe("<p>mine</p>");
  });
});

describe("undo is an edit of one file", () => {
  const edit = (store: ReturnType<typeof createCanvasStore>, id: string, html: string) =>
    store.getState().applyUserEvent({ type: "canvas.patch", id, patch: { html } });
  const html = (store: ReturnType<typeof createCanvasStore>, id: string) =>
    (store.getState().canvas.artifacts[id].data as { html: string }).html;

  it("steps back, reaches onUserEdit so the step is saved, and redo comes back", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("a1", "<p>0</p>") });
    edit(store, "a1", "<p>1</p>");
    edit(store, "a1", "<p>2</p>");
    const spy = vi.fn();
    store.getState().setOnUserEdit(spy);

    store.getState().undo();
    expect(html(store, "a1")).toBe("<p>1</p>");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as Artifact).id).toBe("a1");

    store.getState().redo();
    expect(html(store, "a1")).toBe("<p>2</p>");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("leaves the other files alone and is refused while the agent works", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("a1", "<p>a</p>") });
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("b1", "<p>b</p>") });
    edit(store, "b1", "<p>b2</p>");
    store.getState().setActiveArtifact("a1");
    store.getState().undo(); // a1 has no steps; b1's step must not be taken
    expect(html(store, "b1")).toBe("<p>b2</p>");

    store.getState().setActiveArtifact("b1");
    store.getState().setBusy(true);
    store.getState().undo();
    expect(html(store, "b1")).toBe("<p>b2</p>");
    store.getState().setBusy(false);
    store.getState().undo();
    expect(html(store, "b1")).toBe("<p>b</p>");
  });

  it("forgets the person's steps on a file once the agent writes it", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("a1", "<p>0</p>") });
    edit(store, "a1", "<p>1</p>");
    store.getState().applyEvent({ type: "canvas.patch", id: "a1", patch: { html: "<p>agent</p>" } });
    store.getState().undo();
    expect(html(store, "a1")).toBe("<p>agent</p>");
  });

  it("flushSaves hands pending saves through the registered flusher", async () => {
    const store = createCanvasStore();
    const flush = vi.fn(async () => {});
    store.getState().setSaveFlusher(flush);
    await store.getState().flushSaves();
    expect(flush).toHaveBeenCalledTimes(1);
    store.getState().setSaveFlusher(null);
    await store.getState().flushSaves(); // nothing registered is fine
  });
});

describe("view-only tab closing", () => {
  it("selects adjacent tabs, retains documents and reopens a closed document", () => {
    const store = createCanvasStore();
    for (const id of ["a", "b", "c"]) store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact(id, `<p>${id}</p>`) });
    const onUserEdit = vi.fn();
    store.getState().setOnUserEdit(onUserEdit);
    store.getState().setActiveArtifact("b");
    store.getState().closeArtifact("b");
    expect(store.getState().canvas.activeId).toBe("c");
    expect(store.getState().canvas.order).toEqual(["a", "b", "c"]);
    expect(store.getState().canvas.artifacts.b.data).toEqual({ html: "<p>b</p>" });
    expect(store.getState().canvas.history.b).toHaveLength(1);
    store.getState().closeArtifact("a");
    expect(store.getState().canvas.activeId).toBe("c");
    store.getState().closeArtifact("c");
    expect(store.getState().canvas.activeId).toBeNull();
    expect(onUserEdit).not.toHaveBeenCalled();
    store.getState().setActiveArtifact("b");
    expect(store.getState().canvas.activeId).toBe("b");
    expect(store.getState().closedArtifactIds).toEqual(["a", "c"]);
  });

  it("updates closed documents without reopening them and clears closure state on reset", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "canvas.create", artifact: htmlArtifact("a", "old") });
    store.getState().closeArtifact("a");
    store.getState().applyEvents([
      { type: "canvas.create", artifact: htmlArtifact("a", "new") },
      { type: "canvas.commit", id: "a", description: "Updated closed document", revision: "v2" },
    ]);
    expect(store.getState().canvas.activeId).toBeNull();
    expect(store.getState().canvas.artifacts.a.data).toEqual({ html: "new" });
    expect(store.getState().closedArtifactIds).toEqual(["a"]);
    store.getState().reset();
    expect(store.getState().closedArtifactIds).toEqual([]);
  });
});
