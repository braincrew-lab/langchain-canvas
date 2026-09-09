/**
 * Test-only entry for the mounted-editor gate (`mountedParity.browser.test.ts`).
 *
 * Mounts the REAL `<Canvas>` — the same store, provider, renderer registry
 * and stylesheet a host app uses — with the shared parity deck loaded through
 * a `canvas.create` event, so the gate measures the editor's main stage and
 * its rail thumbnail as they are actually drawn, not a style helper.
 * Served by a Vite dev server the test starts; never part of the package.
 */

// @ts-expect-error — react-dom ships no types here and this package adds no
// devDependency for a test entry; the runtime import is real (same as chrome.test.tsx).
import { createRoot } from "react-dom/client";

import { Canvas } from "../../components/Canvas";
import type { Artifact, SlidesData } from "../../protocol/artifacts";
import { CanvasProvider } from "../../store/context";
import { createCanvasStore } from "../../store/store";
import "../../styles/canvas.css";
import parityDeck from "../__fixtures__/parity-deck.slides.json";
import snugDeck from "../__fixtures__/snug-bullet.slides.json";

/** `mount.html?artifact=document` mounts a document (the Word page, M7)
 *  instead of the slides deck — a short inline markdown body is enough to
 *  draw `.cv-word__page`, which is what the gate measures. */
const DOCUMENT_MARKDOWN = "# 협업 제안서\n\n본 문서는 **브레인크루**와 협업 범위를 정리한다.\n\n- 항목 A\n- 항목 B\n";

const params = new URLSearchParams(location.search);
const wantsDocument = params.get("artifact") === "document";
// `mount.html?deck=snug-bullet` mounts the snug bullet one-liner deck
// (`snugBullet.browser.test.ts`) instead of the parity deck.
const deck = params.get("deck") === "snug-bullet" ? snugDeck : parityDeck;

const artifact: Artifact = wantsDocument
  ? {
      id: "parity-doc",
      type: "document",
      title: "parity-document",
      version: 1,
      status: "complete",
      data: { format: "markdown", content: DOCUMENT_MARKDOWN },
    }
  : {
      id: "parity",
      type: "slides",
      title: deck.title,
      version: 1,
      status: "complete",
      data: deck.data as SlidesData,
    };

const store = createCanvasStore();
store.getState().applyEvent({ type: "canvas.create", artifact });

const host = document.getElementById("root");
if (!host) throw new Error("mount.html has no #root");
createRoot(host).render(
  <CanvasProvider store={store}>
    <Canvas />
  </CanvasProvider>,
);
