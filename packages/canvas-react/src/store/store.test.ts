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
