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

const DECK_SHELL_HTML = `<!DOCTYPE html><html data-lcx-dialect="1" data-ratio="16:9"><head><meta charset="utf-8"><title>Q4 Review</title></head><body></body></html>`;

/** The canonical *.slides.html deck this scenario streams in via canvas.patch —
 *  five `<template data-slide-id="…">` blocks, `<style>` first in each (the
 *  style-first invariant `client/deck.ts:159` STYLE_RE enforces). Exported so
 *  the importer test can reuse it as an "upload this file" fixture. */
export const DECK_FIXTURE_HTML = `<!DOCTYPE html><html data-lcx-dialect="1" data-ratio="16:9"><head><meta charset="utf-8"><title>Q4 Review</title></head><body>
<template data-slide-id="s1" data-slide-title="Q4 Business Review">
<style>
  .slide{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0b1020;color:#e6e8ef;font-family:system-ui,sans-serif;text-align:center;padding:48px}
  .slide h1{font-size:44px;margin:0 0 12px}
  .slide p{font-size:20px;margin:0;color:#9aa4b2}
</style>
<div class="slide"><h1>Q4 Business Review</h1><p>Prepared for the board &middot; 2026</p></div>
</template>
<template data-slide-id="s2" data-slide-title="Q4 in review">
<style>
  .slide{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;background:#ffffff;color:#111827;font-family:system-ui,sans-serif;padding:48px}
  .slide h2{font-size:32px;margin:0 0 20px}
  .slide ul{font-size:20px;line-height:1.6;margin:0;padding-left:24px}
</style>
<div class="slide"><h2>Q4 in review</h2><ul><li>Revenue up 24% QoQ</li><li>Two new enterprise logos</li><li>Churn down to 1.2%</li></ul></div>
</template>
<template data-slide-id="s3" data-slide-title="Wins &amp; watch-items">
<style>
  .slide{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;background:#ffffff;color:#111827;font-family:system-ui,sans-serif;padding:48px}
  .slide h2{font-size:32px;margin:0 0 20px}
  .cols{display:flex;gap:32px;flex:1}
  .col{flex:1}
  .col h3{font-size:18px;margin:0 0 12px;color:#6b7280}
  .col ul{font-size:18px;line-height:1.6;margin:0;padding-left:20px}
</style>
<div class="slide"><h2>Wins &amp; watch-items</h2><div class="cols"><div class="col"><h3>Wins</h3><ul><li>Self-serve onboarding</li><li>Usage-based pricing</li><li>Faster support SLAs</li></ul></div><div class="col"><h3>Watch-items</h3><ul><li>Enterprise security review</li><li>EU data residency</li><li>On-call load</li></ul></div></div></div>
</template>
<template data-slide-id="s4" data-slide-title="What's next">
<style>
  .slide{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0b1020;color:#e6e8ef;font-family:system-ui,sans-serif;text-align:center}
  .slide h2{font-size:38px;margin:0 0 12px}
  .slide p{font-size:18px;margin:0;color:#9aa4b2}
</style>
<div class="slide"><h2>What's next</h2><p>Roadmap for Q1</p></div>
</template>
<template data-slide-id="s5" data-slide-title="Thank you">
<style>
  .slide{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0b1020;color:#e6e8ef;font-family:system-ui,sans-serif;text-align:center}
  .slide h1{font-size:54px;margin:0 0 12px;font-weight:700}
  .slide p{font-size:24px;margin:0;color:#6b7280}
</style>
<div class="slide"><h1>Thank you</h1><p>Questions?</p></div>
</template>
</body></html>`;

const slides: Scenario = {
  id: "slides",
  title: "Slide deck",
  description: "A slide deck (*.slides.html dialect), navigable, editable and exportable.",
  events: [
    {
      type: "canvas.create",
      artifact: {
        id: "deck",
        type: "slides",
        title: "Q4 Review",
        version: 1,
        status: "streaming",
        meta: { kind: "deck", ratio: "16:9" },
        data: { html: DECK_SHELL_HTML },
      },
    },
    { type: "canvas.patch", id: "deck", patch: { html: DECK_FIXTURE_HTML } },
    { type: "canvas.status", id: "deck", status: "complete" },
    { type: "done" },
  ],
};

// --- versions: create → edit → described commits --------------------------------

const VERSIONED_HTML = `<!doctype html><html><body style="font-family:sans-serif;padding:40px">
<h1>Coffee history</h1><p>From the Ethiopian highlands to the espresso bar.</p>
</body></html>`;

const versions: Scenario = {
  id: "versions",
  title: "Version history",
  description:
    "An agent builds a page, a user edit and an agent edit each land as described commits — open the version rail to browse and restore-view snapshots.",
  events: [
    { type: "message.delta", messageId: "m1", text: "Built the page — every change now lands in the version history." },
    { type: "message.end", messageId: "m1" },
    {
      type: "canvas.create",
      artifact: { id: "page", type: "html", title: "Coffee history", version: 1, status: "streaming", data: { html: VERSIONED_HTML } },
    },
    { type: "canvas.status", id: "page", status: "complete" },
    { type: "canvas.commit", id: "page", description: "Create page", revision: "v1" },
    // A human tweaks the headline by hand, then saves — one described commit.
    { type: "canvas.patch", id: "page", patch: { html: VERSIONED_HTML.replace("Coffee history", "A short history of coffee") } },
    { type: "canvas.commit", id: "page", description: "Manual edit: 1 change", revision: "v2" },
    // The agent applies a targeted follow-up edit on the current state.
    { type: "canvas.patch", id: "page", patch: { html: VERSIONED_HTML.replace("Coffee history", "A short history of coffee").replace("espresso bar", "third-wave café") } },
    { type: "canvas.commit", id: "page", description: "Update closing phrase", revision: "v3" },
    { type: "done" },
  ],
};

export const scenarios: Scenario[] = [htmlPage, document, chart, table, slides, versions];
