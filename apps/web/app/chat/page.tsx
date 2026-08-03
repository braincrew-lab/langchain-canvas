"use client";

/**
 * Chat demo — live against the reference server (`apps/server`, port 8000) by
 * default, or straight against a LangGraph server when
 * `NEXT_PUBLIC_LANGGRAPH_URL` is set (see `examples/deepagents-canvas`). The
 * canvas is persistent per thread: on load the stored history is replayed
 * (hydration), and hand edits are saved back as described commits. Scripted
 * offline playback lives on the `/replay` page.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Canvas,
  useCanvasStore,
  useCanvasStream,
  type Artifact,
  type CanvasSaveHandler,
  type StreamEvent,
} from "@braincrew-lab/langchain-canvas";
import { langgraphTransport } from "@braincrew-lab/langchain-canvas/langgraph";

import { Chat } from "../../components/Chat";

const SUGGESTIONS = [
  "Build a SaaS pricing page",
  "Write a report on the EV market",
  "Chart quarterly revenue: 12, 18, 24, 30",
  "Compare the latest models in a table",
  "Design a 3-slide pitch deck",
];

/** Store server: chat (default mode) + canvas hydrate/save (both modes). */
const SERVER = process.env.NEXT_PUBLIC_CANVAS_SERVER ?? "http://localhost:8000";
/** Set to a LangGraph server URL (e.g. http://127.0.0.1:2024) to chat directly. */
const LANGGRAPH_URL = process.env.NEXT_PUBLIC_LANGGRAPH_URL;
const LANGGRAPH_ASSISTANT = process.env.NEXT_PUBLIC_LANGGRAPH_ASSISTANT ?? "canvas_agent";

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
  const transport = useMemo(
    () =>
      LANGGRAPH_URL
        ? langgraphTransport({ url: LANGGRAPH_URL, assistantId: LANGGRAPH_ASSISTANT })
        : undefined,
    [],
  );
  const stream = useCanvasStream({ transport, endpoint: `${SERVER}/api/chat`, threadId });
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

  // The stored source files (user uploads) — shown so "what the agent can see"
  // is never a mystery.
  const [sources, setSources] = useState<{ path: string; size: number }[]>([]);
  const refreshSources = useCallback(() => {
    if (threadId === "ssr") return;
    fetch(`${SERVER}/api/canvas/${threadId}/files`)
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then(({ files }: { files: { path: string; size: number }[] }) =>
        setSources(files.filter((f) => f.path.startsWith("sources/"))),
      )
      .catch(() => {});
  }, [threadId]);
  useEffect(refreshSources, [refreshSources]);

  // Opened files upload to the store under sources/ so the agent can read them.
  const handleFilesOpened = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        void fetch(`${SERVER}/api/canvas/${threadId}/upload`, { method: "POST", body: form })
          .then(refreshSources)
          .catch(() => {});
      }
    },
    [threadId, refreshSources],
  );

  // POST one save body; on success stamp the described commit onto the artifact.
  const postSave = useCallback(
    async (artifactId: string, body: Record<string, unknown>) => {
      const res = await fetch(`${SERVER}/api/canvas/${threadId}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return; // 409 = stale — the next agent read still wins
      const { revision, description, changed } = await res.json();
      if (changed === false) return; // no-op save (e.g. an editor's mount re-serialization)
      applyEvent({ type: "canvas.commit", id: artifactId, description, revision });
    },
    [threadId, applyEvent],
  );

  /** Store path for a table artifact's working copy. */
  const tablePath = (artifactId: string) =>
    artifactId.endsWith(".table.json")
      ? artifactId
      : `${artifactId.replace(/[^a-zA-Z0-9._-]/g, "-")}.table.json`;

  // Persist hand edits as described commits. Pages save raw html; tables save
  // the artifact envelope to a `.table.json` file; text-source previews
  // (sources/*.md and friends) write their text back to the source file.
  const handleSave = useCallback<CanvasSaveHandler>(
    async ({ artifactId, artifact, baseRevision }) => {
      const html = (artifact.data as { html?: string }).html;
      if (typeof html === "string") {
        await postSave(artifactId, { html, baseRevision, path: artifactId });
      } else if (artifact.type === "table") {
        await postSave(artifactId, {
          artifact: { type: "table", title: artifact.title, data: artifact.data },
          baseRevision,
          path: tablePath(artifactId),
        });
      } else if (artifact.type === "document" && artifactId.startsWith("sources/")) {
        const content = (artifact.data as { content?: string }).content;
        if (typeof content !== "string") return;
        await postSave(artifactId, { text: content, baseRevision, path: artifactId });
      }
    },
    [postSave],
  );

  // An imported table (csv/xlsx) persists a working copy right away, so it
  // survives reloads and the agent can read it — the original bytes land under
  // sources/ via the upload above.
  const handleImported = useCallback(
    (artifact: Artifact) => {
      if (artifact.type !== "table") return;
      void postSave(artifact.id, {
        artifact: { type: "table", title: artifact.title, data: artifact.data },
        path: tablePath(artifact.id),
        description: `Open ${artifact.title}`,
      });
    },
    [postSave],
  );

  return (
    <main className="app">
      <section className="app__chat">
        <div className="chat__banner">Live mode — the canvas persists across reloads.</div>
        {sources.length > 0 && (
          <div className="chat__sources">
            Files the agent can read:{" "}
            {sources.map((s) => s.path.slice("sources/".length)).join(" · ")}
          </div>
        )}
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
        <Canvas
          onEditElement={stream.editSelection}
          onSave={handleSave}
          onFilesOpened={handleFilesOpened}
          onImported={handleImported}
        />
      </section>
    </main>
  );
}
