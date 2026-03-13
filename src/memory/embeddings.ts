/**
 * Ollama embedding client.
 * Converts text into vector embeddings for semantic memory search.
 * Gracefully degrades if Ollama is unavailable — returns null, FTS5 still works.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';

let _available: boolean | null = null;
let _lastCheck = 0;
const RECHECK_INTERVAL_MS = 60_000; // re-probe availability every 60s after failure

/**
 * Generate an embedding vector for a single text string.
 * Returns null if Ollama is unavailable or the request fails.
 */
export async function embed(text: string): Promise<number[] | null> {
  if (!await isAvailable()) return null;

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`[embeddings] Ollama returned ${res.status}: ${res.statusText}`);
      return null;
    }

    const data = await res.json() as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? null;
  } catch (err) {
    console.warn(`[embeddings] Embed failed: ${(err as Error).message}`);
    _available = false;
    _lastCheck = Date.now();
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in a single request.
 * Returns an array of the same length as input — null for any that failed.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  if (!await isAvailable()) return texts.map(() => null);

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      console.warn(`[embeddings] Ollama batch returned ${res.status}`);
      return texts.map(() => null);
    }

    const data = await res.json() as { embeddings?: number[][] };
    if (!data.embeddings) return texts.map(() => null);

    // Pad with nulls if Ollama returned fewer embeddings than inputs
    return texts.map((_, i) => data.embeddings![i] ?? null);
  } catch (err) {
    console.warn(`[embeddings] Batch embed failed: ${(err as Error).message}`);
    _available = false;
    _lastCheck = Date.now();
    return texts.map(() => null);
  }
}

/**
 * Check if Ollama is reachable. Caches result and re-probes periodically.
 */
async function isAvailable(): Promise<boolean> {
  if (_available !== null && (Date.now() - _lastCheck) < RECHECK_INTERVAL_MS) {
    return _available;
  }

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    _available = res.ok;
  } catch {
    _available = false;
  }

  _lastCheck = Date.now();

  if (!_available) {
    console.warn('[embeddings] Ollama unavailable — vector search disabled, using FTS5 only');
  }

  return _available;
}
