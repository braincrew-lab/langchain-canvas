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
