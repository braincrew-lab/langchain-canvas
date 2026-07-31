"use client";

/**
 * Chat demo — live against the reference server (`apps/server`, port 8000).
 * The canvas is persistent per thread: on load the stored history is replayed
 * (hydration), and hand edits are saved back as described commits. Scripted
 * offline playback lives on the `/replay` page.
 */

import { useCallback, useEffect, useState } from "react";

import {
  Canvas,
  useCanvasStore,
  useCanvasStream,
  type CanvasSaveHandler,
  type StreamEvent,
} from "@braincrew-lab/langchain-canvas";

import { Chat } from "../../components/Chat";

const SUGGESTIONS = [
  "Build a SaaS pricing page",
  "Write a report on the EV market",
  "Chart quarterly revenue: 12, 18, 24, 30",
  "Compare the latest models in a table",
  "Design a 3-slide pitch deck",
];

const SERVER = "http://localhost:8000";

/** Stable per-browser thread id so the canvas survives reloads. */
function usePersistentThreadId(): string {
  const [id] = useState(() => {
    if (typeof window === "undefined") return "ssr";
    const existing = window.localStorage.getItem("canvas-demo-thread");
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem("canvas-demo-thread", fresh);
    return fresh;
  });
  return id;
}

export default function ChatPage() {
  const threadId = usePersistentThreadId();
  const stream = useCanvasStream({ endpoint: `${SERVER}/api/chat`, threadId });
  const applyEvents = useCanvasStore((s) => s.applyEvents);
  const applyEvent = useCanvasStore((s) => s.applyEvent);

  // Hydrate: rebuild the stored canvas (artifacts + described versions) on load.
  useEffect(() => {
    if (threadId === "ssr") return;
    fetch(`${SERVER}/api/canvas/${threadId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((events: StreamEvent[]) => events.length && applyEvents(events))
      .catch(() => {});
  }, [threadId, applyEvents]);

  // Persist hand edits as described commits; stamp the new revision back in.
  const handleSave = useCallback<CanvasSaveHandler>(
    async ({ artifactId, artifact, baseRevision }) => {
      const html = (artifact.data as { html?: string }).html;
      if (typeof html !== "string") return;
      const res = await fetch(`${SERVER}/api/canvas/${threadId}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, baseRevision, path: artifactId }),
      });
      if (!res.ok) return; // 409 = stale — the next agent read still wins
      const { revision, description } = await res.json();
      applyEvent({ type: "canvas.commit", id: artifactId, description, revision });
    },
    [threadId, applyEvent],
  );

  return (
    <main className="app">
      <section className="app__chat">
        <div className="chat__banner">Live mode — the canvas persists across reloads.</div>
        <Chat
          messages={stream.messages}
          isStreaming={stream.isStreaming}
          error={stream.error}
          onSend={stream.sendMessage}
          onStop={stream.stop}
          onReset={stream.reset}
          suggestions={SUGGESTIONS}
        />
      </section>
      <section className="app__canvas">
        <Canvas onEditElement={stream.editSelection} onSave={handleSave} />
      </section>
    </main>
  );
}
