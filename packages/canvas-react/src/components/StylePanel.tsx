/**
 * A compact visual style editor for the selected element.
 *
 * Editing a control applies the style **live** in the iframe via a `set_style`
 * command (no reload, instant feedback). When the user is done, the change is
 * committed once: the iframe posts the element's updated HTML back, and the host
 * persists it as a `canvas.node_patch` — so manual style tweaks survive
 * re-renders, exports, and further agent edits.
 */

import { useEffect, useRef, useState } from "react";

import type { ElementSelection } from "../protocol/selection";
import { useCanvasStore } from "../hooks/useCanvasStore";

const WEIGHTS = ["400", "500", "600", "700"];
const ALIGNMENTS = ["left", "center", "right", "justify"];
const GRADIENTS = [
  "linear-gradient(135deg,#667eea,#764ba2)",
  "linear-gradient(135deg,#f093fb,#f5576c)",
  "linear-gradient(135deg,#4facfe,#00f2fe)",
  "linear-gradient(135deg,#43e97b,#38f9d7)",
  "linear-gradient(135deg,#fa709a,#fee140)",
];

export function StylePanel({ selection }: { selection: ElementSelection }) {
  const send = useCanvasStore((s) => s.sendIframeCommand);
  const styles = selection.styles ?? {};

  const [color, setColor] = useState(toHex(styles.color));
  const [background, setBackground] = useState(toHex(styles.backgroundColor));
  const [fontSize, setFontSize] = useState(px(styles.fontSize, 16));
  const [fontWeight, setFontWeight] = useState(String(styles.fontWeight ?? "400"));
  const [textAlign, setTextAlign] = useState(styles.textAlign ?? "left");
  const [lineHeight, setLineHeight] = useState(px(styles.lineHeight, 0));
  const [letterSpacing, setLetterSpacing] = useState(px(styles.letterSpacing, 0));
  const [padding, setPadding] = useState(px(styles.padding, 0));
  const [radius, setRadius] = useState(px(styles.borderRadius, 0));
  const [width, setWidth] = useState(px(styles.width, 0));
  const bgFileRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);

  const setStyle = (prop: string, value: string) => {
    dirty.current = true;
    send({ artifactId: selection.artifactId, type: "set_style", cid: selection.cid, prop, value });
  };
  // The `background` shorthand carries color/image/size in ONE value, so it lands
  // in a single set_style command (multiple commands in one tick get batched and
  // only the last survives).
  const setBg = (value: string) => setStyle("background", value);
  const onBgFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBg(`url(${String(reader.result)}) center/cover no-repeat`);
    reader.readAsDataURL(file);
  };
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    send({ artifactId: selection.artifactId, type: "commit", cid: selection.cid });
  };

  // Commit pending live edits when the panel closes / the selection changes.
  useEffect(() => commit, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cv-style" onBlur={commit}>
      <div className="cv-style__title">Style</div>

      <label className="cv-style__row">
        <span>Text</span>
        <input
          type="color"
          value={color}
          onChange={(e) => {
            setColor(e.target.value);
            setStyle("color", e.target.value);
          }}
        />
      </label>

      <label className="cv-style__row">
        <span>Background</span>
        <input
          type="color"
          value={background}
          onChange={(e) => {
            setBackground(e.target.value);
            setStyle("backgroundColor", e.target.value);
          }}
        />
      </label>

      <label className="cv-style__row">
        <span>Size</span>
        <input
          type="number"
          min={8}
          max={96}
          value={fontSize}
          onChange={(e) => {
            const next = Number(e.target.value);
            setFontSize(next);
            setStyle("fontSize", `${next}px`);
          }}
        />
      </label>

      <label className="cv-style__row">
        <span>Weight</span>
        <select
          value={fontWeight}
          onChange={(e) => {
            setFontWeight(e.target.value);
            setStyle("fontWeight", e.target.value);
          }}
        >
          {WEIGHTS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </label>

      <label className="cv-style__row">
        <span>Align</span>
        <select
          value={textAlign}
          onChange={(e) => {
            setTextAlign(e.target.value);
            setStyle("textAlign", e.target.value);
          }}
        >
          {ALIGNMENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>

      <label className="cv-style__row">
        <span>Line height</span>
        <input type="number" min={0} max={4} step={0.1} value={lineHeight}
          onChange={(e) => { const n = Number(e.target.value); setLineHeight(n); setStyle("lineHeight", n ? `${n}` : "normal"); }} />
      </label>

      <label className="cv-style__row">
        <span>Letter spacing</span>
        <input type="number" min={-5} max={20} step={0.5} value={letterSpacing}
          onChange={(e) => { const n = Number(e.target.value); setLetterSpacing(n); setStyle("letterSpacing", `${n}px`); }} />
      </label>

      <label className="cv-style__row">
        <span>Padding</span>
        <input type="number" min={0} max={120} value={padding}
          onChange={(e) => { const n = Number(e.target.value); setPadding(n); setStyle("padding", `${n}px`); }} />
      </label>

      <label className="cv-style__row">
        <span>Radius</span>
        <input type="number" min={0} max={80} value={radius}
          onChange={(e) => { const n = Number(e.target.value); setRadius(n); setStyle("borderRadius", `${n}px`); }} />
      </label>

      <label className="cv-style__row">
        <span>Width</span>
        <input type="number" min={0} max={2000} value={width}
          onChange={(e) => { const n = Number(e.target.value); setWidth(n); setStyle("width", n ? `${n}px` : "auto"); }} />
      </label>

      <div className="cv-style__bg">
        <span>Background</span>
        <div className="cv-style__grads">
          {GRADIENTS.map((g) => (
            <button key={g} type="button" className="cv-style__grad" style={{ backgroundImage: g }} title="Gradient" onClick={() => setBg(g)} />
          ))}
          <button type="button" className="cv-style__grad cv-style__grad--img" title="Background image" onClick={() => bgFileRef.current?.click()}>
            🖼
          </button>
          <button type="button" className="cv-style__grad cv-style__grad--none" title="Solid color (clear image)" onClick={() => { setBackground(background); setBg(background); }}>
            ⌀
          </button>
        </div>
        <input ref={bgFileRef} type="file" accept="image/*" hidden onChange={(e) => { onBgFile(e.target.files?.[0]); e.target.value = ""; }} />
      </div>

      <button className="cv-style__done" onClick={commit}>
        Done
      </button>
    </div>
  );
}

/** Parse a computed length like "16px" (or "normal") to a number, with a fallback. */
function px(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Convert a computed `rgb(...)`/`rgba(...)` color to `#rrggbb` for `<input type=color>`. */
function toHex(value?: string): string {
  if (!value) return "#000000";
  if (value.startsWith("#")) return value;
  const parts = value.match(/\d+/g);
  if (!parts || parts.length < 3) return "#000000";
  return (
    "#" +
    parts
      .slice(0, 3)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")
  );
}
