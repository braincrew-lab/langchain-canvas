"use client";

/**
 * Home = the Schema Explorer — a Swagger-style, official-docs view of the Canvas
 * Wire Protocol. It's what you see when the server starts.
 *
 * For each artifact type it documents, side by side:
 *   ①  the backend call an agent makes (Python)
 *   ②  the artifact envelope every artifact shares (property table)
 *   ③  the type's `data` schema + a property table (name / type / required / description)
 *   ④  the wire events it emits (editable JSON — "try it out")
 *   →   the live rendered canvas
 *
 * Edit the JSON and the canvas re-renders instantly.
 */

import { useEffect, useMemo, useState } from "react";
import { Canvas, scenarios, useCanvasReplay, type StreamEvent } from "@braincrew-lab/langchain-canvas";

interface Prop {
  name: string;
  type: string;
  required: boolean;
  desc: string;
}

interface Doc {
  type: string;
  pyCall: string;
  schema: string;
  props: Prop[];
}

/** Every artifact shares this envelope, whatever its `type`. */
const ARTIFACT_PROPS: Prop[] = [
  { name: "id", type: "string", required: true, desc: "Stable identity — the reconciliation key. Same id → update in place; new id → new artifact." },
  { name: "type", type: "string", required: true, desc: 'Registry key that selects the renderer ("html" | "document" | "chart" | "table" | …).' },
  { name: "title", type: "string", required: true, desc: "Shown in the canvas header and tab." },
  { name: "version", type: "number", required: true, desc: "1-based; bumped on every canvas.replace. Drives the version rail." },
  { name: "status", type: '"streaming" | "complete" | "error"', required: true, desc: "Lifecycle state; shown as a badge." },
  { name: "data", type: "object", required: true, desc: "Type-specific payload the renderer reads (see the table below)." },
  { name: "meta", type: "object", required: false, desc: "Free-form metadata; ignored by the renderer unless you use it." },
];

/** Friendly Office names shown on the tabs (the wire `type` stays lowercase). */
const LABELS: Record<string, string> = {
  "html-page": "Web",
  document: "Word",
  chart: "Chart",
  table: "Excel",
  slides: "PowerPoint",
};

/** Per-scenario docs: the Python call, the `data` schema, and its properties. */
const DOCS: Record<string, Doc> = {
  "html-page": {
    type: "html",
    pyCall: `canvas = Canvas.from_runtime(runtime)
page = canvas.open_html(title="Pricing")
page.set_html("<!doctype html> …")
page.complete()
# targeted edit:
canvas.html(page.id).patch_node("e-0-0", "<h1 …>New title</h1>")`,
    schema: `// type: "html"  — the base substrate (sandboxed iframe)
type HtmlData = { html: string };`,
    props: [
      { name: "html", type: "string", required: true, desc: "Full HTML document, rendered in a sandboxed iframe. Every element is auto-stamped with a data-cid so it can be hovered, selected, and edited." },
    ],
  },
  document: {
    type: "document",
    pyCall: `doc = canvas.open_document(title="EV market report")
for chunk in model.stream(prompt):
    doc.append(chunk)          # streams token-by-token
doc.complete()`,
    schema: `// type: "document"
type DocumentData = { format: "markdown"; content: string };`,
    props: [
      { name: "format", type: '"markdown"', required: true, desc: "Content format. Only markdown today." },
      { name: "content", type: "string", required: true, desc: "The markdown body. Grown live via canvas.append during streaming." },
    ],
  },
  chart: {
    type: "chart",
    pyCall: `chart = canvas.open_chart(
    title="Quarterly revenue", chart="bar", x_key="quarter",
    series=[ChartSeries(key="amount", label="Revenue ($M)")])
chart.set_rows(rows)
chart.complete()`,
    schema: `// type: "chart"
type ChartData = {
  chart: "line" | "bar" | "area" | "pie";
  rows: Array<Record<string, string | number>>;
  xKey: string;
  series: Array<{ key: string; label?: string; color?: string }>;
  options?: { stacked?: boolean; yLabel?: string };
};`,
    props: [
      { name: "chart", type: '"line" | "bar" | "area" | "pie"', required: true, desc: "Chart kind." },
      { name: "rows", type: "Array<Record<string, string | number>>", required: true, desc: "Tidy/long-form data rows, consumed directly by the chart." },
      { name: "xKey", type: "string", required: true, desc: "The row field used for the category / x-axis." },
      { name: "series", type: "Array<{ key; label?; color? }>", required: true, desc: "Each numeric column to plot. key → row field; label → legend; color → override." },
      { name: "options", type: "{ stacked?; yLabel? }", required: false, desc: "Stacking and y-axis label." },
    ],
  },
  table: {
    type: "table",
    pyCall: `table = canvas.open_table(
    title="Model comparison",
    columns=[TableColumn(key="model", label="Model"), …])
table.set_rows(rows)
table.complete()`,
    schema: `// type: "table"
type TableData = {
  columns: Array<{ key: string; label?: string; align?: "left"|"right"|"center" }>;
  rows: Array<Record<string, string | number>>;
};`,
    props: [
      { name: "columns", type: "Array<{ key; label?; align? }>", required: true, desc: "Column order + headers. key → row field; label → header text; align → cell alignment." },
      { name: "rows", type: "Array<Record<string, string | number>>", required: true, desc: "One object per row, keyed by column key." },
    ],
  },
  slides: {
    type: "slides",
    pyCall: `deck = canvas.open_slides(title="Q4 Review")
deck.set_slides([
    Slide(title="Q4 in review", bullets=["Revenue up 24% QoQ", …]),
    Slide(title="Next quarter", bullets=["Ship the mobile app", …]),
])
deck.complete()`,
    schema: `// type: "slides"
type Slide = {
  layout?: "title" | "content" | "section";
  title?: string;
  subtitle?: string;   // title / section layouts
  bullets?: string[];  // content layout
  notes?: string;      // speaker notes → .pptx notes pane
};
type SlidesData = { slides: Slide[] };`,
    props: [
      { name: "slides", type: "Slide[]", required: true, desc: "Ordered slides. Each has a layout (title / content / section), title, optional subtitle/bullets, and speaker notes. Renders as an editable deck (add / duplicate / delete) and exports to .pptx." },
    ],
  },
};

