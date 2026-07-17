/**
 * Facade for the canvas store. The store lives in `../store` (a factory +
 * `<CanvasProvider>` context); this module re-exports it so `useCanvasStore` is
 * importable from one obvious place.
 */

export { CanvasProvider, useCanvasStore, useCanvasStoreApi } from "../store/context";
export type { CanvasProviderProps } from "../store/context";
export { createCanvasStore } from "../store/store";
export type { CanvasStore, ChatMessage, IframeCommand } from "../store/store";
