"use client";

/**
 * Chat demo — the same UI a real app would ship, but running in **mock mode**:
 * pressing a prompt plays a scripted response (assistant text + canvas events)
 * with no LLM call, like an OpenAPI "try it out". Point `useCanvasStream` at a
 * real `/api/chat` (drop the `mock` option) to go live.
 */

import { Canvas, scenarios, useCanvasStream, type StreamEvent } from "@braincrew-lab/langchain-canvas";

import { Chat } from "../../components/Chat";

const SUGGESTIONS = [
  "Build a SaaS pricing page",
  "Write a report on the EV market",
  "Chart quarterly revenue: 12, 18, 24, 30",
  "Compare the latest models in a table",
  "Design a 3-slide pitch deck",
];

/** Map a prompt to a scenario + a canned reply. */
const ROUTES: { match: RegExp; scenarioId: string; reply: string }[] = [
  { match: /page|landing|pricing|site|웹|페이지/i, scenarioId: "html-page", reply: "Built a pricing page — click any element on the canvas to edit it." },
  { match: /report|essay|write|문서|리포트|글/i, scenarioId: "document", reply: "Drafted a markdown report on the canvas." },
  { match: /chart|graph|revenue|trend|차트|매출|그래프/i, scenarioId: "chart", reply: "Charted quarterly revenue on the canvas." },
  { match: /table|compare|grid|표|비교/i, scenarioId: "table", reply: "Rendered a comparison table on the canvas." },
  { match: /slide|deck|present|ppt|pptx|프레젠|슬라이드|발표/i, scenarioId: "slides", reply: "Built a slide deck — every element is movable; drag to rearrange, then Present or export." },
];

/** Offline resolver: assistant reply + the scenario's canvas events, no network. */
function mockResolver(text: string): StreamEvent[] {
  const route = ROUTES.find((r) => r.match.test(text)) ?? ROUTES[0];
  const scenario = scenarios.find((s) => s.id === route.scenarioId)!;
  const id = crypto.randomUUID();
  const canvasEvents = scenario.events.filter(
    (e) => e.type.startsWith("canvas.") && e.type !== "canvas.node_patch",
  );
  return [
    { type: "message.delta", messageId: id, text: route.reply },
    { type: "message.end", messageId: id },
    ...canvasEvents,
    { type: "done" },
  ];
}

export default function ChatPage() {
  const stream = useCanvasStream({ endpoint: "/api/chat", mock: mockResolver });

  return (
    <main className="app">
      <section className="app__chat">
        <div className="chat__banner">Mock mode — responses are simulated, no LLM call.</div>
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
        <Canvas onEditElement={stream.editSelection} />
      </section>
    </main>
  );
}
