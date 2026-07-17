/**
 * `useCanvasReplay` — drive the canvas from a schema fixture instead of a live
 * agent. Use it to build and demo the UI with zero backend.
 *
 *     const { play, canvas, isPlaying } = useCanvasReplay();
 *     play(pricingPageScenario.events);   // renders exactly as the wire would
 *
 * It shares the same store and reconciler as `useCanvasStream`, so `<Canvas />`
 * renders identically whether events come from a fixture or a real LangGraph run.
 */

import { useCallback, useRef } from "react";

import type { StreamEvent } from "../protocol/events";
import { mockStream, type MockStreamOptions } from "../client/mock";
import { useCanvasStore, useCanvasStoreApi } from "./useCanvasStore";

export function useCanvasReplay() {
  const abortRef = useRef<AbortController | null>(null);
  const api = useCanvasStoreApi();

  const canvas = useCanvasStore((s) => s.canvas);
  const isPlaying = useCanvasStore((s) => s.isStreaming);

  const play = useCallback(
    async (events: StreamEvent[], options: MockStreamOptions = {}) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const store = api.getState();
      store.reset();
      store.setStreaming(true);

      try {
        for await (const event of mockStream(events, { ...options, signal: controller.signal })) {
          api.getState().applyEvent(event);
        }
      } finally {
        api.getState().setStreaming(false);
      }
    },
    [api],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => api.getState().reset(), [api]);

  return { play, stop, reset, canvas, isPlaying };
}
