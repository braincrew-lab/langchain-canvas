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

import { ChevronRight, LayoutDashboard } from "lucide-react";
import { useRef, useState } from "react";

import { Canvas, IMPORTABLE_EXTENSIONS, scenarios, useCanvasImport, useCanvasReplay } from "@braincrew-lab/langchain-canvas";

import { FALLBACK_SCENARIO_ICON, SCENARIO_ICONS } from "../../lib/ui-constants";

export default function ReplayPage() {
  const { play, isPlaying } = useCanvasReplay();
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { importFiles } = useCanvasImport({
    onImportError: (file, err) => setError(`${file.name}: ${err.message}`),
  });

  const playScenario = (scenario: (typeof scenarios)[number]) => {
    setSelectedId(scenario.id);
    void play(scenario.events, { delayMs: 140 });
  };

  return (
    <main className="app">
      <section className="app__chat">
        <div className="replay">
          <div className="pane__head">
            <h1>Schema replay</h1>
            <p>
              Render the canvas from wire-event fixtures — no backend, no API key. Each scenario is
              just <code>StreamEvent</code>s, exactly what a LangGraph agent would emit.
            </p>
          </div>
          {error && (
            <p className="pane__error" role="alert">
              {error}
            </p>
          )}
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
          <p className="pane__label">Scenarios</p>
          <ul className="scenario-list">
            {scenarios.map((scenario) => {
              const Icon = SCENARIO_ICONS[scenario.id] ?? FALLBACK_SCENARIO_ICON;
              return (
                <li key={scenario.id}>
                  <button
                    className="scenario"
                    disabled={isPlaying}
                    aria-current={scenario.id === selectedId || undefined}
                    onClick={() => playScenario(scenario)}
                  >
                    <span className="scenario__icon">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <span className="scenario__text">
                      <b>{scenario.title}</b>
                      <span>{scenario.description}</span>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" className="scenario__chev" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
      <section className="app__canvas">
        <Canvas
          emptyState={
            <div className="cv-empty">
              <div className="cv-empty__icon" aria-hidden="true">
                <LayoutDashboard size={24} />
              </div>
              <p className="cv-empty__title">Nothing on the canvas</p>
              <p className="cv-empty__hint">Pick a scenario on the left or drop a file.</p>
              <div className="cv-empty__buttons">
                <button className="cv-empty__open" onClick={() => inputRef.current?.click()}>
                  Open file
                </button>
                <button
                  className="cv-empty__secondary"
                  onClick={() => {
                    const slidesScenario = scenarios.find((scenario) => scenario.id === "slides");
                    if (slidesScenario) playScenario(slidesScenario);
                  }}
                >
                  Play sample deck
                </button>
              </div>
              <p className="cv-empty__formats">CSV · Markdown · HTML · Slides · JSON</p>
            </div>
          }
        />
      </section>
    </main>
  );
}
