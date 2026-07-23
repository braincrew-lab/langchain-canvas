/**
 * Renders a `type: "html"` artifact — the base substrate — in a sandboxed
 * iframe, wired for direct-manipulation editing plus a lightweight visual
 * page-builder chrome (device preview, an insert palette, and structural actions
 * on the selected element).
 *
 * The HTML is passed through `withInspector`, which stamps every element with a
 * `data-cid` and reports hover/click/marquee selections via `postMessage`. This
 * component records selections in the store (the SelectionBar / StylePanel pick
 * them up), forwards editing commands back into the iframe, and persists the two
 * kinds of edit the iframe emits: a single-node change (`node_edit`) and a
 * whole-document change after a structural edit (`doc_edit`).
 *
 * Sandbox: `allow-scripts` only — no `allow-same-origin`, so the page runs in a
 * null origin and cannot touch the parent, cookies, or storage (the Claude
 * Artifacts security model). It communicates solely through `postMessage`.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { INSPECTOR_MARK, withInspector } from "../../client/inspector";
import type { HtmlData } from "../../protocol/artifacts";
import type { IframeCommand } from "../../store/store";
import { useCanvasStore, useCanvasStoreApi } from "../../hooks/useCanvasStore";
import type { RendererProps } from "../../registry/registry";

const DEVICES = [
  { id: "desktop", label: "Desktop", width: "100%" },
  { id: "tablet", label: "Tablet", width: "768px" },
  { id: "mobile", label: "Mobile", width: "390px" },
] as const;

const BLOCKS = [
  { tag: "h2", label: "Heading" },
  { tag: "p", label: "Text" },
  { tag: "button", label: "Button" },
  { tag: "img", label: "Image" },
  { tag: "hr", label: "Divider" },
];

// Self-contained, responsive section templates (inline-styled so they render the
// same wherever they're dropped; grids use auto-fit so they reflow on mobile).
const TEMPLATES: Record<string, { label: string; html: string }> = {
  hero: {
    label: "Hero",
    html: `<section style="padding:72px 24px;text-align:center;background:linear-gradient(180deg,#0b1020,#151a2e);color:#e6e8ef">
  <h1 style="font-size:clamp(30px,5vw,52px);margin:0 0 14px;font-weight:800">Ship faster with confidence</h1>
  <p style="font-size:18px;line-height:1.6;color:#9aa4b2;max-width:560px;margin:0 auto 28px">One clear sentence about the value you deliver to customers.</p>
  <a href="#" style="display:inline-block;padding:13px 26px;background:#6366f1;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Get started free</a>
</section>`,
  },
  features: {
    label: "Features",
    html: `<section style="padding:56px 24px;background:#0b1020;color:#e6e8ef">
  <div style="max-width:960px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px">
    <div style="background:#151a2e;border:1px solid #232a44;border-radius:14px;padding:24px"><h3 style="margin:0 0 8px;font-size:18px">Fast</h3><p style="margin:0;color:#9aa4b2;line-height:1.6">Explain this benefit in a sentence or two.</p></div>
    <div style="background:#151a2e;border:1px solid #232a44;border-radius:14px;padding:24px"><h3 style="margin:0 0 8px;font-size:18px">Reliable</h3><p style="margin:0;color:#9aa4b2;line-height:1.6">Explain this benefit in a sentence or two.</p></div>
    <div style="background:#151a2e;border:1px solid #232a44;border-radius:14px;padding:24px"><h3 style="margin:0 0 8px;font-size:18px">Secure</h3><p style="margin:0;color:#9aa4b2;line-height:1.6">Explain this benefit in a sentence or two.</p></div>
  </div>
</section>`,
  },
  cta: {
    label: "Call to action",
    html: `<section style="margin:24px;padding:48px 24px;text-align:center;background:#6366f1;color:#fff;border-radius:16px">
  <h2 style="margin:0 0 10px;font-size:26px">Ready to get started?</h2>
  <p style="margin:0 0 22px;opacity:.9">Join thousands of teams already building with us.</p>
  <a href="#" style="display:inline-block;padding:12px 24px;background:#fff;color:#4338ca;border-radius:10px;text-decoration:none;font-weight:700">Sign up</a>
</section>`,
  },
};

const SLIDE_W = 1280;

/** Fit a fixed-aspect slide's design width into the available column, returning
 *  the scale factor and the design height for a given `ratio` (e.g. "16:9"). */
function useSlideFit(ratio: string | undefined, boxRef: React.RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(1);
  const [rw, rh] = (ratio ?? "16:9").split(/[:x/]/).map(Number);
  const height = rw && rh ? Math.round((SLIDE_W * rh) / rw) : 720;
  useEffect(() => {
    if (!ratio) return;
    const el = boxRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, (el.clientWidth - 40) / SLIDE_W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratio, height]);
  return { scale, width: SLIDE_W, height };
}

