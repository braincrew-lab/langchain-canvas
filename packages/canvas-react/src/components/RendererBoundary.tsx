/**
 * An error boundary around a single artifact's renderer.
 *
 * The canvas is meant to be embedded inside someone else's chat UI, so a
 * malformed artifact (bad chart data, an unexpected slide shape, a throwing
 * third-party viewer) must never take down the whole app. This isolates each
 * renderer: if it throws while rendering, we show a small inline fallback
 * instead of unmounting the canvas, and recover automatically when the
 * artifact changes (keyed by `resetKey`).
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Changing this (e.g. the artifact id/version) clears a previous error. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RendererBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // A new artifact/version — give the renderer a fresh chance.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it for debugging without crashing the host app.
    // eslint-disable-next-line no-console
    console.error("[langchain-canvas] renderer error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="cv-renderer-error" role="alert">
          <p className="cv-renderer-error__title">This artifact couldn’t be displayed</p>
          <p className="cv-renderer-error__detail">{this.state.error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}
