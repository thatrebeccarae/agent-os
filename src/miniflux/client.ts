/**
 * Miniflux REST API client.
 *
 * Auth via X-Auth-Token header. Uses built-in fetch (Node 22+).
 * Docs: https://miniflux.app/docs/api.html
 */

const TIMEOUT_MS = 10_000;

function getBaseUrl(): string {
  return (process.env.MINIFLUX_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
}

function getApiKey(): string {
  const key = process.env.MINIFLUX_API_KEY;
  if (!key) throw new Error('MINIFLUX_API_KEY not set');
  return key;
}

export function isMinifluxConfigured(): boolean {
  return !!process.env.MINIFLUX_API_KEY;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'X-Auth-Token': getApiKey(),
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Miniflux API ${res.status}: ${res.statusText} — ${body}`);
    }

    // Some endpoints return 204 No Content
    if (res.status === 204) return undefined as T;

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface MinifluxFeed {
  id: number;
  title: string;
  site_url: string;
  feed_url: string;
  category: { id: number; title: string };
  parsing_error_count: number;
}

export interface MinifluxEntry {
  id: number;
  title: string;
  url: string;
  author: string;
  published_at: string;
  status: string;
  feed: { id: number; title: string };
  content: string;
}

export interface MinifluxCategory {
  id: number;
  title: string;
}

interface EntriesResponse {
  total: number;
  entries: MinifluxEntry[];
}

interface FeedCounters {
  reads: Record<string, number>;
  unreads: Record<string, number>;
}

// ── Public API ──────────────────────────────────────────────────────

export async function searchEntries(query: string, limit = 10): Promise<MinifluxEntry[]> {
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
    order: 'published_at',
    direction: 'desc',
  });
  const data = await api<EntriesResponse>(`/v1/entries?${params}`);
  return data.entries;
}

export async function listFeeds(): Promise<Array<MinifluxFeed & { unread_count: number }>> {
  const [feeds, counters] = await Promise.all([
    api<MinifluxFeed[]>('/v1/feeds'),
    api<FeedCounters>('/v1/feeds/counters'),
  ]);

  return feeds.map((f) => ({
    ...f,
    unread_count: counters.unreads[String(f.id)] ?? 0,
  }));
}

export async function getCategories(): Promise<MinifluxCategory[]> {
  return api<MinifluxCategory[]>('/v1/categories');
}

export async function getUnreadEntries(
  limit = 20,
  categoryId?: number,
): Promise<MinifluxEntry[]> {
  const params = new URLSearchParams({
    status: 'unread',
    limit: String(limit),
    order: 'published_at',
    direction: 'desc',
  });
  if (categoryId !== undefined) {
    params.set('category_id', String(categoryId));
  }
  const data = await api<EntriesResponse>(`/v1/entries?${params}`);
  return data.entries;
}

export async function markEntriesRead(entryIds: number[]): Promise<void> {
  await api<void>('/v1/entries', {
    method: 'PUT',
    body: JSON.stringify({ entry_ids: entryIds, status: 'read' }),
  });
}
