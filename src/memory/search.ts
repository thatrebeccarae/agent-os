import type { AgentStore, MemorySearchResult } from './store.js';

/**
 * Search agent memory using FTS5 full-text search.
 * Returns formatted results suitable for injecting into a prompt context block.
 *
 * Future: layer in vector similarity search alongside FTS5.
 */
export function searchMemory(
  store: AgentStore,
  query: string,
  limit: number = 5
): string {
  const results: MemorySearchResult[] = store.searchMemory(query, limit);

  if (results.length === 0) {
    return '[No relevant memories found]';
  }

  const lines = results.map((r, i) => {
    // FTS5 rank is negative (closer to 0 = more relevant)
    const relevance = Math.abs(r.rank) < 1 ? 'high' : Math.abs(r.rank) < 5 ? 'medium' : 'low';
    return `${i + 1}. [${relevance}] ${r.fact}`;
  });

  return `Relevant memories (${results.length} results):\n${lines.join('\n')}`;
}
