/**
 * The canvas store — chat transcript + reconciled canvas state in one place.
 *
 * This is a *factory*, not a singleton: `createCanvasStore()` returns an
 * isolated store so an app can host several independent canvas/chat instances.
 * `<CanvasProvider>` (see `context.tsx`) wires one up; provider-less apps share a
 * lazily-created default store, keeping the simple API working.
 *
 * Every wire event flows through `applyEvent` → the pure `reduceCanvas` reducer
 * for canvas events, folded into `messages` for chat events, so streaming,
 * patching, and versioning stay in one auditable place.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import type { StreamEvent } from "../protocol/events";
import { isCanvasEvent } from "../protocol/events";
import type { ElementSelection } from "../protocol/selection";
import type { Artifact } from "../protocol/artifacts";
import { type CanvasState, emptyCanvasState, reduceCanvas, updateLive } from "../client/reconcile";

/** Fired when the *user* edits an artifact in the canvas (a table cell, a chart
 *  value, document text, a slide/HTML element). The host wires this to sync the
 *  edit back to the agent/backend so the next turn sees it. */
export type UserEditHandler = (artifact: Artifact) => void;

/** The artifact id a user-edit event targets, or null for non-mutating events. */
function editedArtifactId(event: StreamEvent): string | null {
  switch (event.type) {
    case "canvas.create":
    case "canvas.replace":
      return event.artifact.id;
    case "canvas.append":
    case "canvas.patch":
    case "canvas.node_patch":
      return event.id;
    default:
      return null;
  }
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Artifact ids this assistant message produced — drives inline artifact cards. */
  artifactIds?: string[];
}

/** A command the editing UI forwards to the active html artifact's iframe. */
export interface IframeCommand {
  artifactId: string;
  /** style · structure (duplicate/delete/move/insert/insert_html) · group/ungroup · set_src · set_slide_style · clear. */
  type:
    | "set_style" | "style_persist" | "commit" | "clear" | "set_src" | "set_slide_style" | "scroll_to"
    | "duplicate" | "delete" | "move_up" | "move_down" | "insert" | "insert_html"
    | "group" | "ungroup";
  /** Target element (omitted for document-level inserts with no selection). */
  cid?: string;
  /** Members to wrap for `group`. */
  cids?: string[];
  prop?: string;
  value?: string;
  /** Style map to apply to the slide root for `set_slide_style` (e.g. background, color). */
  style?: Record<string, string>;
  /** Heading index to scroll into view for `scroll_to`. */
  index?: number;
  /** Tag/block to insert for `insert` (e.g. "h2", "p", "button", "img", "hr", "section"). */
  block?: string;
  /** HTML fragment to insert for `insert_html` (a built-in section template). */
  html?: string;
  /** Monotonic counter so re-issuing an identical command still fires. */
  seq: number;
}

export interface CanvasStore {
  // state
  canvas: CanvasState;
  messages: ChatMessage[];
  isStreaming: boolean;
  /** The agent is working on this canvas: hand edits are refused until it is done. */
  isBusy: boolean;
  error: string | null;
  /** Elements the user selected inside an `html` artifact (click = 1, marquee = N). */
  selections: ElementSelection[];
  /** Last command forwarded to the html iframe (style panel → renderer bus). */
  iframeCommand: IframeCommand | null;

  /** Snapshots for undo/redo, per artifact — only the person's own edits are
   *  recorded, and an agent write to a file clears that file's stacks: what
   *  the agent produced is a version on the rail, not a step to undo. */
  undoStack: Record<string, Artifact[]>;
  redoStack: Record<string, Artifact[]>;

  /** Host callback fired after a user edit reconciles — the write-back hook. */
  onUserEdit: UserEditHandler | null;
  /** Fires every pending debounced save at once (see `useCanvasSave`). */
  saveFlusher: (() => Promise<void>) | null;

  /** URL prefix that resolves a canvas-relative asset path (see `resolveAssetUrl`).
   *  Renderers use it to display `assets/` / `sources/` references live; the
   *  export menu uses it to inline them. Null = no file endpoint (references
   *  stay unresolved, everything else behaves as before). */
  assetBaseUrl: string | null;

  /** The shown artifact's rendered body HTML (editor chrome stripped), for a
   *  host-drawn export control — `<Canvas>` registers it while an artifact is
   *  on screen. Null = nothing on screen. */
  renderedHtml: (() => string | null) | null;

