/**
 * The reconciler — the single place artifact state is mutated.
 *
 * `reduceCanvas(state, event)` is a pure function: given the current canvas
 * state and one canvas event, it returns the next state. The store, hooks, and
 * components never branch on event `type` — they read the reconciled artifacts.
 * That keeps streaming (`append`), partial updates (`patch`), and versioning
 * (`replace`) auditable in one reducer.
 */

import type { Artifact } from "../protocol/artifacts";
import type { CanvasEvent } from "../protocol/events";

export interface CanvasState {
  /** Current (latest-version) artifact per id. */
  artifacts: Record<string, Artifact>;
  /** Version snapshots per id, oldest first. Grows on `canvas.replace`. */
  history: Record<string, Artifact[]>;
  /** Creation order — drives tab ordering in the panel. */
  order: string[];
  /** The artifact the panel currently focuses. */
  activeId: string | null;
}

export function emptyCanvasState(): CanvasState {
  return { artifacts: {}, history: {}, order: [], activeId: null };
}

export function reduceCanvas(state: CanvasState, event: CanvasEvent): CanvasState {
  switch (event.type) {
    case "canvas.create":
      return create(state, event.artifact);

    case "canvas.append": {
      const current = state.artifacts[event.id];
      if (!current) return state;
      const data = appendAtPath(current.data, event.path, event.text);
      return replaceInPlace(state, { ...current, data });
    }

    case "canvas.patch": {
      const current = state.artifacts[event.id];
      if (!current) return state;
      const data = mergePatch(current.data, event.patch);
      return replaceInPlace(state, { ...current, data });
    }

    case "canvas.node_patch": {
      const current = state.artifacts[event.id];
      const html = (current?.data as { html?: string } | undefined)?.html;
      if (!current || typeof html !== "string") return state;
      const next = applyNodePatch(html, event.cid, event.html);
      const data = { ...(current.data as Record<string, unknown>), html: next };
      return replaceInPlace(state, { ...current, data });
    }

    case "canvas.replace":
      return pushVersion(state, event.artifact);

    case "canvas.status": {
      const current = state.artifacts[event.id];
      if (!current) return state;
      return replaceInPlace(state, { ...current, status: event.status });
    }

    case "canvas.close":
      // Keep the artifact and its history; just drop focus if it was active.
      return state.activeId === event.id ? { ...state, activeId: lastOf(state.order, event.id) } : state;
  }
}

// --- state transitions ----------------------------------------------------------

function create(state: CanvasState, artifact: Artifact): CanvasState {
  const known = state.order.includes(artifact.id);
  return {
    artifacts: { ...state.artifacts, [artifact.id]: artifact },
    history: { ...state.history, [artifact.id]: [artifact] },
    order: known ? state.order : [...state.order, artifact.id],
    activeId: artifact.id,
  };
}

/** Update the live artifact for an id without touching version history. */
function replaceInPlace(state: CanvasState, artifact: Artifact): CanvasState {
  const versions = state.history[artifact.id] ?? [];
  const history = versions.length
    ? { ...state.history, [artifact.id]: [...versions.slice(0, -1), artifact] }
    : { ...state.history, [artifact.id]: [artifact] };
  return { ...state, artifacts: { ...state.artifacts, [artifact.id]: artifact }, history };
}

/** Publish a new version snapshot, bumping the version rail. */
function pushVersion(state: CanvasState, artifact: Artifact): CanvasState {
  const versions = state.history[artifact.id] ?? [];
  const known = state.order.includes(artifact.id);
  return {
    artifacts: { ...state.artifacts, [artifact.id]: artifact },
    history: { ...state.history, [artifact.id]: [...versions, artifact] },
    order: known ? state.order : [...state.order, artifact.id],
    activeId: artifact.id,
  };
}

// --- pure data helpers ----------------------------------------------------------

/** Append `text` to a string at a dot-path inside `data` (immutably). Unknown or
 *  non-object intermediate segments make it a no-op rather than throwing. */
function appendAtPath(data: unknown, path: string, text: string): unknown {
  const keys = path.split(".");
  const clone = structuredClone(data) as Record<string, unknown>;
  let node: Record<string, unknown> = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = node[keys[i]];
    if (!isPlainObject(next)) return data; // path doesn't exist — leave data as-is
    node = next;
  }
  const leaf = keys[keys.length - 1];
  node[leaf] = `${(node[leaf] as string) ?? ""}${text}`;
  return clone;
}

/**
 * Replace one element inside an HTML string by its `data-cid` tree path.
 *
 * The `cid` (e.g. "e-0-2") is the path the iframe inspector assigns by walking
 * `document.body` — so we resolve it the same way against a parse of the source:
 * body → child 0 → child 2. Element children only (matching `el.children`), so
 * the path stays stable regardless of whitespace text nodes. No-ops safely
 * outside a DOM environment (SSR) or on a stale path.
 */
function applyNodePatch(html: string, cid: string, fragment: string): string {
  if (typeof DOMParser === "undefined") return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const target = resolveCid(doc.body, cid);
    // A parentless node (body/root) can't take `outerHTML`; a stale path resolves
    // to nothing. Either way, leave the document untouched rather than throw.
    if (!target || !target.parentNode) return html;
    target.outerHTML = fragment;
    return `<!doctype html>\n${doc.documentElement.outerHTML}`;
  } catch {
    // A malformed patch must never crash the reducer (and the whole app with it).
    return html;
  }
}

function resolveCid(body: Element | null, cid: string): Element | null {
  if (!body) return null;
  const indices = cid.split("-").slice(1); // drop the leading "e"
  let node: Element = body;
  for (const raw of indices) {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0) return null;
    const child = node.children[index];
    if (!child) return null;
    node = child;
  }
  return node;
}

/**
 * RFC 7386 JSON Merge Patch: `null` deletes a key, plain objects merge
 * recursively, everything else (arrays, scalars) replaces.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const base = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key], value);
  }
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastOf(order: string[], excludeId: string): string | null {
  const remaining = order.filter((id) => id !== excludeId);
  return remaining.length ? remaining[remaining.length - 1] : null;
}
