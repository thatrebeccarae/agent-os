import type { AgentStore, MemorySearchResult } from './store.js';
import { embed } from './embeddings.js';
import { searchSimilar, type ScoredFact } from './vector-store.js';

/**
 * Search agent memory using FTS5 full-text search.
 * Returns formatted results suitable for injecting into a prompt context block.
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

/**
 * Hybrid search: combines FTS5 keyword search with vector similarity search.
 * Falls back to FTS5-only if Ollama embeddings are unavailable.
 *
 * Scoring: 0.4 * normalizedFtsScore + 0.6 * vectorScore
 * Vector results are weighted higher because semantic similarity catches
 * related concepts that keyword matching misses.
 */
export async function hybridSearch(
  store: AgentStore,
  query: string,
  limit: number = 5,
): Promise<string> {
  // Run FTS5 search (always available)
  let ftsResults: MemorySearchResult[] = [];
  try {
    ftsResults = store.searchMemory(query, limit * 2); // fetch extra for merge pool
  } catch {
    // FTS match syntax errors are non-fatal
  }

  // Run vector search (may return empty if Ollama unavailable)
  let vectorResults: ScoredFact[] = [];
  try {
    const queryEmbedding = await embed(query);
    if (queryEmbedding) {
      vectorResults = searchSimilar(store, queryEmbedding, limit * 2);
    }
  } catch {
    // Vector search failures are non-fatal
  }

  // If no vector results, fall back to FTS-only formatting
  if (vectorResults.length === 0) {
    if (ftsResults.length === 0) return '[No relevant memories found]';
    return formatFtsResults(ftsResults.slice(0, limit));
  }

  // If no FTS results, use vector-only
  if (ftsResults.length === 0) {
    return formatScoredResults(vectorResults.slice(0, limit));
  }

  // ── Merge and deduplicate ────────────────────────────────────────

  // Normalize FTS5 scores to 0-1 (rank is negative, closer to 0 = better)
  const maxFtsRank = Math.max(...ftsResults.map((r) => Math.abs(r.rank)), 1);
  const ftsScored = new Map<number, number>();
  for (const r of ftsResults) {
    // Invert so higher = better, then normalize
    ftsScored.set(r.id, 1 - Math.abs(r.rank) / (maxFtsRank + 1));
  }

  const vectorScored = new Map<number, number>();
  for (const r of vectorResults) {
    vectorScored.set(r.factId, r.score);
  }

  // Collect all unique fact IDs
  const allIds = new Set([...ftsScored.keys(), ...vectorScored.keys()]);

  // Build combined scores
  const combined: { factId: number; fact: string; score: number }[] = [];
  for (const id of allIds) {
    const ftsScore = ftsScored.get(id) ?? 0;
    const vecScore = vectorScored.get(id) ?? 0;
    const score = 0.4 * ftsScore + 0.6 * vecScore;

    // Find the fact text from whichever result set has it
    const ftsMatch = ftsResults.find((r) => r.id === id);
    const vecMatch = vectorResults.find((r) => r.factId === id);
    const fact = ftsMatch?.fact ?? vecMatch?.fact ?? '';

    combined.push({ factId: id, fact, score });
  }

  // Sort by combined score descending
  combined.sort((a, b) => b.score - a.score);
  const top = combined.slice(0, limit);

  if (top.length === 0) return '[No relevant memories found]';

  const lines = top.map((r, i) => {
    const relevance = r.score > 0.6 ? 'high' : r.score > 0.3 ? 'medium' : 'low';
    return `${i + 1}. [${relevance}] ${r.fact}`;
  });

  return `Relevant memories (${top.length} results, hybrid search):\n${lines.join('\n')}`;
}

// ── Formatters ─────────────────────────────────────────────────────

function formatFtsResults(results: MemorySearchResult[]): string {
  const lines = results.map((r, i) => {
    const relevance = Math.abs(r.rank) < 1 ? 'high' : Math.abs(r.rank) < 5 ? 'medium' : 'low';
    return `${i + 1}. [${relevance}] ${r.fact}`;
  });
  return `Relevant memories (${results.length} results):\n${lines.join('\n')}`;
}

function formatScoredResults(results: ScoredFact[]): string {
  const lines = results.map((r, i) => {
    const relevance = r.score > 0.6 ? 'high' : r.score > 0.3 ? 'medium' : 'low';
    return `${i + 1}. [${relevance}] ${r.fact}`;
  });
  return `Relevant memories (${results.length} results, vector search):\n${lines.join('\n')}`;
}
