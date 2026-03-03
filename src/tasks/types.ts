// ── Task Queue Types ────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type TaskSource = 'chat' | 'webhook' | 'schedule' | 'system';

export type TaskTier = 'local' | 'cheap' | 'capable' | 'max';

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  tier: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  error: string | null;
  source: string;
  sessionId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CreateTaskOpts {
  title: string;
  description?: string;
  priority?: number;
  tier?: TaskTier;
  source?: TaskSource;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}
