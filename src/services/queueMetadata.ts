export type QueueMetadata = {
  autoRefreshMs: number;
  estimatedCompletionAt: string | null;
  estimatedCompletionInSeconds: number | null;
  estimatedDurationSeconds: number | null;
  estimatedStartInSeconds: number | null;
  message: string;
  position: number | null;
  queuedAhead: number;
  recentCompletedCount: number;
  runningAhead: number;
  workloadState: 'idle' | 'normal' | 'busy' | 'backlogged';
  workspaceActive: number;
  workspaceQueued: number;
  workspaceRunning: number;
};