export default function ExplorerPage() {
  const { play } = useCanvasReplay();
  const [activeId, setActiveId] = useState(scenarios[0].id);

  const active = useMemo(() => scenarios.find((s) => s.id === activeId)!, [activeId]);
  const doc = DOCS[activeId];

  const [json, setJson] = useState(() => JSON.stringify(active.events, null, 2));
  const [error, setError] = useState<string | null>(null);

  // When the selected scenario changes, load its events into the editor.
  useEffect(() => {
    setJson(JSON.stringify(active.events, null, 2));
  }, [active]);

  // Parse + render (debounced) whenever the JSON changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const events = JSON.parse(json) as StreamEvent[];
        if (!Array.isArray(events)) throw new Error("Expected an array of events");
        setError(null);
        play(events, { delayMs: 0 });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Invalid JSON");
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [json, play]);

  return (
    <main className="explorer">
      <div className="explorer__left">
        <header className="explorer__head">
          <div className="explorer__headtext">
            <h1>Schema Explorer</h1>
            <p>Edit the events — the canvas re-renders live.</p>
          </div>
        </header>

        <nav className="explorer__tabs">
          {scenarios.map((s) => (
            <button
              key={s.id}
              className={`explorer__tab ${s.id === activeId ? "is-active" : ""}`}
              onClick={() => setActiveId(s.id)}
            >
              {LABELS[s.id] ?? DOCS[s.id]?.type ?? s.id}
            </button>
          ))}
        </nav>

        <div className="explorer__scroll">
          <p className="explorer__desc">{active.description}</p>

          <Section n="1" title="Agent calls this (Python)">
            <pre className="explorer__code">{doc.pyCall}</pre>
          </Section>

          <Section n="2" title="Artifact envelope">
            <p className="explorer__note">Every artifact — whatever its type — has these fields.</p>
            <PropTable props={ARTIFACT_PROPS} />
          </Section>

          <Section n="3" title={`${LABELS[activeId] ?? doc.type} — "${doc.type}" data`}>
            <pre className="explorer__code explorer__code--muted">{doc.schema}</pre>
            <PropTable props={doc.props} />
          </Section>

          <Section n="4" title="Wire events — try editing">
            <textarea
              className={`explorer__editor ${error ? "has-error" : ""}`}
              value={json}
              spellCheck={false}
              onChange={(e) => setJson(e.target.value)}
            />
            {error ? (
              <p className="explorer__err">⚠ {error}</p>
            ) : (
              <p className="explorer__ok">✓ valid — rendered on the right</p>
            )}
          </Section>
        </div>
      </div>

      <div className="explorer__canvas">
        <Canvas />
      </div>
    </main>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="explorer__section">
      <h2>
        <span className="explorer__num">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function PropTable({ props }: { props: Prop[] }) {
  return (
    <table className="proptable">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Req</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {props.map((p) => (
          <tr key={p.name}>
            <td><code>{p.name}</code></td>
            <td><code className="proptable__type">{p.type}</code></td>
            <td>{p.required ? <span className="proptable__req">required</span> : <span className="proptable__opt">optional</span>}</td>
            <td>{p.desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
