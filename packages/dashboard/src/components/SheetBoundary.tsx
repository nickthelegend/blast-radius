import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one broken sheet from taking the whole survey with it.
 *
 * React unmounts the entire tree when a render throws, so without this a single
 * unexpected shape in one panel's data blanks the page — no navigation, no other
 * sheets, nothing to read. On a tool someone is using during an incident, losing
 * the six working views because the seventh hit a null is the wrong trade.
 *
 * The fallback states what failed and leaves the rest of the app navigable, and
 * `reset` re-mounts just this sheet rather than reloading the page, so nothing
 * else in flight is thrown away.
 */
interface Props {
  /** Named in the fallback, so the reader knows which sheet died. */
  sheet: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SheetBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Left in deliberately: this is the one place a stack trace is worth more
    // than a tidy console, and it is what a bug report needs to be actionable.
    console.error(`[blast-radius] the ${this.props.sheet} sheet failed to render`, error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="panel">
        <h2>{this.props.sheet} — could not be drawn</h2>
        <p className="sub">
          This sheet hit an error while rendering. Every other sheet is unaffected and still
          navigable; the details are in the browser console.
        </p>
        <div className="error mono">{error.message}</div>
        <button
          className="action"
          style={{ marginTop: 14 }}
          onClick={() => this.setState({ error: null })}
        >
          draw it again
        </button>
      </div>
    );
  }
}
