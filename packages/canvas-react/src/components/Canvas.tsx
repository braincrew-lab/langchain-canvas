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
import { versionRail } from "../client/reconcile";
import { visibleTabs } from "../client/workingCopies";
import { CanvasRegistryProvider, useRenderer, type ArtifactRegistry } from "../registry/registry";
import { IMPORTABLE_EXTENSIONS } from "../io/importers";
import { builtinRenderers } from "./renderers";
import { ExportMenu, type ExportExtra } from "./ExportMenu";
import { RendererBoundary } from "./RendererBoundary";
import { SelectionBar } from "./SelectionBar";
import { StylePanel } from "./StylePanel";
import { useCanvasImport, type CanvasImportOptions } from "../hooks/useCanvasImport";
import { useCanvasSave, type CanvasSaveHandler } from "../hooks/useCanvasSave";
import { useCanvasStore } from "../hooks/useCanvasStore";
import { ChromeProvider, useChrome, useLabels, type CanvasChrome, type CanvasLabels } from "./chrome";

const ACCEPT = IMPORTABLE_EXTENSIONS.join(",");

export interface CanvasProps {
  /** Renderer map. Defaults to the built-in html/document/chart/table renderers. */
  registry?: ArtifactRegistry;
  /** Rendered when no artifact has been opened yet. */
  emptyState?: ReactNode;
  /**
   * Extra Export-menu entries for the shown artifact, appended after the
   * built-in ones — the seam for host-side (server) exports such as
   * slides→pptx or table→xlsx. Return `[]`/`undefined` for none.
   */
  exportExtras?: (artifact: Artifact) => ExportExtra[] | undefined;
  /**
   * Handle a targeted edit of the selected element (from `useCanvasStream`'s
   * `editSelection`). When provided, clicking an element in an `html` artifact
   * reveals a quick-edit bar.
   */
  onEditElement?: (instruction: string) => void;
  /**
   * Fired after the *user* edits an artifact directly in the canvas — a table
   * cell, a chart value, document text, a slide/HTML element — with the
   * reconciled artifact. Wire this to sync the edit back to the agent/backend so
   * the next turn sees it. Fires per committed edit (table edits are debounced);
   * debounce further on the host before hitting the network.
   */
  onUserEdit?: (artifact: Artifact) => void;
  /**
   * Persist user edits: the debounced companion to `onUserEdit` (see
   * `useCanvasSave`). Called after edits go quiet, with the artifact and the
   * `baseRevision` to hand a store-backed save endpoint. When omitted, edits
   * stay in-memory exactly as before.
   */
  onSave?: CanvasSaveHandler;
  /**
   * Fired with the raw files whenever the user opens files (picker or drop),
   * before any import parsing — the hook for a host to upload originals to
   * its store so the agent can read them. When provided, the file picker
   * accepts every file type (the canvas still previews only what it can
   * import; the host decides what to do with the rest).
   */
  onFilesOpened?: (files: File[]) => void;
  /** Fired per successfully imported file with its canvas artifact (see `useCanvasImport`). */
  onImported?: CanvasImportOptions["onImported"];
  /**
   * URL prefix that resolves a canvas-relative asset path (`assets/…`,
   * `sources/…`) to fetchable bytes — the whole encoded path is appended, e.g.
   * `http://host/api/canvas/<id>/file?path=`. With it, asset references in
   * artifacts display live and export inlined as `data:` URIs. Omit it and
   * references stay unresolved — everything else behaves exactly as before.
   */
  assetBaseUrl?: string;
  /** The agent is working: hand editing is frozen and a banner says so. */
  busy?: boolean;
  /** What the banner reads while `busy` (default `labels.busy`). */
  busyLabel?: string;
  /**
   * Override any user-facing string the panel renders (a partial map — the
   * rest keep their defaults). See `CanvasLabels` for every key.
   */
  labels?: Partial<CanvasLabels>;
  /**
   * Leave out pieces of chrome the host draws itself (header, status badge,
   * undo/redo, version rail, export menu, Word-preview notes, file facts).
   * Every flag defaults to `true`.
   */
  chrome?: Partial<CanvasChrome>;
}

