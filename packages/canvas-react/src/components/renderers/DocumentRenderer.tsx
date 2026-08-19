/**
 * Renders a `type: "document"` artifact as a real document viewer — a white page
 * (with margins and a drop shadow) on a gray canvas, like Word / Google Docs.
 * Click the page to edit its markdown directly; a formatting toolbar wraps the
 * selection, and the change commits to the store on blur (so it renders,
 * versions, and exports).
 */

import { useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { DocumentData } from "../../protocol/artifacts";
import { useArtifactPatch } from "../../hooks/useArtifactPatch";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import type { RendererProps } from "../../registry/registry";

function wordStats(text: string): { words: number; minutes: number } {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { words, minutes: Math.max(1, Math.round(words / 200)) };
}

export function DocumentRenderer({ artifact }: RendererProps<DocumentData>) {
  const { content } = artifact.data;
  const patch = useArtifactPatch(artifact.id);
  const [draft, setDraft] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;
  // Canvas-asset references (`![…](assets/…)`) display through the host's file
  // endpoint; the markdown source keeps the relative path. Composed with the
  // default transform so its sanitization still applies.
  const assetUrl = useAssetUrl();
  const urlTransform = (url: string) => defaultUrlTransform(assetUrl(url) ?? url);

  const commit = () => {
    if (draft !== null && draft !== content) patch({ content: draft });
    setDraft(null);
  };

  // Format helpers operate on the textarea selection and keep it focused (so the
  // blur-to-commit isn't triggered — buttons use mousedown + preventDefault).
  const apply = (fn: (full: string, s: number, e: number) => { text: string; a: number; b: number }) => {
    const ta = taRef.current;
    if (!ta || draft === null) return;
    const { text, a, b } = fn(draft, ta.selectionStart, ta.selectionEnd);
    setDraft(text);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(a, b); });
  };
  const wrap = (mark: string) =>
    apply((full, s, e) => ({ text: full.slice(0, s) + mark + full.slice(s, e) + mark + full.slice(e), a: s + mark.length, b: e + mark.length }));
  const link = () =>
    apply((full, s, e) => {
      const label = full.slice(s, e) || "link";
      const ins = `[${label}](https://)`;
      const urlAt = s + label.length + 3;
      return { text: full.slice(0, s) + ins + full.slice(e), a: urlAt, b: urlAt + 8 };
    });
  const prefixLines = (prefix: string) =>
    apply((full, s, e) => {
      const start = full.lastIndexOf("\n", s - 1) + 1;
      const nl = full.indexOf("\n", e);
      const end = nl === -1 ? full.length : nl;
      const block = full.slice(start, end).split("\n").map((l) => prefix + l).join("\n");
      return { text: full.slice(0, start) + block + full.slice(end), a: start, b: start + block.length };
    });

  const { words, minutes } = wordStats(editing ? (draft ?? "") : content);

  return (
    <div className="cv-word">
      {editing && (
        <div className="cv-doc-bar cv-chrome" onMouseDown={(e) => e.preventDefault()}>
          <button title="Bold" onMouseDown={(e) => { e.preventDefault(); wrap("**"); }}><b>B</b></button>
          <button title="Italic" onMouseDown={(e) => { e.preventDefault(); wrap("*"); }}><i>I</i></button>
          <button title="Inline code" onMouseDown={(e) => { e.preventDefault(); wrap("`"); }}>{"<>"}</button>
          <span className="cv-doc-bar__sep" />
          <button title="Heading 1" onMouseDown={(e) => { e.preventDefault(); prefixLines("# "); }}>H1</button>
          <button title="Heading 2" onMouseDown={(e) => { e.preventDefault(); prefixLines("## "); }}>H2</button>
          <button title="Bullet list" onMouseDown={(e) => { e.preventDefault(); prefixLines("- "); }}>•</button>
          <button title="Numbered list" onMouseDown={(e) => { e.preventDefault(); prefixLines("1. "); }}>1.</button>
          <button title="Quote" onMouseDown={(e) => { e.preventDefault(); prefixLines("> "); }}>❝</button>
          <button title="Link" onMouseDown={(e) => { e.preventDefault(); link(); }}>🔗</button>
          <span className="cv-doc-bar__spacer" />
          <span className="cv-doc-bar__count">{words} words · {minutes} min read</span>
          <button className="cv-doc-bar__done" onMouseDown={(e) => { e.preventDefault(); commit(); }}>Done</button>
        </div>
      )}
      <div className="cv-word__page">
        {editing ? (
          <textarea
            ref={taRef}
            className="cv-doc-editor"
            value={draft}
            autoFocus
            onBlur={commit}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : (
          <article
            className="cv-doc"
            title="Click to edit"
            onClick={() => artifact.status !== "streaming" && setDraft(content)}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform}>{content}</ReactMarkdown>
            {artifact.status === "streaming" && <span className="cv-caret" aria-hidden />}
          </article>
        )}
      </div>
    </div>
  );
}