  // actions
  applyEvent: (event: StreamEvent) => void;
  /** Apply a batch of events in a single store write (one re-render per frame). */
  applyEvents: (events: StreamEvent[]) => void;
  /** Apply a *user*-initiated event, recording a snapshot so it can be undone. */
  applyUserEvent: (event: StreamEvent) => void;
  /** Step the active artifact back / forward. Each step is an edit like any
   *  other: it is refused while the agent works and it reaches `onUserEdit`,
   *  so what is on screen after undo is what gets saved. */
  undo: () => void;
  redo: () => void;
  /** Hand pending saves through now (the host registers the flusher). Blurs
   *  an edit in progress first so its value is part of what lands. */
  flushSaves: () => Promise<void>;
  setSaveFlusher: (flush: (() => Promise<void>) | null) => void;
  addUserMessage: (text: string) => void;
  setStreaming: (value: boolean) => void;
  /** Freeze or thaw hand editing (the host flips this around an agent run). */
  setBusy: (value: boolean) => void;
  setActiveArtifact: (id: string) => void;
  setSelections: (selections: ElementSelection[]) => void;
  sendIframeCommand: (command: Omit<IframeCommand, "seq">) => void;
  /** Register (or clear) the user-edit write-back handler. */
  setOnUserEdit: (handler: UserEditHandler | null) => void;
  setAssetBaseUrl: (url: string | null) => void;
  setRenderedHtml: (getter: (() => string | null) | null) => void;
  reset: () => void;
}

const UNDO_LIMIT = 50;

const initialState = () => ({
  canvas: emptyCanvasState(),
  messages: [] as ChatMessage[],
  isStreaming: false,
  isBusy: false,
  error: null as string | null,
  selections: [] as ElementSelection[],
  iframeCommand: null as IframeCommand | null,
  undoStack: {} as Record<string, Artifact[]>,
  redoStack: {} as Record<string, Artifact[]>,
  saveFlusher: null as (() => Promise<void>) | null,
  onUserEdit: null as UserEditHandler | null,
  assetBaseUrl: null as string | null,
  renderedHtml: null as (() => string | null) | null,
});

/** Create an isolated canvas store. */
export function createCanvasStore(): StoreApi<CanvasStore> {
/** Events from the agent or a reload that put new data into an artifact. */
const REMOTE_DATA_EVENTS = new Set(["canvas.create", "canvas.append", "canvas.patch", "canvas.node_patch", "canvas.replace"]);

/**
 * Count the remote data changes an artifact has received, on `meta.remoteSeq`.
 *
 * An editor that freezes its data at mount (the spreadsheet) needs a reason to
 * remount when the agent writes — and must NOT remount for the person's own
 * edits, which flow through `applyUserEvent` and would otherwise reset the
 * grid under their hands. The two paths are already separate; this is the
 * counter that lets a renderer key on the remote one alone.
 */
function stampRemote(state: CanvasStore, event: StreamEvent): CanvasStore {
  if (!REMOTE_DATA_EVENTS.has(event.type)) return state;
  const id = (event as { id?: string; artifact?: { id?: string } }).id ?? (event as { artifact?: { id?: string } }).artifact?.id;
  if (!id) return state;
  const current = state.canvas.artifacts[id];
  if (!current) return state;
  const remoteSeq = (typeof current.meta?.remoteSeq === "number" ? current.meta.remoteSeq : 0) + 1;
  const stamped = { ...current, meta: { ...(current.meta ?? {}), remoteSeq } };
  // The agent's write is the file's new ground: the person's earlier steps
  // no longer lead anywhere sensible, and undoing across them would put a
  // state on screen the server never had.
  const { [id]: _undo, ...undoStack } = state.undoStack;
  const { [id]: _redo, ...redoStack } = state.redoStack;
  return {
    ...state,
    canvas: { ...state.canvas, artifacts: { ...state.canvas.artifacts, [id]: stamped } },
    undoStack,
    redoStack,
  };
}

/** Put `artifact` on screen as the person's edit and tell the host. */
function restore(set: (fn: (s: CanvasStore) => Partial<CanvasStore>) => void, get: () => CanvasStore, artifact: Artifact, undoStack: Record<string, Artifact[]>, redoStack: Record<string, Artifact[]>): void {
  set((state) => ({ canvas: updateLive(state.canvas, artifact), undoStack, redoStack, selections: [] }));
  const restored = get().canvas.artifacts[artifact.id];
  if (restored) get().onUserEdit?.(restored);
}

  return createStore<CanvasStore>((set, get) => ({
    ...initialState(),

    applyEvent: (event) => set((state) => stampRemote(foldEvent(state, event), event)),
    applyEvents: (events) =>
      set((state) => events.reduce((acc, event) => stampRemote(foldEvent(acc, event), event), state)),

    applyUserEvent: (event) => {
      // While the agent writes, a hand edit would land on a file that is about
      // to change under it and be saved over what the agent produced — or the
      // other way round. The host shows the freeze; this is what enforces it.
      if (get().isBusy) return;
      set((state) => {
        const id = editedArtifactId(event);
        const before = id ? state.canvas.artifacts[id] : undefined;
        if (!id || !before) return foldEvent(state, event);
        const steps = [...(state.undoStack[id] ?? []), before].slice(-UNDO_LIMIT);
        const { [id]: _redo, ...redoStack } = state.redoStack;
        return { ...foldEvent(state, event), undoStack: { ...state.undoStack, [id]: steps }, redoStack };
      });
      // Notify the host of the write so it can sync it back to the agent/backend.
      // Fires after the store settles, with the reconciled artifact.
      const state = get();
      const id = editedArtifactId(event);
      const artifact = id ? state.canvas.artifacts[id] : undefined;
      if (artifact) state.onUserEdit?.(artifact);
    },
    undo: () => {
      const state = get();
      const id = state.canvas.activeId;
      const steps = id ? state.undoStack[id] ?? [] : [];
      const current = id ? state.canvas.artifacts[id] : undefined;
      if (state.isBusy || !id || !steps.length || !current) return;
      const previous = steps[steps.length - 1];
      restore(
        set,
        get,
        previous,
        { ...state.undoStack, [id]: steps.slice(0, -1) },
        { ...state.redoStack, [id]: [...(state.redoStack[id] ?? []), current].slice(-UNDO_LIMIT) },
      );
    },
    redo: () => {
      const state = get();
      const id = state.canvas.activeId;
      const steps = id ? state.redoStack[id] ?? [] : [];
      const current = id ? state.canvas.artifacts[id] : undefined;
      if (state.isBusy || !id || !steps.length || !current) return;
      const next = steps[steps.length - 1];
      restore(
        set,
        get,
        next,
        { ...state.undoStack, [id]: [...(state.undoStack[id] ?? []), current].slice(-UNDO_LIMIT) },
        { ...state.redoStack, [id]: steps.slice(0, -1) },
      );
    },
    flushSaves: async () => {
      if (typeof document !== "undefined") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable) active.blur();
      }
      await get().saveFlusher?.();
    },
    setSaveFlusher: (flush) => set({ saveFlusher: flush }),

    addUserMessage: (text) =>
      set((state) => ({
        messages: [...state.messages, { id: `user_${state.messages.length}`, role: "user", text }],
        error: null,
      })),

    setStreaming: (value) => set({ isStreaming: value }),
    setBusy: (value) => set({ isBusy: value }),
    setActiveArtifact: (id) => set((state) => ({ canvas: { ...state.canvas, activeId: id } })),
    setSelections: (selections) => set({ selections }),
    sendIframeCommand: (command) =>
      set((state) => ({ iframeCommand: { ...command, seq: (state.iframeCommand?.seq ?? 0) + 1 } })),

    setOnUserEdit: (handler) => set({ onUserEdit: handler }),
    setAssetBaseUrl: (url) => set({ assetBaseUrl: url }),
    setRenderedHtml: (getter) => set({ renderedHtml: getter }),

    // Host configuration (the asset endpoint) survives a session reset.
    reset: () => set({ ...initialState(), assetBaseUrl: get().assetBaseUrl }),
  }));
}