export function Canvas({
  registry = builtinRenderers,
  emptyState,
  exportExtras,
  onEditElement,
  onUserEdit,
  onSave,
  onFilesOpened,
  onImported,
  assetBaseUrl,
  busy = false,
  busyLabel,
  labels,
  chrome,
}: CanvasProps) {
  return (
    <CanvasRegistryProvider registry={registry}>
      <ChromeProvider labels={labels} chrome={chrome}>
        <CanvasPanel
          emptyState={emptyState}
          exportExtras={exportExtras}
          onEditElement={onEditElement}
          onUserEdit={onUserEdit}
          onSave={onSave}
          onFilesOpened={onFilesOpened}
          onImported={onImported}
          assetBaseUrl={assetBaseUrl}
          busy={busy}
          busyLabel={busyLabel}
        />
      </ChromeProvider>
    </CanvasRegistryProvider>
  );
}

function CanvasPanel({
  emptyState,
  exportExtras,
  onEditElement,
  onUserEdit,
  onSave,
  onFilesOpened,
  onImported,
  assetBaseUrl,
  busy = false,
  busyLabel,
}: Pick<
  CanvasProps,
  | "emptyState"
  | "exportExtras"
  | "onEditElement"
  | "onUserEdit"
  | "onSave"
  | "onFilesOpened"
  | "onImported"
  | "assetBaseUrl"
  | "busy"
  | "busyLabel"
>) {
  const labels = useLabels();
  const debouncedSave = useCanvasSave(onSave);
  const { artifacts, order, activeId } = useCanvasStore((s) => s.canvas);
  const history = useCanvasStore((s) => s.canvas.history);
  const setActive = useCanvasStore((s) => s.setActiveArtifact);
  const setBusy = useCanvasStore((s) => s.setBusy);
  // The host knows when a run starts and ends; the store is what refuses
  // hand edits meanwhile. Keep them in step for as long as this Canvas lives.
  useEffect(() => {
    setBusy(busy);
    return () => setBusy(false);
  }, [busy, setBusy]);
  const selections = useCanvasStore((s) => s.selections);
  const setSelections = useCanvasStore((s) => s.setSelections);
  const setOnUserEdit = useCanvasStore((s) => s.setOnUserEdit);
  const setSaveFlusher = useCanvasStore((s) => s.setSaveFlusher);
  const setAssetBaseUrl = useCanvasStore((s) => s.setAssetBaseUrl);
  const { importFiles } = useCanvasImport({ onImported });
  const [dropping, setDropping] = useState(false);

  // Publish the host's asset endpoint so renderers and the export menu can
  // resolve `assets/` / `sources/` references.
  useEffect(() => {
    setAssetBaseUrl(assetBaseUrl ?? null);
  }, [assetBaseUrl, setAssetBaseUrl]);

  // Open = hand the raw files to the host (upload) + preview what we can import.
  const openFiles = (files: FileList) => {
    onFilesOpened?.(Array.from(files));
    void importFiles(files);
  };

  // Keep the store's write-back handler in sync with the latest prop.
  useEffect(() => {
    if (!onUserEdit && !debouncedSave) {
      setOnUserEdit(null);
      return;
    }
    // One store slot, two consumers: the host's immediate write-back and the
    // debounced persistence saver share the same user-edit signal.
    setOnUserEdit((artifact) => {
      onUserEdit?.(artifact);
      debouncedSave?.(artifact);
    });
    setSaveFlusher(debouncedSave ? debouncedSave.flush : null);
    return () => {
      setOnUserEdit(null);
      setSaveFlusher(null);
    };
  }, [onUserEdit, debouncedSave, setOnUserEdit, setSaveFlusher]);

  // Escape clears the current selection (closes the style panel / selection bar).
  // The in-iframe highlight is dropped by HtmlRenderer once selections empties.
  useEffect(() => {
    if (!selections.length) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelections([]); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selections.length, setSelections]);

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
      if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
    },
  };
  const dropOverlay = dropping ? <div className="cv-canvas__drop">{labels.dropToOpen}</div> : null;

  if (!active) {
    return (
      <aside className="cv-canvas cv-canvas--empty" {...dropProps}>
        {emptyState ?? <EmptyState onOpenFiles={openFiles} acceptAll={Boolean(onFilesOpened)} />}
        {dropOverlay}
      </aside>
    );
  }

  const versions = versionRail(history[active.id] ?? [active]);
  // An upload being edited through a copy shows as the copy alone.
  const tabs = visibleTabs(order);
  const showSelection = Boolean(onEditElement) && selections.length > 0 && selections[0].artifactId === active.id;

  return (
    <aside className="cv-canvas" {...dropProps}>
      {dropOverlay}
      {tabs.length > 1 && (
        <nav className="cv-tabs" role="tablist">
          {tabs.map((id) => (
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
      <ArtifactView
        key={active.id}
        artifact={active}
        versions={versions}
        busyLabel={busyLabel ?? labels.busy}
        exportExtras={exportExtras}
      />

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
function ArtifactView({
  artifact,
  versions,
  busyLabel,
  exportExtras,
}: {
  artifact: Artifact;
  versions: Artifact[];
  busyLabel: string;
  exportExtras?: CanvasProps["exportExtras"];
}) {
  // The freeze lives in the store (it is what refuses hand edits); the view
  // only reflects it.
  const busy = useCanvasStore((s) => s.isBusy);
  const setRenderedHtml = useCanvasStore((s) => s.setRenderedHtml);
  const labels = useLabels();
  const chrome = useChrome();
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = viewIndex === null ? artifact : versions[viewIndex];
  // Historical snapshots are read-only: edits target the id's latest artifact,
  // so allowing them while viewing an old version would corrupt head silently.
  const viewingHistory = viewIndex !== null && viewIndex !== versions.length - 1;
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

  // Publish the getter so a host-drawn export control exports what is shown.
  useEffect(() => {
    setRenderedHtml(getRenderedHtml);
    return () => setRenderedHtml(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setRenderedHtml]);

  return (
    <>
      {chrome.header && (
        <header className="cv-header">
          <div className="cv-header__title">
            <h2>{shown.title}</h2>
            {chrome.statusBadge && <StatusBadge status={shown.status} />}
          </div>
          <div className="cv-header__actions">
            {chrome.undoRedo && <UndoRedo />}
            {chrome.versions && versions.length > 1 && (
              <VersionHistory
                versions={versions}
                index={viewIndex ?? versions.length - 1}
                onSelect={(i) => setViewIndex(i === versions.length - 1 ? null : i)}
              />
            )}
            {chrome.exportMenu && (
              <ExportMenu artifact={shown} getRenderedHtml={getRenderedHtml} extras={exportExtras?.(shown)} />
            )}
          </div>
        </header>
      )}

      {viewingHistory && (
        <div className="cv-history-banner" role="status">
          {labels.viewingVersion((viewIndex ?? 0) + 1, versions.length)}{" "}
          <button onClick={() => setViewIndex(null)}>{labels.backToLatest}</button>
        </div>
      )}
      {busy && (
        <div className="cv-busy-banner" role="status" aria-live="polite">
          <span className="cv-busy-banner__dot" aria-hidden /> {busyLabel}
        </div>
      )}

      {/* spreadsheets own their own scroll — give them a flush, non-scrolling body */}
      <div
        className={`cv-body${shown.type === "table" ? " cv-body--flush" : ""}${viewingHistory ? " cv-body--history" : ""}${busy ? " cv-body--busy" : ""}`}
        ref={bodyRef}
      >
        {Renderer ? (
          <RendererBoundary resetKey={`${shown.id}:${shown.version}`} label={labels.renderFailed}>
            {/* Structured renderers are lazy (recharts / react-markdown / fortune-sheet
                split into on-demand chunks); Suspense covers their first load. */}
            <Suspense fallback={<div className="cv-fallback">{labels.loading}</div>}>
              <Renderer artifact={shown} />
            </Suspense>
          </RendererBoundary>
        ) : (
          <div className="cv-fallback">{labels.noRenderer(shown.type)}</div>
        )}
      </div>
    </>
  );
}

/** Undo / redo for user edits, plus the ⌘Z / ⌘⇧Z (Ctrl on Windows) shortcuts. */
function UndoRedo() {
  const labels = useLabels();
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => !s.isBusy && (s.canvas.activeId ? (s.undoStack[s.canvas.activeId]?.length ?? 0) : 0) > 0);
  const canRedo = useCanvasStore((s) => !s.isBusy && (s.canvas.activeId ? (s.redoStack[s.canvas.activeId]?.length ?? 0) : 0) > 0);

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
    <div className="cv-undo" role="group" aria-label={labels.undoRedoGroup}>
      <button onClick={undo} disabled={!canUndo} title={labels.undo} aria-label={labels.undo}>↶</button>
      <button onClick={redo} disabled={!canRedo} title={labels.redo} aria-label={labels.redo}>↷</button>
    </div>
  );
}

/**
 * Version rail plus a described-history popover. The rail keeps the old
 * `‹ v2/5 ›` stepping; the label opens a list of snapshots with the commit
 * descriptions stamped by `canvas.commit` (falling back to "Snapshot").
 */
function VersionHistory({
  versions,
  index,
  onSelect,
}: {
  versions: Artifact[];
  index: number;
  onSelect: (i: number) => void;
}) {
  const labels = useLabels();
  const [open, setOpen] = useState(false);
  const total = versions.length;
  const pick = (i: number) => {
    setOpen(false);
    onSelect(i);
  };
  return (
    <div className="cv-versions" role="group" aria-label={labels.versionsGroup}>
      <button className="cv-versions__nav" disabled={index === 0} onClick={() => pick(index - 1)} aria-label={labels.previousVersion}>
        ‹
      </button>
      <button
        className="cv-versions__label"
        aria-expanded={open}
        aria-label={labels.openVersions}
        onClick={() => setOpen((v) => !v)}
      >
        {labels.versionOf(index + 1, total)}
      </button>
      <button
        className="cv-versions__nav"
        disabled={index === total - 1}
        onClick={() => pick(index + 1)}
        aria-label={labels.nextVersion}
      >
        ›
      </button>
      {open && (
        <ul className="cv-versions__list" role="listbox" aria-label={labels.versionsList}>
          {versions
            .map((snapshot, i) => ({ snapshot, i }))
            .reverse()
            .map(({ snapshot, i }) => (
              <li key={i}>
                <button
                  role="option"
                  aria-selected={i === index}
                  className={i === index ? "is-current" : undefined}
                  onClick={() => pick(i)}
                >
                  <span className="cv-versions__v">{labels.versionItem(i + 1)}</span>
                  <span className="cv-versions__desc">
                    {typeof snapshot.meta?.commitDescription === "string"
                      ? snapshot.meta.commitDescription
                      : labels.snapshot}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Artifact["status"] }) {
  const labels = useLabels();
  const label = status === "streaming" ? labels.statusWriting : status === "error" ? labels.statusError : labels.statusReady;
  return <span className={`cv-badge cv-badge--${status}`}>{label}</span>;
}

function EmptyState({
  onOpenFiles,
  acceptAll = false,
}: {
  onOpenFiles?: (files: FileList) => void;
  /** Accept every file type (the host uploads originals beyond the importable set). */
  acceptAll?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const labels = useLabels();
  return (
    <div className="cv-empty">
      <p className="cv-empty__title">{labels.emptyTitle}</p>
      <p className="cv-empty__hint">{labels.emptyHint}</p>
      {onOpenFiles && (
        <>
          <button className="cv-empty__open" onClick={() => inputRef.current?.click()}>
            {labels.emptyOpen}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={acceptAll ? undefined : ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onOpenFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <p className="cv-empty__formats">
            {acceptAll ? labels.emptyFormatsAny : labels.emptyFormats}
          </p>
        </>
      )}
    </div>
  );
}
