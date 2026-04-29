import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] uncaught render error", error, info);
  }

  private handleRefresh = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: 32,
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
            background: "#1a1a2e",
            color: "#e0e0e0",
          }}
        >
          <h1 style={{ fontSize: 24, marginBottom: 12 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 16, marginBottom: 24, maxWidth: 400 }}>
            The game hit an unexpected error. Refreshing usually fixes it.
          </p>
          <button
            onClick={this.handleRefresh}
            style={{
              padding: "12px 32px",
              fontSize: 16,
              fontWeight: 600,
              border: "none",
              borderRadius: 8,
              background: "#fbbf24",
              color: "#1a1a2e",
              cursor: "pointer",
            }}
          >
            Refresh Page
          </button>
          {this.state.error && (
            <pre
              style={{
                marginTop: 32,
                fontSize: 12,
                color: "#888",
                maxWidth: 600,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {this.state.error.message}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
