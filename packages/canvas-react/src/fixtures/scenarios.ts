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

// --- pdf: the browser's native viewer -------------------------------------------

/** A complete one-page PDF (self-contained data: URL) for the native viewer. */
const PDF_DATA_URL =
  "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgNjEyIDc5Ml0vQ29udGVudHMgNCAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGggODA+PnN0cmVhbQpCVCAvRjEgMjggVGYgNzIgNzAwIFRkIChsYW5nY2hhaW4tY2FudmFzIFBERiB2aWV3ZXIpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iajw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+ZW5kb2JqCnhyZWYKMCA2CnRyYWlsZXI8PC9TaXplIDYvUm9vdCAxIDAgUj4+CiUlRU9GCg==";

const pdf: Scenario = {
  id: "pdf",
  title: "PDF viewer",
  description: "A PDF artifact shown in the browser's built-in viewer — zero dependencies.",
  events: [
    { type: "message.delta", messageId: "m-pdf", text: "Here's the signed report as a PDF." },
    {
      type: "canvas.create",
      artifact: {
        id: "report-pdf",
        type: "pdf",
        title: "Signed report",
        version: 1,
        status: "complete",
        data: { src: PDF_DATA_URL, filename: "signed-report.pdf" },
      },
    },
    { type: "canvas.status", id: "report-pdf", status: "complete" },
    { type: "done" },
  ],
};


// --- hwp: a Korean document with real formatting (as .hwp/.hwpx imports open) ----

const HWP_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><style>
  body{margin:0;background:#eceef1;font-family:"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",AppleGothic,sans-serif;color:#1a1a1a}
  .page{max-width:794px;margin:24px auto;padding:96px 72px;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.12);line-height:1.7}
  h1{font-size:22pt;text-align:center;margin:0 0 8px}
  .stamp{text-align:center;color:#555;font-size:10.5pt;margin:0 0 36px}
  h2{font-size:14pt;border-bottom:2px solid #2f5597;padding-bottom:4px;margin:28px 0 12px;color:#2f5597}
  p{margin:0 0 10px;font-size:11pt;text-align:justify}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:10.5pt}
  th{background:#dbe5f1;border:1px solid #666;padding:7px 10px}
  td{border:1px solid #666;padding:7px 10px}
  .sign{margin-top:48px;text-align:right;font-size:12pt}
  .red{color:#c00000;font-weight:700}
</style></head>
<body><div class="page">
  <h1>사업 수행 계획서</h1>
  <p class="stamp">문서번호 BC-2026-041 · 2026. 7. 29.</p>
  <h2>1. 개요</h2>
  <p>본 문서는 <b>대화형 에이전트 빌더 구축</b> 사업의 수행 계획을 정리한 것입니다. <span class="red">한글(.hwp/.hwpx) 파일을 캔버스에 끌어다 놓으면</span> 이 문서처럼 <u>서식이 보존된 페이지</u>로 열립니다 — 글꼴 크기·색·정렬·표 테두리·이미지까지.</p>
  <h2>2. 추진 일정</h2>
  <table>
    <tr><th>단계</th><th>기간</th><th>산출물</th></tr>
    <tr><td>착수</td><td style="text-align:center">2026-07</td><td>사업수행계획서</td></tr>
    <tr><td>분석/설계</td><td style="text-align:center">2026-07 ~ 2026-08</td><td>요구사항 정의서</td></tr>
    <tr><td>구축</td><td style="text-align:center">2026-08 ~ 2026-11</td><td>기능 구현</td></tr>
    <tr><td>검수</td><td style="text-align:center">2026-12</td><td>검수확인서</td></tr>
  </table>
  <h2>3. 내보내기</h2>
  <p>편집한 문서는 <b>내보내기</b> 메뉴에서 PDF·HTML로 저장할 수 있습니다. 에이전트가 만든 문서(document)는 <b>한글 (HWPX)</b>로도 내보냅니다.</p>
  <p class="sign">브레인크루 주식회사</p>
</div></body></html>`;

const hwp: Scenario = {
  id: "hwp",
  title: "한글 (HWP)",
  description: "A formatted Korean document — how .hwp/.hwpx files open on the canvas, styling preserved.",
  events: [
    { type: "message.delta", messageId: "m-hwp", text: "한글 파일을 서식 그대로 열었습니다." },
    {
      type: "canvas.create",
      artifact: {
        id: "hwp-doc",
        type: "html",
        title: "사업 수행 계획서.hwpx",
        version: 1,
        status: "complete",
        meta: { kind: "doc", source: "hwpx" },
        data: { html: HWP_HTML },
      },
    },
    { type: "canvas.status", id: "hwp-doc", status: "complete" },
    { type: "done" },
  ],
};

export const scenarios: Scenario[] = [htmlPage, document, chart, table, slides, pdf, hwp, versions];