export function HtmlRenderer({ artifact }: RendererProps<HtmlData>) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const imgFileRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const api = useCanvasStoreApi();
  const setSelections = useCanvasStore((s) => s.setSelections);
  const applyEvent = useCanvasStore((s) => s.applyUserEvent);
  const sendIframeCommand = useCanvasStore((s) => s.sendIframeCommand);
  const selections = useCanvasStore((s) => s.selections);
  const iframeCommand = useCanvasStore((s) => s.iframeCommand);
  const [device, setDevice] = useState<(typeof DEVICES)[number]["id"]>("desktop");
  const [mode, setMode] = useState<"design" | "code">("design");

  // A single-node edit made *inside* the iframe is already reflected there, so we
  // keep the same srcDoc (no reload/flicker). Only tree-changing edits (structural
  // / code view / agent updates) rebuild it so cids get re-stamped.
  //
  // This self-edit short-circuit is only valid while the *same* iframe stays
  // mounted. In "code" view the iframe is unmounted (replaced by a textarea), so
  // returning to "design" mounts a fresh iframe that must reload from the current
  // html — otherwise it would load a stale (or empty) cached srcDoc and render
  // blank. Keying srcDoc on `mode` rebuilds it whenever we come back to design.
  const lastSelfHtml = useRef<string | null>(null);
  const srcDocRef = useRef<string>("");
  const srcDoc = useMemo(() => {
    if (mode === "design" && artifact.data.html === lastSelfHtml.current) return srcDocRef.current;
    srcDocRef.current = withInspector(artifact.data.html);
    lastSelfHtml.current = null; // rebuilt from source — no longer a live self-edit
    return srcDocRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.data.html, mode]);
  const selected = selections.filter((s) => s.artifactId === artifact.id);
  const single = selected.length === 1 ? selected[0] : null;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (data?.source !== INSPECTOR_MARK) return;

      if (data.type === "select") {
        setSelections([
          { artifactId: artifact.id, cid: data.cid, selector: data.selector, tag: data.tag, text: data.text, outerHtml: data.outerHtml, styles: data.styles, isGroup: data.isGroup },
        ]);
      } else if (data.type === "multi_select") {
        setSelections(
          (data.items ?? []).map((it: any) => ({
            artifactId: artifact.id,
            cid: it.cid,
            selector: it.selector,
            tag: it.tag,
            text: it.text,
            outerHtml: it.outerHtml,
          })),
        );
      } else if (data.type === "node_edit") {
        // A single-node edit (text / style / move / resize) — patch that node. The
        // iframe already shows it, so mark the result self-applied to skip a reload.
        applyEvent({ type: "canvas.node_patch", id: artifact.id, cid: data.cid, html: data.html });
        lastSelfHtml.current = (api.getState().canvas.artifacts[artifact.id]?.data as HtmlData | undefined)?.html ?? null;
      } else if (data.type === "doc_edit") {
        // A structural edit — replace the whole document. A reorder (`self`) is
        // already reflected in the iframe with every cid intact, so mark it
        // self-applied to skip the reload (no flicker) and keep the selection;
        // other structural edits mint new nodes and reload to re-tag cids.
        applyEvent({ type: "canvas.patch", id: artifact.id, patch: { html: data.html } });
        if (data.self) {
          lastSelfHtml.current = (api.getState().canvas.artifacts[artifact.id]?.data as HtmlData | undefined)?.html ?? null;
        } else {
          setSelections([]);
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifact.id, setSelections, applyEvent, api]);

  // Clear the in-iframe highlight when nothing here is selected anymore.
  useEffect(() => {
    if (!selected.length) {
      iframeRef.current?.contentWindow?.postMessage({ source: INSPECTOR_MARK, type: "clear" }, "*");
    }
  }, [selected.length]);

  // Forward editing commands (style / structure) to this artifact's iframe.
  useEffect(() => {
    if (!iframeCommand || iframeCommand.artifactId !== artifact.id) return;
    iframeRef.current?.contentWindow?.postMessage({ source: INSPECTOR_MARK, ...iframeCommand }, "*");
  }, [iframeCommand, artifact.id]);

  const command = (type: IframeCommand["type"], extra: Partial<IframeCommand> = {}) =>
    sendIframeCommand({ artifactId: artifact.id, type, cid: single?.cid, ...extra });

  const commitCode = (html: string) => {
    if (html !== artifact.data.html) applyEvent({ type: "canvas.patch", id: artifact.id, patch: { html } });
  };

  const onImgFile = (file: File | undefined) => {
    if (!file || !single) return;
    const reader = new FileReader();
    reader.onload = () => sendIframeCommand({ artifactId: artifact.id, type: "set_src", cid: single.cid, value: String(reader.result) });
    reader.readAsDataURL(file); // embed as a data URI so the page stays self-contained
  };

  // A fixed-aspect slide (the agent set `meta.ratio`, e.g. "16:9") lays out at a
  // fixed design width (1280×ratio) and is scaled to fit its column. It stays
  // fully editable — a transform-scaled iframe still maps clicks to its own
  // coordinates — so element select / drag / style / chat editing all work; only
  // the fluid device-width switch (meaningless for a fixed slide) is hidden.
  const ratio = artifact.meta?.ratio as string | undefined;
  const slide = useSlideFit(ratio, stageRef);

  return (
    <div className="cv-html-wrap">
      <input ref={imgFileRef} type="file" accept="image/*" hidden onChange={(e) => { onImgFile(e.target.files?.[0]); e.target.value = ""; }} />
      <div className="cv-html-bar cv-chrome">
        {mode === "design" && (
          <>
            {!ratio && (
              <>
                <div className="cv-html-seg" role="group" aria-label="Preview width">
                  {DEVICES.map((d) => (
                    <button key={d.id} className={device === d.id ? "is-on" : ""} onClick={() => setDevice(d.id)}>
                      {d.label}
                    </button>
                  ))}
                </div>
                <span className="cv-html-bar__sep" />
              </>
            )}
            <span className="cv-html-bar__label">Add</span>
            {BLOCKS.map((b) => (
              <button key={b.tag} className="cv-html-add" onClick={() => command("insert", { block: b.tag })}>
                {b.label}
              </button>
            ))}
            <select
              className="cv-html-tpl"
              value=""
              title="Insert a section template"
              onChange={(e) => {
                const t = TEMPLATES[e.target.value];
                if (t) sendIframeCommand({ artifactId: artifact.id, type: "insert_html", cid: single?.cid, html: t.html });
                e.currentTarget.value = "";
              }}
            >
              <option value="">Section…</option>
              {Object.entries(TEMPLATES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>

            {selected.length >= 1 && (
              <>
                <span className="cv-html-bar__sep" />
                <span className="cv-html-bar__label">Selection</span>
                {single?.isGroup ? (
                  <button className="cv-html-actbtn" onClick={() => command("ungroup")}>⊟ Ungroup</button>
                ) : (
                  <button
                    className="cv-html-actbtn"
                    disabled={selected.length < 2}
                    title={selected.length < 2 ? "Select 2+ elements (Shift-click, or drag a box) to group" : "Group — they'll move together"}
                    onClick={() => sendIframeCommand({ artifactId: artifact.id, type: "group", cids: selected.map((s) => s.cid) })}
                  >
                    ⊞ Group
                  </button>
                )}
                {single?.tag === "img" && (
                  <>
                    <button className="cv-html-add" onClick={() => imgFileRef.current?.click()}>🖼 Upload</button>
                    <button
                      className="cv-html-add"
                      onClick={() => {
                        const url = window.prompt("Image URL");
                        if (url && single) sendIframeCommand({ artifactId: artifact.id, type: "set_src", cid: single.cid, value: url });
                      }}
                    >
                      🔗 URL
                    </button>
                  </>
                )}
                {single && (
                  <>
                    <button className="cv-html-act" title="Duplicate" onClick={() => command("duplicate")}>⧉</button>
                    <button className="cv-html-act" title="Move up" onClick={() => command("move_up")}>↑</button>
                    <button className="cv-html-act" title="Move down" onClick={() => command("move_down")}>↓</button>
                    <button className="cv-html-act cv-html-act--del" title="Delete" onClick={() => command("delete")}>🗑</button>
                  </>
                )}
              </>
            )}
          </>
        )}

        <span className="cv-html-bar__spacer" />
        <div className="cv-html-seg" role="group" aria-label="View mode">
          <button className={mode === "design" ? "is-on" : ""} onClick={() => setMode("design")}>Design</button>
          <button className={mode === "code" ? "is-on" : ""} onClick={() => setMode("code")}>Code</button>
        </div>
      </div>

      {mode === "design" ? (
        <div className={`cv-html-stage${ratio ? " cv-html-stage--slide" : ""}`} ref={stageRef}>
          {ratio ? (
            // Scaled slide: the iframe lays out at its full design size, then a
            // transform shrinks it to fit; a sized wrapper reserves the scaled box
            // so the stage scrolls correctly. Clicks still hit the right elements.
            <div style={{ width: slide.width * slide.scale, height: slide.height * slide.scale, flex: "0 0 auto" }}>
              <iframe
                ref={iframeRef}
                className="cv-html"
                title={artifact.title}
                srcDoc={srcDoc}
                sandbox="allow-scripts allow-popups allow-modals"
                style={{ width: slide.width, height: slide.height, transform: `scale(${slide.scale})`, transformOrigin: "top left" }}
              />
            </div>
          ) : (
            <iframe
              ref={iframeRef}
              className="cv-html"
              title={artifact.title}
              srcDoc={srcDoc}
              sandbox="allow-scripts allow-popups allow-modals"
              style={{ width: DEVICES.find((d) => d.id === device)!.width }}
            />
          )}
        </div>
      ) : (
        <textarea
          key={artifact.data.html}
          className="cv-html-code"
          defaultValue={artifact.data.html}
          spellCheck={false}
          onBlur={(e) => commitCode(e.target.value)}
          aria-label="HTML source"
        />
      )}
    </div>
  );
}
