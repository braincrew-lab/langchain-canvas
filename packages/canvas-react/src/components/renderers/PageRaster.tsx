import { useLayoutEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useCanvasStoreApi, type CanvasStore } from "../../hooks/useCanvasStore";

interface Raster {
  image: HTMLImageElement;
  source: string;
  request: number;
  width: number;
  ready: boolean;
}

interface RasterCache {
  generation: number;
  pixels: number;
  entries: Map<string, Raster>;
  listeners: Set<(source?: string) => void>;
}

// Only detached, decoded nodes count toward this cache. Mounted pages own their
// nodes exclusively, so a second viewer can never steal a first viewer's image.
const MAX_CACHED_PAGES = 16;
const MAX_CACHED_PIXELS = 16_000_000;
const caches = new WeakMap<StoreApi<CanvasStore>, RasterCache>();

function discard(raster: Raster) {
  raster.image.onload = null;
  raster.image.onerror = null;
  raster.image.remove();
  raster.image.removeAttribute("src");
}

function getCache(store: StoreApi<CanvasStore>) {
  let cache = caches.get(store);
  if (!cache) {
    cache = { generation: 0, pixels: 0, entries: new Map(), listeners: new Set() };
    caches.set(store, cache);
    const registry = cache;
    store.subscribe((state, previous) => {
      if (state.canvas === previous.canvas || state.canvas.order.length !== 0) return;
      registry.generation++;
      for (const raster of registry.entries.values()) discard(raster);
      registry.entries.clear();
      registry.pixels = 0;
      for (const invalidate of [...registry.listeners]) invalidate();
    });
  }
  return cache;
}

function take(cache: RasterCache, source: string) {
  const raster = cache.entries.get(source);
  if (raster) {
    cache.entries.delete(source);
    cache.pixels -= raster.image.naturalWidth * raster.image.naturalHeight;
  }
  return raster;
}

function revokeSource(cache: RasterCache, source: string) {
  // Revoke live leases before the final purge: a host capture callback may
  // synchronously unmount another consumer and return its node to the cache.
  for (const invalidate of [...cache.listeners]) invalidate(source);
  const cached = take(cache, source);
  if (cached) discard(cached);
}

function release(cache: RasterCache, source: string, raster: Raster, generation: number) {
  raster.image.onload = null;
  raster.image.onerror = null;
  raster.image.remove();
  const size = raster.image.naturalWidth * raster.image.naturalHeight;
  if (!raster.ready || generation !== cache.generation || size <= 0 || size > MAX_CACHED_PIXELS) {
    discard(raster);
    return;
  }
  const previous = cache.entries.get(source);
  if (previous && previous.width >= raster.width) {
    discard(raster);
    return;
  }
  if (previous) {
    take(cache, source);
    discard(previous);
  }
  cache.entries.set(source, raster);
  cache.pixels += size;
  while (cache.entries.size > MAX_CACHED_PAGES || cache.pixels > MAX_CACHED_PIXELS) {
    const oldest = cache.entries.keys().next().value!;
    discard(take(cache, oldest)!);
  }
}

interface PageRasterProps {
  /** Ticket-free document/page layout identity; all other source changes invalidate pixels. */
  scope: string;
  /** Exact credential-bearing endpoint, document revision and page; excludes only raster width. */
  source: string;
  src: string;
  width: number;
  alt: string;
  aspectRatio?: number;
  loading: "eager" | "lazy";
  onLoad: (image: HTMLImageElement) => void;
  onError: () => void;
}

