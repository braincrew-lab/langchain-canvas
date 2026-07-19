/**
 * `<Canvas />` — the panel shell beside the chat.
 *
 * It is deliberately thin: it reads reconciled artifacts from the store, lets
 * the user switch between open artifacts (tabs) and browse versions (rail), and
 * delegates the actual drawing to whatever renderer the registry resolves for
 * the artifact `type`. All artifact *state* lives in the reconciler; this
 * component only owns view-local concerns (which tab, which version).
 */

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import type { Artifact } from "../protocol/artifacts";
import { CanvasRegistryProvider, useRenderer, type ArtifactRegistry } from "../registry/registry";
import { IMPORTABLE_EXTENSIONS } from "../io/importers";
import { builtinRenderers } from "./renderers";
import { ExportMenu } from "./ExportMenu";
import { RendererBoundary } from "./RendererBoundary";
import { SelectionBar } from "./SelectionBar";
import { StylePanel } from "./StylePanel";
import { useCanvasImport } from "../hooks/useCanvasImport";
import { useCanvasStore } from "../hooks/useCanvasStore";

const ACCEPT = IMPORTABLE_EXTENSIONS.join(",");

export interface CanvasProps {
  /** Renderer map. Defaults to the built-in html/document/chart/table renderers. */
  registry?: ArtifactRegistry;
  /** Rendered when no artifact has been opened yet. */
  emptyState?: ReactNode;
  /**
   * Handle a targeted edit of the selected element (from `useCanvasStream`'s
   * `editSelection`). When provided, clicking an element in an `html` artifact
   * reveals a quick-edit bar.
   */
  onEditElement?: (instruction: string) => void;
}

export function Canvas({ registry = builtinRenderers, emptyState, onEditElement }: CanvasProps) {
  return (
    <CanvasRegistryProvider registry={registry}>
      <CanvasPanel emptyState={emptyState} onEditElement={onEditElement} />
    </CanvasRegistryProvider>
  );
}

function CanvasPanel({ emptyState, onEditElement }: Pick<CanvasProps, "emptyState" | "onEditElement">) {
  const { artifacts, order, activeId } = useCanvasStore((s) => s.canvas);
  const history = useCanvasStore((s) => s.canvas.history);
  const setActive = useCanvasStore((s) => s.setActiveArtifact);
  const selections = useCanvasStore((s) => s.selections);
  const setSelections = useCanvasStore((s) => s.setSelections);
  const { importFiles } = useCanvasImport();
  const [dropping, setDropping] = useState(false);

  const active = activeId ? artifacts[activeId] : undefined;

  // Drag-and-drop a file anywhere on the panel to open it as an artifact.
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        setDropping(true);
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDropping(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropping(false);
      if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
    },
  };
  const dropOverlay = dropping ? <div className="cv-canvas__drop">Drop to open on the canvas</div> : null;

  if (!active) {
    return (
      <aside className="cv-canvas cv-canvas--empty" {...dropProps}>
        {emptyState ?? <EmptyState onOpenFiles={importFiles} />}
        {dropOverlay}
      </aside>
    );
  }

  const versions = history[active.id] ?? [active];
  const showSelection = Boolean(onEditElement) && selections.length > 0 && selections[0].artifactId === active.id;

  return (
    <aside className="cv-canvas" {...dropProps}>
      {dropOverlay}
      {order.length > 1 && (
        <nav className="cv-tabs" role="tablist">
          {order.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={id === activeId}
              className={`cv-tab ${id === activeId ? "is-active" : ""}`}
              onClick={() => setActive(id)}
            >
              {artifacts[id].title}
            </button>
          ))}
        </nav>
      )}

      {/* key by id so per-artifact view state (which version) resets on tab switch */}
      <ArtifactView key={active.id} artifact={active} versions={versions} />

      {showSelection && onEditElement && (
        <>
          {active.type === "html" && selections.length === 1 && (
            <StylePanel key={selections[0].cid} selection={selections[0]} />
          )}
          <SelectionBar selections={selections} onEdit={onEditElement} onClear={() => setSelections([])} />
        </>
      )}
    </aside>
  );
}

