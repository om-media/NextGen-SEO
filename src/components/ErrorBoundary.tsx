import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

const CHUNK_RELOAD_KEY = 'nextgen-seo:last-chunk-reload';
const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

function isChunkLoadError(error: Error) {
  const message = `${error.name || ''} ${error.message || ''}`;
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    message.includes('ChunkLoadError') ||
    message.includes('Loading chunk')
  );
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    if (isChunkLoadError(error) && typeof window !== 'undefined') {
      const lastReloadAt = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0);
      if (!lastReloadAt || Date.now() - lastReloadAt > CHUNK_RELOAD_COOLDOWN_MS) {
        window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
        window.location.reload();
      }
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  }

  public render() {
    if (this.state.hasError) {
      let errorMessage = "An unexpected error occurred.";
      let isQuotaError = false;

      if (this.state.error) {
        try {
          const parsed = JSON.parse(this.state.error.message);
          if (parsed.error && typeof parsed.error === 'string') {
            errorMessage = parsed.error;
            if (errorMessage.includes('resource-exhausted') || errorMessage.includes('Quota limit exceeded')) {
              isQuotaError = true;
        errorMessage = "The free database quota limit has been exceeded. Please try again later or upgrade the backing datastore for this workspace.";
            }
          }
        } catch (e) {
          errorMessage = this.state.error.message;
          if (errorMessage.includes('resource-exhausted') || errorMessage.includes('Quota limit exceeded')) {
            isQuotaError = true;
        errorMessage = "The free database quota limit has been exceeded. Please try again later or upgrade the backing datastore for this workspace.";
          }
        }
      }

      return (
        <div className="flex h-screen w-full items-center justify-center bg-background p-4">
          <div className="max-w-md w-full p-6 border border-destructive/50 bg-destructive/10 rounded-lg flex flex-col items-center text-center space-y-4">
            <AlertCircle className="h-12 w-12 text-destructive" />
            <h2 className="text-xl font-bold text-destructive">
              {isQuotaError ? "Database Quota Exceeded" : "Something went wrong"}
            </h2>
            <p className="text-sm text-foreground">
              {errorMessage}
            </p>
            <Button onClick={this.handleReset} className="mt-4" variant="outline">
              <RefreshCw className="mr-2 h-4 w-4" />
              Reload Application
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
