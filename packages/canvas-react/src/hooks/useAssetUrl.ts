/**
 * Display-time resolver for canvas-asset references.
 *
 * Returns a function that maps a `src` to a displayable URL: a canvas-relative
 * reference (`assets/…`, `sources/…`) resolves against the host's asset
 * endpoint; anything else — and every reference when no endpoint is configured
 * — passes through untouched. Resolution is display-only: stored artifact data
 * always keeps the relative reference.
 */

import { useCallback } from "react";

import { isAssetReference, resolveAssetUrl } from "../io/canvasAssets";
import { useCanvasStore } from "./useCanvasStore";

export function useAssetUrl(): (src: string | undefined) => string | undefined {
  const assetBaseUrl = useCanvasStore((s) => s.assetBaseUrl);
  return useCallback(
    (src) => (src && assetBaseUrl && isAssetReference(src) ? resolveAssetUrl(src, assetBaseUrl) : src),
    [assetBaseUrl],
  );
}
