/**
 * n8n REST API client.
 *
 * Auth via X-N8N-API-KEY header. Uses built-in fetch (Node 22+).
 */

const TIMEOUT_MS = 15_000;

function getBaseUrl(): string {
  return (process.env.N8N_URL ?? 'http://localhost:5678').replace(/\/+$/, '');
}

function getApiKey(): string {
  const key = process.env.N8N_API_KEY;
  if (!key) throw new Error('N8N_API_KEY not set');
  return key;
}

export function isN8nConfigured(): boolean {
  return !!process.env.N8N_API_KEY;
}

function validateId(id: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ${label}: ${id}`);
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'X-N8N-API-KEY': getApiKey(),
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`n8n API ${res.status}: ${res.statusText} — ${body}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: Array<{ id: string; name: string }>;
}

export interface N8nExecution {
  id: string;
  finished: boolean;
  mode: string;
  startedAt: string;
  stoppedAt: string | null;
  status: string;
  workflowId: string;
  data?: {
    resultData?: {
      error?: { message: string };
    };
  };
}

interface WorkflowListResponse {
  data: N8nWorkflow[];
  nextCursor: string | null;
}

// ── Public API ──────────────────────────────────────────────────────

export async function listWorkflows(): Promise<N8nWorkflow[]> {
  const result = await api<WorkflowListResponse>('/api/v1/workflows?limit=100');
  return result.data;
}

export async function activateWorkflow(workflowId: string): Promise<N8nWorkflow> {
  validateId(workflowId, 'workflow ID');
  return api<N8nWorkflow>(`/api/v1/workflows/${workflowId}/activate`, {
    method: 'POST',
  });
}

export async function deactivateWorkflow(workflowId: string): Promise<N8nWorkflow> {
  validateId(workflowId, 'workflow ID');
  return api<N8nWorkflow>(`/api/v1/workflows/${workflowId}/deactivate`, {
    method: 'POST',
  });
}

export async function triggerWebhook(
  workflowId: string,
  data?: Record<string, unknown>,
): Promise<unknown> {
  validateId(workflowId, 'workflow ID');
  // n8n production webhook URL format
  const url = `${getBaseUrl()}/webhook/${workflowId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data ?? {}),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Webhook ${res.status}: ${res.statusText} — ${body}`);
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function getExecution(executionId: string): Promise<N8nExecution> {
  validateId(executionId, 'execution ID');
  return api<N8nExecution>(`/api/v1/executions/${executionId}`);
}
