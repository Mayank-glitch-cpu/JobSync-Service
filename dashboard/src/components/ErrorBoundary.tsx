import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere below it and shows a readable message
 * instead of a blank white screen (the symptom the deployed /agents route hit).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it in the console for debugging; the UI already shows a message.
    console.error("Dashboard render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="center">
          <div className="card" style={{ maxWidth: 520, textAlign: "left" }}>
            <h3>Something went wrong</h3>
            <p className="muted small">{this.state.error.message}</p>
            <button onClick={() => (window.location.href = "/")}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
