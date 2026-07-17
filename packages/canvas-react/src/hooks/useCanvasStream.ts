/**
 * `useCanvasStream` — the one hook an app needs.
 *
 * It owns the chat thread: send a message, and it streams the agent's response
 * into the store (transcript + canvas) until the server says `done`. Components
 * read `messages` / `canvas` from the returned slices and render; they never
 * touch the wire.
 *
 *     const { sendMessage, messages, canvas, isStreaming } = useCanvasStream();
 *
 * Performance: incoming events are coalesced and flushed once per animation
 * frame, so a burst of token deltas produces one re-render per frame rather than
 * one per token — smooth streaming even at high token rates.
 */

import { useCallback, useEffect, useRef } from "react";

import type { StreamEvent } from "../protocol/events";
import type { ElementSelection } from "../protocol/selection";
import { streamChat } from "../client/sse-client";
import { mockStream } from "../client/mock";
import { useCanvasStore, useCanvasStoreApi } from "./useCanvasStore";

export interface UseCanvasStreamOptions {
  /** Chat SSE endpoint. Defaults to `/api/chat`. */
  endpoint?: string;
  /** Conversation thread id (for server-side memory). Defaults to a fresh uuid. */
  threadId?: string;
  /**
   * Offline mock: given the user's message, return a scripted `StreamEvent[]`
   * to play instead of hitting the network — an OpenAPI-style "try it" with no
   * real LLM call. Return `null` to fall through to the live endpoint.
   */
  mock?: (message: string) => StreamEvent[] | null;
}

export function useCanvasStream(options: UseCanvasStreamOptions = {}) {
  const endpoint = options.endpoint ?? "/api/chat";
  const threadIdRef = useRef(options.threadId ?? crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);
  const api = useCanvasStoreApi();

  // --- frame-batched event application ------------------------------------------
  const queueRef = useRef<StreamEvent[]>([]);
  const frameRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    frameRef.current = null;
    if (queueRef.current.length === 0) return;
    const batch = queueRef.current;
    queueRef.current = [];
    api.getState().applyEvents(batch);
  }, [api]);

  const enqueue = useCallback(
    (event: StreamEvent) => {
      queueRef.current.push(event);
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush);
      }
    },
    [flush],
  );

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  // --- store slices -------------------------------------------------------------
  const messages = useCanvasStore((s) => s.messages);
  const canvas = useCanvasStore((s) => s.canvas);
  const isStreaming = useCanvasStore((s) => s.isStreaming);
  const error = useCanvasStore((s) => s.error);
  const selections = useCanvasStore((s) => s.selections);

  const sendMessage = useCallback(
    async (text: string, withSelections?: ElementSelection[]) => {
      const store = api.getState();
      if (store.isStreaming || !text.trim()) return;

      store.addUserMessage(text);
      store.setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const mockEvents = options.mock?.(text) ?? null;
        const stream = mockEvents
          ? mockStream(mockEvents, { delayMs: 60, signal: controller.signal })
          : streamChat(
              endpoint,
              { threadId: threadIdRef.current, message: text, selections: withSelections },
              { signal: controller.signal },
            );
        for await (const event of stream) {
          enqueue(event);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          enqueue({ type: "error", message: err instanceof Error ? err.message : "stream failed" });
        }
      } finally {
        flush(); // drain any tail events immediately
        api.getState().setStreaming(false);
      }
    },
    [api, endpoint, enqueue, flush, options.mock],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => api.getState().reset(), [api]);
  const setActiveArtifact = useCallback((id: string) => api.getState().setActiveArtifact(id), [api]);
  const clearSelection = useCallback(() => api.getState().setSelections([]), [api]);

  /** Send a targeted edit for the currently-selected element(s), then clear. */
  const editSelection = useCallback(
    (instruction: string) => {
      const current = api.getState().selections;
      if (current.length === 0) return;
      void sendMessage(instruction, current);
      api.getState().setSelections([]);
    },
    [api, sendMessage],
  );

  return {
    sendMessage,
    stop,
    reset,
    setActiveArtifact,
    selections,
    editSelection,
    clearSelection,
    messages,
    canvas,
    isStreaming,
    error,
    threadId: threadIdRef.current,
  };
}
