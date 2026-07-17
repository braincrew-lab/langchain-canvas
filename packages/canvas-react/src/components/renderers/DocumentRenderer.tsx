/**
 * Renders a `type: "document"` artifact as a real document viewer — a white page
 * (with margins and a drop shadow) on a gray canvas, like Word / Google Docs.
 * Click the page to edit its markdown directly; the change commits to the store
 * on blur (so it renders, versions, and exports).
 */

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { DocumentData } from "../../protocol/artifacts";
import { useArtifactPatch } from "../../hooks/useArtifactPatch";
import type { RendererProps } from "../../registry/registry";

export function DocumentRenderer({ artifact }: RendererProps<DocumentData>) {
  const { content } = artifact.data;
  const patch = useArtifactPatch(artifact.id);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  const commit = () => {
    if (draft !== null && draft !== content) patch({ content: draft });
    setDraft(null);
  };

  return (
    <div className="cv-word">
      <div className="cv-word__page">
        {editing ? (
          <textarea
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
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            {artifact.status === "streaming" && <span className="cv-caret" aria-hidden />}
          </article>
        )}
      </div>
    </div>
  );
}
