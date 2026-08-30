import { describe, expect, it, vi } from "vitest";

import { createCanvasStore } from "./store";
import type { Artifact } from "../protocol/artifacts";

function htmlArtifact(id: string, html: string): Artifact {
  return { id, type: "html", title: "Page", version: 1, status: "complete", data: { html } };
}

function deckArtifact(id: string, html: string): Artifact {
  return { id, type: "slides", title: "Deck", version: 1, status: "complete", data: { html }, meta: { kind: "deck" } };
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

  it("fires with the reconciled artifact after a deck slide_patch (doc_edit path)", () => {
    const store = createCanvasStore();
    const deckHtml = '<!doctype html><html><body><template data-slide-id="s1"><h1>A</h1></template></body></html>';
    store.getState().applyEvent({ type: "canvas.create", artifact: deckArtifact("d1", deckHtml) });

    const spy = vi.fn();
    store.getState().setOnUserEdit(spy);
    store.getState().applyUserEvent({
      type: "canvas.slide_patch",
      id: "d1",
      slideId: "s1",
      templateHtml: '<template data-slide-id="s1"><h1>Edited</h1></template>',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const edited = spy.mock.calls[0][0] as Artifact;
    expect(edited.id).toBe("d1");
    expect((edited.data as { html: string }).html).toContain("<h1>Edited</h1>");
  });
});

describe("store undo/redo — canvas.slide_patch", () => {
  it("undoes and redoes a deck structural edit (doc_edit -> slide_patch)", () => {
    const store = createCanvasStore();
    const originalHtml =
      '<!doctype html><html><body>' +
      '<template data-slide-id="s1"><h1>A</h1></template>' +
      '<template data-slide-id="s2"><h1>B</h1></template>' +
      '</body></html>';
    store.getState().applyEvent({ type: "canvas.create", artifact: deckArtifact("d1", originalHtml) });

    store.getState().applyUserEvent({
      type: "canvas.slide_patch",
      id: "d1",
      slideId: "s1",
      templateHtml: '<template data-slide-id="s1"><h1>Edited</h1></template>',
    });

    const patchedHtml = (store.getState().canvas.artifacts.d1.data as { html: string }).html;
    expect(patchedHtml).toContain("<h1>Edited</h1>");
    expect(patchedHtml).toContain("<h1>B</h1>"); // the other slide is untouched

    store.getState().undo();
    expect((store.getState().canvas.artifacts.d1.data as { html: string }).html).toBe(originalHtml);

    store.getState().redo();
    expect((store.getState().canvas.artifacts.d1.data as { html: string }).html).toBe(patchedHtml);
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

describe("activeTool status line", () => {
  it("sets activeTool on tool.start", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "tool.start", toolCallId: "c1", name: "write_slides" });
    expect(store.getState().activeTool).toEqual({ toolCallId: "c1", name: "write_slides" });
  });

  it("tracks slide_status generating while updating the artifact's slideStatus meta", () => {
    const store = createCanvasStore();
    const deckHtml = '<!doctype html><html><body><template data-slide-id="slide-003"><h1>A</h1></template></body></html>';
    store.getState().applyEvent({ type: "canvas.create", artifact: deckArtifact("d1", deckHtml) });
    store.getState().applyEvent({ type: "tool.start", toolCallId: "c1", name: "write_slides" });

    store.getState().applyEvent({
      type: "canvas.slide_status",
      id: "d1",
      slideId: "slide-003",
      stage: "generating",
    });

    expect(store.getState().activeTool).toEqual({ toolCallId: "c1", name: "write_slides", slideId: "slide-003", stage: "generating" });
    const meta = store.getState().canvas.artifacts.d1?.meta as { slideStatus?: Record<string, { stage: string }> };
    expect(meta.slideStatus?.["slide-003"]?.stage).toBe("generating");
  });

  it("keeps slideId through verifying, then clears slideId/stage (keeping name) on complete", () => {
    const store = createCanvasStore();
    const deckHtml = '<!doctype html><html><body><template data-slide-id="slide-003"><h1>A</h1></template></body></html>';
    store.getState().applyEvent({ type: "canvas.create", artifact: deckArtifact("d1", deckHtml) });
    store.getState().applyEvent({ type: "tool.start", toolCallId: "c1", name: "write_slides" });
    store.getState().applyEvent({ type: "canvas.slide_status", id: "d1", slideId: "slide-003", stage: "generating" });

    store.getState().applyEvent({ type: "canvas.slide_status", id: "d1", slideId: "slide-003", stage: "verifying" });
    expect(store.getState().activeTool).toEqual({ toolCallId: "c1", name: "write_slides", slideId: "slide-003", stage: "verifying" });

    store.getState().applyEvent({ type: "canvas.slide_status", id: "d1", slideId: "slide-003", stage: "complete" });
    expect(store.getState().activeTool).toEqual({ toolCallId: "c1", name: "write_slides" });
  });

  it("stays null on slide_status with no activeTool, but still updates artifact meta", () => {
    const store = createCanvasStore();
    const deckHtml = '<!doctype html><html><body><template data-slide-id="slide-003"><h1>A</h1></template></body></html>';
    store.getState().applyEvent({ type: "canvas.create", artifact: deckArtifact("d1", deckHtml) });

    store.getState().applyEvent({ type: "canvas.slide_status", id: "d1", slideId: "slide-003", stage: "generating" });

    expect(store.getState().activeTool).toBeNull();
    const meta = store.getState().canvas.artifacts.d1?.meta as { slideStatus?: Record<string, { stage: string }> };
    expect(meta.slideStatus?.["slide-003"]?.stage).toBe("generating");
  });

  it("clears activeTool on matching tool.end; leaves it on mismatched id", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "tool.start", toolCallId: "c1", name: "write_slides" });

    store.getState().applyEvent({ type: "tool.end", toolCallId: "c2", ok: true });
    expect(store.getState().activeTool).toEqual({ toolCallId: "c1", name: "write_slides" });

    store.getState().applyEvent({ type: "tool.end", toolCallId: "c1", ok: true });
    expect(store.getState().activeTool).toBeNull();
  });

  it("clears activeTool on done and error", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "tool.start", toolCallId: "c1", name: "write_slides" });
    store.getState().applyEvent({ type: "done" });
    expect(store.getState().activeTool).toBeNull();

    store.getState().applyEvent({ type: "tool.start", toolCallId: "c2", name: "write_slides" });
    store.getState().applyEvent({ type: "error", message: "boom" });
    expect(store.getState().activeTool).toBeNull();
  });

  it("clears activeTool on setStreaming(false) and reset()", () => {
    const store = createCanvasStore();
    store.getState().applyEvent({ type: "tool.start", toolCallId: "c1", name: "write_slides" });
    store.getState().setStreaming(false);
    expect(store.getState().activeTool).toBeNull();

    store.getState().applyEvent({ type: "tool.start", toolCallId: "c2", name: "write_slides" });
    store.getState().reset();
    expect(store.getState().activeTool).toBeNull();
  });

  it("a second tool.start fully replaces activeTool with no stale slideId leak", () => {
    const store = createCanvasStore();
    const deckHtml = '<!doctype html><html><body><template data-slide-id="slide-003"><h1>A</h1></template></body></html>';
    store.getState().applyEvent({ type: "canvas.create", artifact: deckArtifact("d1", deckHtml) });
    store.getState().applyEvent({ type: "tool.start", toolCallId: "c1", name: "write_slides" });
    store.getState().applyEvent({ type: "canvas.slide_status", id: "d1", slideId: "slide-003", stage: "generating" });

    store.getState().applyEvent({ type: "tool.start", toolCallId: "c2", name: "write_slides" });
    expect(store.getState().activeTool).toEqual({ toolCallId: "c2", name: "write_slides" });
  });

  it("applyEvents batches tool.start + slide_status and reflects slideId in one write", () => {
    const store = createCanvasStore();
    const deckHtml = '<!doctype html><html><body><template data-slide-id="slide-003"><h1>A</h1></template></body></html>';
    store.getState().applyEvent({ type: "canvas.create", artifact: deckArtifact("d1", deckHtml) });

    store.getState().applyEvents([
      { type: "tool.start", toolCallId: "c1", name: "write_slides" },
      { type: "canvas.slide_status", id: "d1", slideId: "slide-003", stage: "generating" },
    ]);

    expect(store.getState().activeTool).toEqual({ toolCallId: "c1", name: "write_slides", slideId: "slide-003", stage: "generating" });
  });
});
