/** Continuous, lazy-loaded document pages with a synchronized thumbnail rail. */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useViewerSession } from "../../hooks/viewerSession";
import { useCanvasStoreApi, type CanvasStore } from "../../hooks/useCanvasStore";
import type { StoreApi } from "zustand/vanilla";
import { resolveCanvasPageUrl } from "../../io/canvasAssets";
import { useLabels } from "../chrome";
import { MAX_PAGE_ZOOM, MIN_PAGE_ZOOM, PAGE_BASELINE_WIDTH, pageDisplayWidth, parsePageDestination, readingScrollPosition, type PageZoom, type ReadingAnchor } from "./pageReading";
import { sameElementReference, useElementSelection, usePageElements } from "../../hooks/elementSelection";
import type { CanvasElementReference } from "../../protocol/elements";
import { PageRaster } from "./PageRaster";

const THUMB_WIDTH = 480;
const MAX_PAGE_WIDTH = 2400;
const RASTER_SCALE = 1.2;
const viewerStoreIds = new WeakMap<StoreApi<CanvasStore>, number>();
let nextViewerStoreId = 0;

interface PageReadingSession {
  page: number;
  zoom: PageZoom;
  thumbnails: boolean | null;
  scrollTop: number;
  scrollLeft: number;
  anchor: ReadingAnchor | null;
  aspectRatios: Record<number, number>;
}

export interface PageViewerProps {
  path: string;
  name: string;
  pageCount: number;
  pageBaseUrl: string;
  version?: number | string;
  /** Authoritative source revision; a display version alone cannot identify an edit target. */
  revision?: string;
}

/** Only the host's renewable ticket is transport state; every other URL field scopes the document. */
function pageSourceIdentity(pageBaseUrl: string): string {
  const fragmentStart = pageBaseUrl.indexOf("#");
  const source = fragmentStart < 0 ? pageBaseUrl : pageBaseUrl.slice(0, fragmentStart);
  const fragment = fragmentStart < 0 ? "" : pageBaseUrl.slice(fragmentStart);
  const queryStart = source.indexOf("?");
  if (queryStart < 0) return pageBaseUrl;
  const query = source.slice(queryStart + 1).split("&")
    .filter((parameter) => !new URLSearchParams(parameter).has("ticket")).join("&");
  return `${source.slice(0, queryStart)}${query ? `?${query}` : ""}${fragment}`;
}

export function PageViewer(props: PageViewerProps) {
  const store = useCanvasStoreApi();
  let storeId = viewerStoreIds.get(store);
  if (storeId === undefined) {
    storeId = ++nextViewerStoreId;
    viewerStoreIds.set(store, storeId);
  }
  const identity = JSON.stringify([props.path, props.version, props.revision, pageSourceIdentity(props.pageBaseUrl)]);
  return <PageSequence key={`${storeId}:${identity}`} {...props} identity={identity} />;
}

