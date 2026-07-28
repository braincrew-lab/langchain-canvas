/**
 * `<ArtifactCard>` — an inline reference to an artifact, for the chat transcript.
 *
 * Assistant messages carry the ids of the artifacts they produced
 * (`message.artifactIds`); render a card per id under the bubble so the artifact
 * shows up *in the conversation* (like ChatGPT), and clicking it focuses that
 * artifact in the `<Canvas />` panel.
 */

import type { Artifact } from "../protocol/artifacts";
import { useCanvasStore } from "../hooks/useCanvasStore";
import { useT, type MessageKey } from "../i18n/i18n";

type CardMeta = { icon: string; label: MessageKey };

// Keyed on the artifact's renderer `type`. Labels are i18n keys.
const TYPE_META: Record<string, CardMeta> = {
  html: { icon: "🌐", label: "kindWeb" },
  document: { icon: "📄", label: "kindDocument" },
  chart: { icon: "📊", label: "kindChart" },
  table: { icon: "🔢", label: "kindTable" },
  slides: { icon: "📽️", label: "kindSlides" },
  pdf: { icon: "📕", label: "kindPdf" },
};

// Keyed on a producer-supplied logical kind (`meta.kind`). A host that renders
// slides/tables through the HTML substrate (so `type` stays "html") can still
// surface the real kind here — the label follows the content, not the renderer.
const KIND_META: Record<string, CardMeta> = {
  web: TYPE_META.html,
  html: TYPE_META.html,
  document: TYPE_META.document,
  doc: TYPE_META.document,
  chart: TYPE_META.chart,
  table: TYPE_META.table,
  sheet: TYPE_META.table,
  slide: TYPE_META.slides,
  slides: TYPE_META.slides,
  pdf: TYPE_META.pdf,
};

/** Resolve the card's icon + label, preferring the producer's logical `meta.kind`
 *  over the renderer `type` so HTML-substrate slides/tables aren't all "Web page". */
function resolveCardMeta(artifact: Artifact): { icon: string; label?: MessageKey } {
  const kind = typeof artifact.meta?.kind === "string" ? artifact.meta.kind : undefined;
  const byKind = kind ? KIND_META[kind] : undefined;
  return byKind ?? TYPE_META[artifact.type] ?? { icon: "📎" };
}

export function ArtifactCard({ artifactId }: { artifactId: string }) {
  const t = useT();
  const artifact = useCanvasStore((s) => s.canvas.artifacts[artifactId]);
  const setActive = useCanvasStore((s) => s.setActiveArtifact);

  if (!artifact) return null;
  const meta = resolveCardMeta(artifact);

  return (
    <button className="cv-card" onClick={() => setActive(artifact.id)} title="Open on the canvas">
      <span className="cv-card__icon">{meta.icon}</span>
      <span className="cv-card__meta">
        <b>{artifact.title}</b>
        <span>
          {meta.label ? t(meta.label) : artifact.type} · {artifact.status === "streaming" ? t("writing") : t("open")}
        </span>
      </span>
    </button>
  );
}
