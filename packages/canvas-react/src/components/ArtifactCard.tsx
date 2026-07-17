/**
 * `<ArtifactCard>` — an inline reference to an artifact, for the chat transcript.
 *
 * Assistant messages carry the ids of the artifacts they produced
 * (`message.artifactIds`); render a card per id under the bubble so the artifact
 * shows up *in the conversation* (like ChatGPT), and clicking it focuses that
 * artifact in the `<Canvas />` panel.
 */

import { useCanvasStore } from "../hooks/useCanvasStore";

const META: Record<string, { icon: string; label: string }> = {
  html: { icon: "🌐", label: "Web page" },
  document: { icon: "📄", label: "Word document" },
  chart: { icon: "📊", label: "Chart" },
  table: { icon: "🔢", label: "Excel sheet" },
  slides: { icon: "📽️", label: "PowerPoint deck" },
};

export function ArtifactCard({ artifactId }: { artifactId: string }) {
  const artifact = useCanvasStore((s) => s.canvas.artifacts[artifactId]);
  const setActive = useCanvasStore((s) => s.setActiveArtifact);

  if (!artifact) return null;
  const meta = META[artifact.type] ?? { icon: "📎", label: artifact.type };

  return (
    <button className="cv-card" onClick={() => setActive(artifact.id)} title="Open on the canvas">
      <span className="cv-card__icon">{meta.icon}</span>
      <span className="cv-card__meta">
        <b>{artifact.title}</b>
        <span>
          {meta.label} · {artifact.status === "streaming" ? "writing…" : "open →"}
        </span>
      </span>
    </button>
  );
}
