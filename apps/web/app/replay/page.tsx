"use client";

/**
 * Schema replay demo — renders the canvas purely from wire-event fixtures.
 * No backend, no LLM, no API key. Open /replay and click a scenario.
 *
 * This is the "schema → screen" path: the canvas is defined by the protocol, so
 * a fixture drives it exactly as a real LangGraph agent would. A persistent
 * "Open file" control lets you upload any importable file (CSV, Markdown, HTML,
 * *.slides.html, JSON) and see it render identically to a streamed artifact.
 */

import { useRef, useState } from "react";

import { Canvas, IMPORTABLE_EXTENSIONS, scenarios, useCanvasImport, useCanvasReplay } from "@braincrew-lab/langchain-canvas";

export default function ReplayPage() {
  const { play, isPlaying } = useCanvasReplay();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { importFiles } = useCanvasImport({
    onImportError: (file, err) => setError(`${file.name}: ${err.message}`),
  });

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
          <button className="replay__open" onClick={() => inputRef.current?.click()}>
            Open file
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept={IMPORTABLE_EXTENSIONS.join(",")}
            aria-label="Open a file on the canvas"
            onChange={(e) => {
              if (e.target.files?.length) {
                setError(null);
                importFiles(e.target.files);
              }
              e.target.value = "";
            }}
          />
          <p className="replay__formats">CSV · Markdown · HTML · Slides (.slides.html) · JSON</p>
          {error && (
            <p className="replay__error" role="alert">
              {error}
            </p>
          )}
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
        <Canvas emptyState={<p>Pick a scenario on the left or open a file</p>} />
      </section>
    </main>
  );
}
