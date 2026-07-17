"use client";

/**
 * Schema replay demo — renders the canvas purely from wire-event fixtures.
 * No backend, no LLM, no API key. Open /replay and click a scenario.
 *
 * This is the "schema → screen" path: the canvas is defined by the protocol, so
 * a fixture drives it exactly as a real LangGraph agent would.
 */

import { Canvas, scenarios, useCanvasReplay } from "@langchain-canvas/react";

export default function ReplayPage() {
  const { play, isPlaying } = useCanvasReplay();

  return (
    <main className="app">
      <section className="app__chat">
        <div className="replay">
          <header className="chat__header">
            <h1>Schema replay</h1>
          </header>
          <p className="replay__lead">
            Render the canvas from wire-event fixtures — no backend, no API key. Each scenario is
            just <code>StreamEvent</code>s, exactly what a LangGraph agent would emit.
          </p>
          {scenarios.map((scenario) => (
            <button
              key={scenario.id}
              className="replay__item"
              disabled={isPlaying}
              onClick={() => play(scenario.events, { delayMs: 140 })}
            >
              <b>{scenario.title}</b>
              <span>{scenario.description}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="app__canvas">
        <Canvas />
      </section>
    </main>
  );
}
