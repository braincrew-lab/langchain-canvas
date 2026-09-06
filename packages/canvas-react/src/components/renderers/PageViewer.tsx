/**
 * A paged file read one page at a time: a rail of numbered thumbnails and
 * the chosen page at reading size. Every image is fetched from the host's
 * page endpoint on demand (thumbnails lazily), so a long deck costs one
 * request per page looked at, not a wire full of base64.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { resolveCanvasPageUrl } from "../../io/canvasAssets";

const THUMB_WIDTH = 240;
const PAGE_WIDTH = 1600;

export interface PageViewerProps {
  path: string;
  name: string;
  pageCount: number;
  pageBaseUrl: string;
  version?: number | string;
}

export function PageViewer({ path, name, pageCount, pageBaseUrl, version }: PageViewerProps) {
  const [page, setPage] = useState(1);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // A different file, or new bytes of the same file, starts at page one.
  useEffect(() => {
    setPage(1);
  }, [path, version]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [page]);

  const clamp = (n: number) => Math.min(Math.max(n, 1), pageCount);
  const url = (n: number, width: number) => resolveCanvasPageUrl(path, n, width, pageBaseUrl, version);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown") {
      event.preventDefault();
      setPage((p) => clamp(p + 1));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") {
      event.preventDefault();
      setPage((p) => clamp(p - 1));
    }
  };

  return (
    <div className="cv-pages" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="cv-pages__rail" role="tablist" aria-label={name}>
        {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            ref={n === page ? activeRef : undefined}
            type="button"
            role="tab"
            aria-selected={n === page}
            className={"cv-pages__thumb" + (n === page ? " is-active" : "")}
            onClick={() => setPage(n)}
          >
            <img src={url(n, THUMB_WIDTH)} alt={`${name} ${n}`} loading="lazy" decoding="async" />
            <span className="cv-pages__num">{n}</span>
          </button>
        ))}
      </div>
      <div className="cv-pages__main">
        <img className="cv-pages__page" src={url(page, PAGE_WIDTH)} alt={`${name} ${page}`} />
        <div className="cv-pages__nav">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => clamp(p - 1))} aria-label="previous page">
            ‹
          </button>
          <span>
            {page} / {pageCount}
          </span>
          <button type="button" disabled={page >= pageCount} onClick={() => setPage((p) => clamp(p + 1))} aria-label="next page">
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
