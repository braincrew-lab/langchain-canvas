/**
 * A small "Export" dropdown in the canvas header.
 *
 * Always offers **HTML** (the rendered artifact wrapped into a standalone
 * `.html` file) plus any data exporters registered for the artifact's type
 * (`.md`, `.csv`, `.json`, …). The rendered HTML is read lazily from the panel
 * body via `getRenderedHtml`, so the export always matches exactly what's shown.
 * The entries themselves come from `buildExportActions`, which a host can call
 * to draw the same menu in its own chrome.
 */

import { useState } from "react";

import type { Artifact } from "../protocol/artifacts";
import { buildExportActions } from "../export/actions";
import { useCanvasStore } from "../hooks/useCanvasStore";
import { useLabels } from "./chrome";

/** One host-supplied entry appended to the menu (a server-side export, say). */
export interface ExportExtra {
  /** Menu label, e.g. "PowerPoint". */
  label: string;
  /** Small extension chip after the label, e.g. "pptx". */
  extension?: string;
  run: () => void | Promise<void>;
}

interface ExportMenuProps {
  artifact: Artifact;
  getRenderedHtml: () => string | null;
  /** Extra entries appended after the built-in ones — nothing is replaced. */
  extras?: ExportExtra[];
}

export function ExportMenu({ artifact, getRenderedHtml, extras }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const assetBaseUrl = useCanvasStore((s) => s.assetBaseUrl);
  const labels = useLabels();
  const actions = buildExportActions(artifact, { getRenderedHtml, assetBaseUrl, labels });

  return (
    <div className="cv-export">
      <button
        className="cv-export__btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {labels.exportMenu}
      </button>

      {open && (
        <>
          <div className="cv-export__scrim" onClick={() => setOpen(false)} />
          <div className="cv-export__menu" role="menu">
            {actions.map((action) =>
              action.id === "copy" ? (
                // Copy stays open with a short "Copied" flash instead of closing.
                <button
                  key={action.id}
                  role="menuitem"
                  onClick={async () => {
                    await action.run();
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  }}
                >
                  {copied ? labels.exportCopied : action.label}
                </button>
              ) : (
                <button
                  key={action.id}
                  role="menuitem"
                  onClick={async () => {
                    await action.run();
                    setOpen(false);
                  }}
                >
                  {action.label}
                  {action.extension && <span className="cv-export__ext">.{action.extension}</span>}
                </button>
              ),
            )}
            {(extras ?? []).map((extra) => (
              <button
                key={`extra-${extra.label}`}
                role="menuitem"
                onClick={() => {
                  void extra.run();
                  setOpen(false);
                }}
              >
                {extra.label}
                {extra.extension && <span className="cv-export__ext">.{extra.extension}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