function PageSequence({ path, name, pageCount, pageBaseUrl, version, revision, identity }: PageViewerProps & { identity: string }) {
  const labels = useLabels();
  const selection = useElementSelection();
  const metadata = usePageElements(path, revision, pageCount);
  const elementsByPage = useMemo(() => {
    const pages = new Map<number, typeof metadata.elements>();
    for (const element of metadata.elements) {
      const list = pages.get(element.page!) ?? [];
      list.push(element);
      pages.set(element.page!, list);
    }
    // Small nested elements remain reachable above containing tables/shapes.
    for (const elements of pages.values()) elements.sort((a, b) =>
      b.bounds!.width * b.bounds!.height - a.bounds!.width * a.bounds!.height);
    return pages;
  }, [metadata.elements]);
  const isDeck = /\.(pptx?|odp)$/i.test(path) || /\.(pptx?|odp)$/i.test(name);
  const isWord = /\.docx?$/i.test(path) || /\.docx?$/i.test(name);
  const ticketQuery = pageBaseUrl.includes("?") ? pageBaseUrl.slice(pageBaseUrl.indexOf("?") + 1).split("#", 1)[0] : "";
  const hasPageTicket = Boolean(new URLSearchParams(ticketQuery).get("ticket"));
  const session = useViewerSession<PageReadingSession>(`pages:${path}`, identity, () => ({
    page: 1, zoom: isDeck ? "page" : "width", thumbnails: null, scrollTop: 0, scrollLeft: 0, anchor: null, aspectRatios: {},
  }));
  const [page, setPage] = useState(() => Math.max(1, Math.min(pageCount, session.current.page)));
  const [railPreference, setRailPreference] = useState(session.current.thumbnails);
  const [containerWidth, setContainerWidth] = useState(0);
  const showRail = railPreference ?? containerWidth >= 520;
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    setFailed((previous) => previous.size ? new Set() : previous);
  }, [pageBaseUrl]);
  const [zoom, setZoom] = useState<PageZoom>(session.current.zoom);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [pixelRatio, setPixelRatio] = useState(1);
  const [aspectRatios, setAspectRatios] = useState(session.current.aspectRatios);
  const [editingPage, setEditingPage] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const [invalidPage, setInvalidPage] = useState(false);
  const inputErrorId = useId();
  const pageNumbers = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const pagesRef = useRef<Array<HTMLElement | null>>([]);
  const currentPageRef = useRef(page);
  const anchorRef = useRef(session.current.anchor);
  const restoredRef = useRef(false);
  const resizingRef = useRef(false);
  const measuredSizeRef = useRef({ width: 0, height: 0 });
  const fallbackAspect = isDeck ? 16 / 9 : 3 / 4;
  const widthForPage = (n: number) => pageDisplayWidth(zoom, viewportSize.width || PAGE_BASELINE_WIDTH,
    viewportSize.height || PAGE_BASELINE_WIDTH / fallbackAspect, aspectRatios[n] ?? fallbackAspect);
  const currentZoom = widthForPage(page) / PAGE_BASELINE_WIDTH;

  const trackPage = useCallback((next: number) => {
    currentPageRef.current = next;
    session.current.page = next;
    setPage(next);
  }, [session]);

  const rememberPosition = useCallback((keepDocumentTop = true) => {
    const main = mainRef.current;
    if (!main) return;
    const center = main.scrollTop + main.clientHeight / 2;
    if (keepDocumentTop && main.scrollTop === 0 && main.scrollLeft === 0) {
      anchorRef.current = null;
      session.current.anchor = null;
      session.current.scrollTop = 0;
      session.current.scrollLeft = 0;
      return;
    }
    const low = Math.max(0, Math.min(pageCount - 1, currentPageRef.current - 1));
    const sheet = pagesRef.current[low];
    const image = sheet?.querySelector<HTMLImageElement>(".cv-pages__page");
    const height = image?.offsetHeight || sheet?.offsetHeight || 0;
    if (sheet && sheet.offsetWidth > 0 && height > 0) {
      anchorRef.current = {
        page: low + 1,
        x: (main.scrollLeft + main.clientWidth / 2 - sheet.offsetLeft) / sheet.offsetWidth,
        y: Math.max(0, Math.min(1, (center - sheet.offsetTop) / height)),
      };
      session.current.anchor = anchorRef.current;
    }
    session.current.scrollTop = main.scrollTop;
    session.current.scrollLeft = main.scrollLeft;
  }, [pageCount, session]);

  const goTo = useCallback((n: number) => {
    const next = Math.max(1, Math.min(n, pageCount));
    const main = mainRef.current;
    const target = pagesRef.current[next - 1];
    if (!main || !target) return;
    const inset = Number.parseFloat(getComputedStyle(main).paddingTop) || 24;
    main.scrollTo({ top: Math.max(0, target.offsetTop - inset), behavior: "auto" });
    trackPage(next);
    rememberPosition();
  }, [pageCount, rememberPosition, trackPage]);

  // Restore only after the new layout commits. Cached center coordinates describe
  // the old layout, including when ResizeObserver fires after the container shrank.
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main || viewportSize.width === 0) return;
    const anchor = anchorRef.current;
    const target = anchor && pagesRef.current[anchor.page - 1];
    if (anchor && target) {
      const image = target.querySelector<HTMLImageElement>(".cv-pages__page");
      const height = image?.offsetHeight || target.offsetHeight;
      if (target.offsetWidth > 0 && height > 0) {
        const position = readingScrollPosition(anchor, {
          left: target.offsetLeft, top: target.offsetTop, width: target.offsetWidth, height,
        }, { width: main.clientWidth, height: main.clientHeight });
        const inset = Number.parseFloat(getComputedStyle(main).paddingTop) || 24;
        main.scrollTop = height <= main.clientHeight - 2 * inset
          ? Math.max(0, target.offsetTop - inset)
          : position.top;
        main.scrollLeft = position.left;
      } else if (!restoredRef.current) {
        main.scrollTop = session.current.scrollTop;
        main.scrollLeft = session.current.scrollLeft;
      }
    } else if (!restoredRef.current) {
      main.scrollTop = session.current.scrollTop;
      main.scrollLeft = session.current.scrollLeft;
    } else if (resizingRef.current) {
      const selected = pagesRef.current[currentPageRef.current - 1];
      if (selected) main.scrollTop = Math.max(0, selected.offsetTop - (Number.parseFloat(getComputedStyle(main).paddingTop) || 24));
    }
    restoredRef.current = true;
    resizingRef.current = false;
    rememberPosition();
  }, [zoom, viewportSize, aspectRatios, showRail, rememberPosition, session]);

  useLayoutEffect(() => {
    const main = mainRef.current;
    const container = containerRef.current;
    if (!main || !container) return;
    let frame = 0;
    const measure = () => {
      const style = getComputedStyle(main);
      const width = Math.max(1, main.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0));
      const height = Math.max(1, main.clientHeight - (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0));
      resizingRef.current = measuredSizeRef.current.width !== main.clientWidth || measuredSizeRef.current.height !== main.clientHeight;
      measuredSizeRef.current = { width: main.clientWidth, height: main.clientHeight };
      setViewportSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
      setContainerWidth(container.clientWidth);
      setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
    };
    measure();
    const readScrolledPage = () => {
      if (main.clientWidth !== measuredSizeRef.current.width || main.clientHeight !== measuredSizeRef.current.height || resizingRef.current) return currentPageRef.current;
      if (main.scrollTop > 0 && main.scrollTop >= main.scrollHeight - main.clientHeight - 2) return pageCount;
      const line = main.scrollTop + (Number.parseFloat(getComputedStyle(main).paddingTop) || 24) + 1;
      let low = 0;
      let high = pageCount - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if ((pagesRef.current[mid]?.offsetTop ?? Infinity) <= line) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    };
    const update = () => {
      frame = 0;
      if (main.clientWidth !== measuredSizeRef.current.width || main.clientHeight !== measuredSizeRef.current.height || resizingRef.current) return;
      trackPage(readScrolledPage());
      rememberPosition();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    main.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    observer.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      // StrictMode can clean up the first measurement before saved state is restored.
      if (restoredRef.current) {
        if (frame || main.scrollTop !== session.current.scrollTop) {
          currentPageRef.current = readScrolledPage();
          session.current.page = currentPageRef.current;
        }
        // Flush pending scroll tracking without scheduling a React state update.
        rememberPosition();
        session.current.scrollTop = main.scrollTop;
        session.current.scrollLeft = main.scrollLeft;
      }
      cancelAnimationFrame(frame);
      main.removeEventListener("scroll", schedule);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pageCount, rememberPosition, session, trackPage]);

  useEffect(() => {
    const rail = railRef.current;
    const active = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rail || !active) return;
    if (active.offsetTop < rail.scrollTop) rail.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > rail.scrollTop + rail.clientHeight)
      rail.scrollTop = active.offsetTop + active.offsetHeight - rail.clientHeight;
  }, [page, showRail]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      (event.target as HTMLElement).closest(".cv-pages__toolbar, input, select, textarea, [contenteditable='true']")) return;
    const main = mainRef.current;
    if (event.target === main && main) {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) return;
      if (["ArrowLeft", "ArrowRight"].includes(event.key) && main.scrollWidth > main.clientWidth) return;
    }
    let next: number;
    switch (event.key) {
      case "ArrowRight": case "ArrowDown": case "PageDown": next = page + 1; break;
      case "ArrowLeft": case "ArrowUp": case "PageUp": next = page - 1; break;
      case "Home": next = 1; break;
      case "End": next = pageCount; break;
      default: return;
    }
    event.preventDefault();
    goTo(next);
  };

  const changeZoom = (next: PageZoom) => {
    rememberPosition(false);
    const value = typeof next === "number" ? Math.max(MIN_PAGE_ZOOM, Math.min(MAX_PAGE_ZOOM, Math.round(next * 100) / 100)) : next;
    session.current.zoom = value;
    setZoom(value);
  };
  const finishPageEdit = () => {
    setEditingPage(false);
    setInvalidPage(false);
    mainRef.current?.focus({ preventScroll: true });
  };

  return (
    <div ref={containerRef} className={`cv-pages${isDeck ? " cv-pages--slides" : ""}`} onKeyDown={onKeyDown}>
      <div className="cv-pages__toolbar">
        <button type="button" aria-label={labels.viewerThumbnails} aria-pressed={showRail}
          onClick={() => {
            rememberPosition();
            session.current.thumbnails = !showRail;
            setRailPreference(!showRail);
          }} title={labels.viewerThumbnails}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M3 10h6M3 15h6"/></svg>
        </button>
        <div className="cv-pages__zoom" role="group" aria-label={labels.viewerZoom}>
          <button type="button" aria-label={labels.viewerZoomOut} title={labels.viewerZoomOut} disabled={currentZoom <= MIN_PAGE_ZOOM} onClick={() => changeZoom(currentZoom - 0.1)}>−</button>
          <button type="button" className="cv-pages__percentage" aria-label={labels.viewerBaselineZoom} title={labels.viewerBaselineZoom} onClick={() => changeZoom(1)}>{Math.round(currentZoom * 100)}%</button>
          <button type="button" aria-label={labels.viewerZoomIn} title={labels.viewerZoomIn} disabled={currentZoom >= MAX_PAGE_ZOOM} onClick={() => changeZoom(currentZoom + 0.1)}>+</button>
          <button type="button" className="cv-pages__fit" aria-label={labels.viewerFitWidth} title={labels.viewerFitWidth} aria-pressed={zoom === "width"} onClick={() => changeZoom("width")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 4v16M21 4v16M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4" /></svg>
          </button>
          <button type="button" className="cv-pages__fit" aria-label={labels.viewerFitPage} title={labels.viewerFitPage} aria-pressed={zoom === "page"} onClick={() => changeZoom("page")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="1"/><path d="M3 8V3h3M18 3h3v5M21 16v5h-3M6 21H3v-5"/></svg>
          </button>
        </div>
        <div className="cv-pages__nav">
          <button type="button" disabled={page <= 1} onClick={() => goTo(page - 1)} aria-label={labels.viewerPreviousPage}>‹</button>
          {editingPage ? <input className="cv-pages__page-input" type="text" inputMode="numeric" autoFocus
            aria-label={labels.viewerPageInput} aria-invalid={invalidPage || undefined} aria-describedby={invalidPage ? inputErrorId : undefined}
            title={invalidPage ? labels.viewerInvalidPage : labels.viewerPageInput} value={pageDraft}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => { setPageDraft(event.target.value); setInvalidPage(false); }}
            onBlur={() => { setEditingPage(false); setInvalidPage(false); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); finishPageEdit(); }
              else if (event.key === "Enter") {
                event.preventDefault();
                const destination = parsePageDestination(pageDraft, pageCount);
                if (destination === null) setInvalidPage(true);
                else { goTo(destination); finishPageEdit(); }
              }
            }} /> : <button type="button" className="cv-pages__page-number" aria-live="polite" aria-atomic="true"
              title={labels.viewerPageInput} onClick={() => { setPageDraft(String(page)); setInvalidPage(false); setEditingPage(true); }}>
              {isWord ? labels.docxRenderedPage(page, pageCount) : labels.viewerPage(page, pageCount)}
            </button>}
          <span id={inputErrorId} className="cv-pages__input-error" role="status">{invalidPage ? labels.viewerInvalidPage : ""}</span>
          <button type="button" disabled={page >= pageCount} onClick={() => goTo(page + 1)} aria-label={labels.viewerNextPage}>›</button>
        </div>
      </div>
      {metadata.enabled && <div className="cv-elements__status" role={metadata.status === "error" ? "alert" : "status"}>
        {metadata.status === "loading" ? labels.elementLoading : metadata.status === "error" ? labels.elementLoadFailed :
          metadata.status === "unavailable" ? labels.elementUnavailable : metadata.unsupportedReason ||
          (metadata.elements.length ? labels.elementHint : labels.elementEmpty)}
        {metadata.incomplete && <span> {labels.elementIncomplete}</span>}
      </div>}
      <div className="cv-pages__workspace">
        {showRail && <nav ref={railRef} className="cv-pages__rail" aria-label={labels.viewerThumbnails}>
          {pageNumbers.map((n) => (
            <button key={n} type="button" aria-current={n === page ? "page" : undefined}
              aria-label={labels.viewerPage(n, pageCount)}
              className={`cv-pages__thumb${n === page ? " is-active" : ""}`} onClick={() => goTo(n)}>
              <span className="cv-pages__num">{n}</span>
              <span className="cv-pages__thumb-image"><img src={resolveCanvasPageUrl(path, n, THUMB_WIDTH, pageBaseUrl, version)} alt="" loading="lazy" decoding="async" /></span>
            </button>
          ))}
        </nav>}
        <div ref={mainRef} className="cv-pages__main" tabIndex={0} role="region" aria-label={labels.previewOf(name)}>
          {pageNumbers.map((n) => {
            const width = widthForPage(n);
            const rasterWidth = Math.round(Math.min(MAX_PAGE_WIDTH, Math.max(PAGE_BASELINE_WIDTH, Math.ceil(width * pixelRatio / 400) * 400)) * RASTER_SCALE);
            return <section key={n} ref={(node) => { pagesRef.current[n - 1] = node; }} className="cv-pages__sheet" aria-label={labels.viewerPage(n, pageCount)}
              style={{ width, maxWidth: "none" }}>
              <div className="cv-elements__page">
              {failed.has(n) ? <div className="cv-pages__error" role="status">
                <span>{labels.renderFailed}</span>
                <button type="button" onClick={() => setFailed((previous) => {
                  const next = new Set(previous);
                  next.delete(n);
                  return next;
                })}>{labels.viewerRetry}</button>
              </div> :
                <PageRaster scope={JSON.stringify([identity, n, hasPageTicket])}
                  source={JSON.stringify([path, version, revision, pageBaseUrl, n])}
                  src={resolveCanvasPageUrl(path, n, rasterWidth, pageBaseUrl, version)} width={rasterWidth} alt={`${name} ${n}`}
                  aspectRatio={aspectRatios[n]} loading={n === 1 ? "eager" : "lazy"}
                  onLoad={(image) => {
                    if (session.current.aspectRatios[n] !== undefined || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
                    const ratio = image.naturalWidth / image.naturalHeight;
                    if (!Number.isFinite(ratio) || ratio <= 0) return;
                    const next = { ...session.current.aspectRatios, [n]: ratio };
                    session.current.aspectRatios = next;
                    setAspectRatios(next);
                  }}
                  onError={() => setFailed((previous) => new Set(previous).add(n))} />}
              {metadata.enabled && !failed.has(n) && aspectRatios[n] && <div className="cv-elements__overlay">{(elementsByPage.get(n) ?? []).map((element) => {
                const bounds = element.bounds!;
                const reference: CanvasElementReference = { path, revision: revision!, element_id: element.id };
                const selected = selection.selectedElements?.some((item) => sameElementReference(item, reference)) ?? false;
                return <button key={JSON.stringify([element.id, element.page, bounds])} type="button"
                  className={`cv-elements__target${selected ? " is-selected" : ""}`}
                  style={{ left: `${bounds.x * 100}%`, top: `${bounds.y * 100}%`, width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%` }}
                  aria-label={selected ? labels.elementAdded(element.label) : labels.elementAdd(element.label)}
                  title={element.label} aria-pressed={selected} disabled={!selection.onAddElement}
                  onClick={() => selection.onAddElement?.({ ...reference }, { ...element, bounds: { ...bounds }, locator: { ...element.locator } })} />;
              })}</div>}
              </div>
            </section>;
          })}
        </div>
      </div>
    </div>
  );
}
