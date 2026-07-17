/**
 * Schema fixtures — scripted wire-event sequences that render the canvas with no
 * backend. Feed one to `useCanvasReplay().play(scenario.events)`.
 *
 * Each scenario is nothing but `StreamEvent`s: exactly what a LangGraph agent
 * would emit over the wire. They double as living documentation of the protocol
 * and as a zero-dependency way to develop renderers.
 */

import type { StreamEvent } from "../protocol/events";

export interface Scenario {
  id: string;
  title: string;
  description: string;
  events: StreamEvent[];
}

// --- html: a self-contained page, then a targeted node edit ---------------------

const PRICING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body{font-family:system-ui;margin:0;background:#0b1020;color:#e6e8ef}
  .wrap{max-width:820px;margin:48px auto;padding:0 20px;text-align:center}
  h1{font-size:34px;margin:0 0 8px}
  .sub{color:#9aa4b2;margin-bottom:32px}
  .tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .card{background:#151a2e;border:1px solid #232a44;border-radius:14px;padding:24px}
  .price{font-size:28px;font-weight:700;margin:8px 0}
  .cta{margin-top:16px;padding:10px 16px;border:0;border-radius:9px;background:#6366f1;color:#fff;font-weight:600;cursor:pointer}
  @media (max-width:640px){
    .wrap{margin:28px auto}
    h1{font-size:26px}
    .tiers{grid-template-columns:1fr}
  }
</style></head>
<body><div class="wrap">
  <h1>Simple, honest pricing</h1>
  <p class="sub">Start free. Upgrade when you grow.</p>
  <div class="tiers">
    <div class="card"><div>Starter</div><div class="price">$0</div><button class="cta">Get started</button></div>
    <div class="card"><div>Pro</div><div class="price">$20</div><button class="cta">Start trial</button></div>
    <div class="card"><div>Enterprise</div><div class="price">Custom</div><button class="cta">Contact us</button></div>
  </div>
</div></body></html>`;

const htmlPage: Scenario = {
  id: "html-page",
  title: "HTML page + edit",
  description: "An agent builds a pricing page, then surgically edits one heading via node_patch.",
  events: [
    { type: "message.delta", messageId: "m1", text: "Here's a pricing page — click any element to edit it." },
    { type: "message.end", messageId: "m1" },
    {
      type: "canvas.create",
      artifact: { id: "page", type: "html", title: "Pricing", version: 1, status: "streaming", data: { html: PRICING_HTML } },
    },
    { type: "canvas.status", id: "page", status: "complete" },
    // A targeted edit: replace the <h1> (cid "e-0-0": wrap → child 0) in place.
    { type: "canvas.node_patch", id: "page", cid: "e-0-0", html: '<h1 data-cid="e-0-0">Pricing that scales with you</h1>' },
    { type: "done" },
  ],
};

// --- document: streamed markdown ------------------------------------------------

const REPORT_CHUNKS = [
  "# EV market, 2026\n\n",
  "The electric-vehicle market continued its shift ",
  "from early adopters to the mainstream.\n\n",
  "## Highlights\n\n",
  "- Global BEV share crossed **20%** of new sales\n",
  "- Battery pack prices fell below **$80/kWh**\n",
  "- Charging networks doubled in dense metros\n\n",
  "## Outlook\n\nExpect continued margin pressure as ",
  "legacy OEMs scale volume.",
];

const document: Scenario = {
  id: "document",
  title: "Streaming document",
  description: "A markdown report streamed token-by-token via canvas.append.",
  events: [
    { type: "canvas.create", artifact: { id: "doc", type: "document", title: "EV market report", version: 1, status: "streaming", data: { format: "markdown", content: "" } } },
    ...REPORT_CHUNKS.map((text): StreamEvent => ({ type: "canvas.append", id: "doc", path: "content", text })),
    { type: "canvas.status", id: "doc", status: "complete" },
    { type: "done" },
  ],
};

// --- chart ----------------------------------------------------------------------

const chart: Scenario = {
  id: "chart",
  title: "Chart",
  description: "A bar chart whose rows arrive via canvas.patch.",
  events: [
    {
      type: "canvas.create",
      artifact: {
        id: "rev",
        type: "chart",
        title: "Quarterly revenue",
        version: 1,
        status: "streaming",
        data: { chart: "bar", xKey: "quarter", series: [{ key: "amount", label: "Revenue ($M)" }], rows: [] },
      },
    },
    {
      type: "canvas.patch",
      id: "rev",
      patch: {
        rows: [
          { quarter: "Q1", amount: 12 },
          { quarter: "Q2", amount: 18 },
          { quarter: "Q3", amount: 24 },
          { quarter: "Q4", amount: 30 },
        ],
      },
    },
    { type: "canvas.status", id: "rev", status: "complete" },
    { type: "done" },
  ],
};

// --- table ----------------------------------------------------------------------

const table: Scenario = {
  id: "table",
  title: "Table",
  description: "A data grid with columns and rows.",
  events: [
    {
      type: "canvas.create",
      artifact: {
        id: "tbl",
        type: "table",
        title: "Model comparison",
        version: 1,
        status: "streaming",
        data: {
          columns: [
            { key: "model", label: "Model" },
            { key: "context", label: "Context", align: "right" },
            { key: "price", label: "$/Mtok", align: "right" },
          ],
          rows: [],
        },
      },
    },
    {
      type: "canvas.patch",
      id: "tbl",
      patch: {
        rows: [
          { model: "Opus 4.8", context: "1M", price: 15 },
          { model: "Sonnet 5", context: "400K", price: 3 },
          { model: "Haiku 4.5", context: "200K", price: 1 },
          { model: "Average", context: "", price: "=ROUND(AVERAGE(C2:C4),2)" },
        ],
      },
    },
    { type: "canvas.status", id: "tbl", status: "complete" },
    { type: "done" },
  ],
};

// --- slides ---------------------------------------------------------------------

const slides: Scenario = {
  id: "slides",
  title: "Slide deck",
  description: "A slide deck (title + bullets), navigable and exportable to .pptx.",
  events: [
    { type: "canvas.create", artifact: { id: "deck", type: "slides", title: "Q4 Review", version: 1, status: "streaming", data: { slides: [] } } },
    {
      type: "canvas.patch",
      id: "deck",
      patch: {
        slides: [
          { layout: "title", title: "Q4 Business Review", subtitle: "Prepared for the board · 2026", background: "#0b1020", textColor: "#e6e8ef", notes: "Welcome the room; set the tone for the quarter." },
          { layout: "content", title: "Q4 in review", bullets: ["Revenue up 24% QoQ", "Two new enterprise logos", "Churn down to 1.2%"], notes: "Lead with the revenue number." },
          {
            layout: "two-column",
            title: "Wins & watch-items",
            bullets: ["Self-serve onboarding", "Usage-based pricing", "Faster support SLAs"],
            bullets2: ["Enterprise security review", "EU data residency", "On-call load"],
          },
          { layout: "section", title: "What's next", subtitle: "Roadmap for Q1" },
          {
            layout: "blank",
            elements: [
              { id: "e1", type: "text", x: 8, y: 12, w: 60, h: 16, text: "Thank you", fontSize: 54, bold: true },
              { id: "e2", type: "text", x: 8, y: 34, w: 70, h: 12, text: "Questions?", fontSize: 28, color: "#6b7280" },
            ],
          },
        ],
      },
    },
    { type: "canvas.status", id: "deck", status: "complete" },
    { type: "done" },
  ],
};

export const scenarios: Scenario[] = [htmlPage, document, chart, table, slides];