/** Header (title + status + version rail) plus the resolved renderer body. */
function ArtifactView({ artifact, versions }: { artifact: Artifact; versions: Artifact[] }) {
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = viewIndex === null ? artifact : versions[viewIndex];
  const Renderer = useRenderer(shown.type);

  // Rendered HTML for export, with editor chrome (toolbars, nav, contenteditable)
  // stripped so the exported file is clean content only.
  const getRenderedHtml = () => {
    const node = bodyRef.current;
    if (!node) return null;
    const clone = node.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll(".cv-edit-toolbar, .cv-slides__nav, .cv-selection, .cv-style, .cv-chrome")
      .forEach((el) => el.remove());
    clone.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
    return clone.innerHTML;
  };

  return (
    <>
      <header className="cv-header">
        <div className="cv-header__title">
          <h2>{shown.title}</h2>
          <StatusBadge status={shown.status} />
        </div>
        <div className="cv-header__actions">
          <UndoRedo />
          {versions.length > 1 && (
            <VersionRail
              total={versions.length}
              index={viewIndex ?? versions.length - 1}
              onSelect={(i) => setViewIndex(i === versions.length - 1 ? null : i)}
            />
          )}
          <ExportMenu artifact={shown} getRenderedHtml={getRenderedHtml} />
        </div>
      </header>

      {/* spreadsheets own their own scroll — give them a flush, non-scrolling body */}
      <div className={`cv-body${shown.type === "table" ? " cv-body--flush" : ""}`} ref={bodyRef}>
        {Renderer ? (
          <RendererBoundary resetKey={`${shown.id}:${shown.version}`}>
            {/* Structured renderers are lazy (recharts / react-markdown / fortune-sheet
                split into on-demand chunks); Suspense covers their first load. */}
            <Suspense fallback={<div className="cv-fallback">Loading…</div>}>
              <Renderer artifact={shown} />
            </Suspense>
          </RendererBoundary>
        ) : (
          <div className="cv-fallback">No renderer registered for type “{shown.type}”.</div>
        )}
      </div>
    </>
  );
}

/** Undo / redo for user edits, plus the ⌘Z / ⌘⇧Z (Ctrl on Windows) shortcuts. */
function UndoRedo() {
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.undoStack.length > 0);
  const canRedo = useCanvasStore((s) => s.redoStack.length > 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      // Leave native undo to real text fields in the host document (chat input, code view).
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      e.preventDefault();
      if (key === "y" || (key === "z" && e.shiftKey)) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  return (
    <div className="cv-undo" role="group" aria-label="Undo and redo">
      <button onClick={undo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">↶</button>
      <button onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)" aria-label="Redo">↷</button>
    </div>
  );
}

function VersionRail({ total, index, onSelect }: { total: number; index: number; onSelect: (i: number) => void }) {
  return (
    <div className="cv-versions" role="group" aria-label="Version history">
      <button className="cv-versions__nav" disabled={index === 0} onClick={() => onSelect(index - 1)} aria-label="Previous version">
        ‹
      </button>
      <span className="cv-versions__label">
        v{index + 1} / {total}
      </span>
      <button
        className="cv-versions__nav"
        disabled={index === total - 1}
        onClick={() => onSelect(index + 1)}
        aria-label="Next version"
      >
        ›
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: Artifact["status"] }) {
  const label = status === "streaming" ? "Writing…" : status === "error" ? "Error" : "Ready";
  return <span className={`cv-badge cv-badge--${status}`}>{label}</span>;
}

function EmptyState({ onOpenFiles }: { onOpenFiles?: (files: FileList) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="cv-empty">
      <p className="cv-empty__title">Nothing on the canvas yet</p>
      <p className="cv-empty__hint">Ask for a report or a chart — or open a file to edit it here.</p>
      {onOpenFiles && (
        <>
          <button className="cv-empty__open" onClick={() => inputRef.current?.click()}>
            Open file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onOpenFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <p className="cv-empty__formats">CSV · Excel · Markdown · HTML · JSON</p>
        </>
      )}
    </div>
  );
}