// --- pure event folding ---------------------------------------------------------

/**
 * Fold one wire event onto the store slices. Extracted so a single event and a
 * batch share identical semantics (`applyEvents` reduces this over the queue).
 * A `canvas.create` is also linked to the current assistant message so the
 * transcript can show an inline card for it.
 */
function foldEvent(state: CanvasStore, event: StreamEvent): CanvasStore {
  try {
    return reduceEvent(state, event);
  } catch (err) {
    // One malformed event must never crash the store (and the host app with it) —
    // skip it, keep the prior state, and surface it for debugging.
    // eslint-disable-next-line no-console
    console.error("[langchain-canvas] event skipped:", event, err);
    return state;
  }
}

function reduceEvent(state: CanvasStore, event: StreamEvent): CanvasStore {
  if (isCanvasEvent(event)) {
    const canvas = reduceCanvas(state.canvas, event);
    if (event.type === "canvas.create") {
      return { ...state, canvas, messages: linkArtifact(state.messages, event.artifact.id) };
    }
    return { ...state, canvas };
  }
  switch (event.type) {
    case "message.delta":
      return { ...state, messages: appendDelta(state.messages, event.messageId, event.text) };
    case "error":
      return { ...state, error: event.message };
    case "done":
      return { ...state, isStreaming: false };
    // message.end / tool.* — no store change in the reference UI.
    default:
      return state;
  }
}

/** Append an assistant token delta to the message with `id`, creating it once. */
function appendDelta(messages: ChatMessage[], id: string, text: string): ChatMessage[] {
  const index = messages.findIndex((m) => m.id === id);
  if (index === -1) return [...messages, { id, role: "assistant", text }];
  const next = messages.slice();
  next[index] = { ...next[index], text: next[index].text + text };
  return next;
}

/** Attach an artifact id to the latest assistant message (creating one if needed). */
function linkArtifact(messages: ChatMessage[], artifactId: string): ChatMessage[] {
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== "assistant") index--;
  if (index === -1) {
    return [...messages, { id: `assistant_${messages.length}`, role: "assistant", text: "", artifactIds: [artifactId] }];
  }
  const next = messages.slice();
  const current = next[index];
  next[index] = { ...current, artifactIds: [...(current.artifactIds ?? []), artifactId] };
  return next;
}