/** Decode-before-swap for upgrades and in-place ticket renewal, never cross-source cache reuse. */
export function PageRaster(props: PageRasterProps) {
  const store = useCanvasStoreApi();
  const host = useRef<HTMLSpanElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const update = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const container = host.current!;
    const cache = getCache(store);
    const generation = cache.generation;
    const scope = props.scope;
    let active = true;
    let disposed = false;
    let current = take(cache, JSON.stringify([scope, props.source]));
    let pending: Raster | undefined;
    let failedWidth: number | undefined;
    let failedSource: string | undefined;
    let nearViewport = typeof IntersectionObserver === "undefined";
    const valid = () => active && cache.generation === generation;
    const decorate = (raster: Raster) => {
      raster.image.className = "cv-pages__page";
      raster.image.alt = latest.current.alt;
      raster.image.style.aspectRatio = latest.current.aspectRatio ? String(latest.current.aspectRatio) : "";
    };
    const fail = (raster: Raster, reportToHost: boolean, decodeFailure = false) => {
      if (!valid() || (raster !== pending && raster !== current) || raster.source !== latest.current.source) return;
      if (raster === pending) pending = undefined;
      failedWidth = raster.width;
      failedSource = raster.source;
      if (raster === current) current = undefined;
      raster.image.onload = null;
      raster.image.onerror = null;
      // Image transport errors do not expose status: a failed upgrade could
      // be authorization denial, so only decode failure after a successful
      // same-credential load may retain previously decoded pixels.
      if (!decodeFailure || !current?.ready || current.source !== raster.source) {
        const previousSource = current?.source;
        const cached = take(cache, JSON.stringify([scope, raster.source]));
        if (cached) discard(cached);
        if (current && current.source !== raster.source) {
          const previous = take(cache, JSON.stringify([scope, current.source]));
          if (previous) discard(previous);
        }
        if (current) discard(current);
        if (pending) discard(pending);
        pending = undefined;
        current = undefined;
        if (reportToHost) {
          // Detached candidates do not reach the host's native capture seam.
          // Report the actual failed image while connected, with our handlers
          // removed so this notification cannot recurse into failure handling.
          container.replaceChildren(raster.image);
          raster.image.dispatchEvent(new Event("error"));
        }
        discard(raster);
        if (!decodeFailure) {
          revokeSource(cache, JSON.stringify([scope, raster.source]));
          if (previousSource && previousSource !== raster.source) {
            revokeSource(cache, JSON.stringify([scope, previousSource]));
          }
        }
        if (valid()) latest.current.onError();
      }
      else discard(raster);
    };
    const announceLoad = (raster: Raster) => {
      const onload = raster.image.onload;
      raster.image.onload = null;
      raster.image.dispatchEvent(new Event("load"));
      if (valid() && current === raster) raster.image.onload = onload;
    };
    const listen = (raster: Raster) => {
      raster.image.onerror = () => fail(raster, !raster.image.isConnected);
      raster.image.onload = () => {
        if (!valid() || (raster !== pending && raster !== current) || raster.ready ||
          raster.image.naturalWidth <= 0 || raster.image.naturalHeight <= 0) return;
        const request = raster.request;
        const commit = () => {
          if (!valid() || (raster !== pending && raster !== current) ||
            raster.request !== request || raster.source !== latest.current.source) return;
          raster.ready = true;
          const replacing = raster !== current;
          if (raster !== current) {
            const previous = current;
            decorate(raster);
            container.replaceChildren(raster.image);
            current = raster;
            if (previous) discard(previous);
          }
          if (pending === raster) pending = undefined;
          latest.current.onLoad(raster.image);
          if (replacing) announceLoad(raster);
          refresh();
        };
        // Native <img> loading keeps cross-origin endpoints working without
        // introducing a fetch/CORS requirement. Decode is the swap barrier.
        if (typeof raster.image.decode === "function") {
          void raster.image.decode().then(commit, () => {
            if (raster.request === request) fail(raster, true, true);
          });
        } else {
          commit();
        }
      };
    };
    const create = () => {
      const image = new Image();
      const raster: Raster = { image, source: latest.current.source, request: 0, width: latest.current.width, ready: false };
      image.decoding = "async";
      image.loading = current?.ready ? "eager" : latest.current.loading;
      decorate(raster);
      listen(raster);
      return raster;
    };
    const refresh = () => {
      if (!valid()) return;
      if (current) decorate(current);
      if (pending) decorate(pending);
      const { width, src, source } = latest.current;
      if (pending && pending.source !== source) {
        discard(pending);
        pending = undefined;
      }
      if (current && current.source === source && current.width >= width) return;
      if (pending && pending.source === source && pending.width >= width) return;
      if (failedSource === source && failedWidth === width) return;
      if (current && !current.ready) {
        // The initial node remains a native lazy image, even after resizing;
        // no detached eager request is started for an unvisited page.
        current.width = width;
        current.source = source;
        current.request++;
        current.image.src = src;
        return;
      }
      if (!nearViewport) return;
      if (pending) discard(pending);
      pending = create();
      pending.image.src = src;
    };
    if (current) {
      decorate(current);
      listen(current);
      container.replaceChildren(current.image);
      latest.current.onLoad(current.image);
      announceLoad(current);
    } else {
      current = create();
      container.replaceChildren(current.image);
      current.image.src = latest.current.src;
    }
    update.current = refresh;
    // The display:contents span has no intersection box. Observe its stable
    // page wrapper instead, relative to the actual scrolling reading viewport.
    const target = container.closest(".cv-elements__page") ?? container.parentElement;
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (!valid()) return;
      nearViewport = entries.some((entry) => entry.isIntersecting);
      if (nearViewport) refresh();
    }, { root: container.closest(".cv-pages__main"), rootMargin: "400px 0px" });
    if (target) observer?.observe(target);
    else nearViewport = true;
    refresh();
    const invalidate = (source?: string) => {
      if (!active || (source !== undefined &&
        source !== JSON.stringify([scope, latest.current.source]) &&
        (!current || source !== JSON.stringify([scope, current.source])) &&
        (!pending || source !== JSON.stringify([scope, pending.source])))) return;
      active = false;
      observer?.disconnect();
      const previous = current;
      const candidate = pending;
      pending = undefined;
      current = undefined;
      const failedImage = previous ?? candidate;
      if (source !== undefined && failedImage) {
        failedImage.image.onload = null;
        failedImage.image.onerror = null;
        container.replaceChildren(failedImage.image);
        failedImage.image.dispatchEvent(new Event("error"));
      }
      if (candidate) discard(candidate);
      if (previous) discard(previous);
      if (!disposed) latest.current.onError();
    };
    cache.listeners.add(invalidate);
    return () => {
      active = false;
      disposed = true;
      update.current = null;
      observer?.disconnect();
      cache.listeners.delete(invalidate);
      if (pending) discard(pending);
      if (current) {
        // Only a normal same-source tab unmount returns a decoded node. A
        // semantic change or unresolved renewal cannot seed another session.
        if (scope === latest.current.scope && current.source === latest.current.source) {
          release(cache, JSON.stringify([scope, current.source]), current, generation);
        } else discard(current);
      }
    };
  }, [store, props.scope]);

  useLayoutEffect(() => { update.current?.(); });
  return <span ref={host} style={{ display: "contents" }} />;
}
