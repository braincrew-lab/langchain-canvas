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
import { type CanvasState, emptyCanvasState, reduceCanvas } from "../client/reconcile";

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
  /** style · structure (duplicate/delete/move/insert/insert_html) · group/ungroup · set_src · clear. */
  type:
    | "set_style" | "commit" | "clear" | "set_src"
    | "duplicate" | "delete" | "move_up" | "move_down" | "insert" | "insert_html"
    | "group" | "ungroup";
  /** Target element (omitted for document-level inserts with no selection). */
  cid?: string;
  /** Members to wrap for `group`. */
  cids?: string[];
  prop?: string;
  value?: string;
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
  error: string | null;
  /** Elements the user selected inside an `html` artifact (click = 1, marquee = N). */
  selections: ElementSelection[];
  /** Last command forwarded to the html iframe (style panel → renderer bus). */
  iframeCommand: IframeCommand | null;

  /** Snapshots for undo/redo — only user edits are recorded (not agent streaming). */
  undoStack: CanvasState[];
  redoStack: CanvasState[];

  // actions
  applyEvent: (event: StreamEvent) => void;
  /** Apply a batch of events in a single store write (one re-render per frame). */
  applyEvents: (events: StreamEvent[]) => void;
  /** Apply a *user*-initiated event, recording a snapshot so it can be undone. */
  applyUserEvent: (event: StreamEvent) => void;
  undo: () => void;
  redo: () => void;
  addUserMessage: (text: string) => void;
  setStreaming: (value: boolean) => void;
  setActiveArtifact: (id: string) => void;
  setSelections: (selections: ElementSelection[]) => void;
  sendIframeCommand: (command: Omit<IframeCommand, "seq">) => void;
  reset: () => void;
}

const UNDO_LIMIT = 50;

const initialState = () => ({
  canvas: emptyCanvasState(),
  messages: [] as ChatMessage[],
  isStreaming: false,
  error: null as string | null,
  selections: [] as ElementSelection[],
  iframeCommand: null as IframeCommand | null,
  undoStack: [] as CanvasState[],
  redoStack: [] as CanvasState[],
});

/** Create an isolated canvas store. */
export function createCanvasStore(): StoreApi<CanvasStore> {
  return createStore<CanvasStore>((set) => ({
    ...initialState(),

    applyEvent: (event) => set((state) => foldEvent(state, event)),
    applyEvents: (events) => set((state) => events.reduce(foldEvent, state)),

    applyUserEvent: (event) =>
      set((state) => {
        const undoStack = [...state.undoStack, state.canvas].slice(-UNDO_LIMIT);
        return { ...foldEvent(state, event), undoStack, redoStack: [] };
      }),
    undo: () =>
      set((state) => {
        if (!state.undoStack.length) return state;
        const previous = state.undoStack[state.undoStack.length - 1];
        return {
          canvas: previous,
          undoStack: state.undoStack.slice(0, -1),
          redoStack: [...state.redoStack, state.canvas].slice(-UNDO_LIMIT),
          selections: [],
        };
      }),
    redo: () =>
      set((state) => {
        if (!state.redoStack.length) return state;
        const next = state.redoStack[state.redoStack.length - 1];
        return {
          canvas: next,
          redoStack: state.redoStack.slice(0, -1),
          undoStack: [...state.undoStack, state.canvas].slice(-UNDO_LIMIT),
          selections: [],
        };
      }),

    addUserMessage: (text) =>
      set((state) => ({
        messages: [...state.messages, { id: `user_${state.messages.length}`, role: "user", text }],
        error: null,
      })),

    setStreaming: (value) => set({ isStreaming: value }),
    setActiveArtifact: (id) => set((state) => ({ canvas: { ...state.canvas, activeId: id } })),
    setSelections: (selections) => set({ selections }),
    sendIframeCommand: (command) =>
      set((state) => ({ iframeCommand: { ...command, seq: (state.iframeCommand?.seq ?? 0) + 1 } })),

    reset: () => set(initialState()),
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
