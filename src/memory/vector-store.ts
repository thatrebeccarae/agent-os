/**
 * Vector storage and similarity search using the existing SQLite database.
 * Embeddings are stored as BLOBs in the memory_facts.embedding column.
 * Cosine similarity computed in JS — fine for <10K facts.
 */

import type { AgentStore, MemoryFact } from './store.js';

// ── Types ──────────────────────────────────────────────────────────

export interface ScoredFact {
  factId: number;
  fact: string;
  score: number;
  createdAt: number;
}

interface VectorSearchOptions {
  minSimilarity?: number;  // default: 0.3
  decayHalfLifeDays?: number;  // default: 30
}

// ── Serialization ──────────────────────────────────────────────────

function serializeEmbedding(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

function deserializeEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ── Storage ────────────────────────────────────────────────────────

/**
 * Store an embedding vector for a fact. Overwrites if one already exists.
 */
export function storeEmbedding(
  store: AgentStore,
  factId: number,
  embedding: number[],
): void {
  const blob = serializeEmbedding(embedding);
  store.db
    .prepare('UPDATE memory_facts SET embedding = ? WHERE id = ?')
    .run(blob, factId);
}

/**
 * Check if a fact already has an embedding stored.
 */
export function hasEmbedding(store: AgentStore, factId: number): boolean {
  const row = store.db
    .prepare('SELECT embedding IS NOT NULL as has FROM memory_facts WHERE id = ?')
    .get(factId) as { has: number } | undefined;
  return row?.has === 1;
}

// ── Search ─────────────────────────────────────────────────────────

/**
 * Find facts semantically similar to the query embedding.
 * Applies temporal decay so recent memories score higher.
 */
export function searchSimilar(
  store: AgentStore,
  queryEmbedding: number[],
  limit: number = 5,
  options: VectorSearchOptions = {},
): ScoredFact[] {
  const { minSimilarity = 0.3, decayHalfLifeDays = 30 } = options;
  const now = Date.now();

  // Load all facts that have embeddings
  const rows = store.db
    .prepare('SELECT id, fact, created_at, embedding FROM memory_facts WHERE embedding IS NOT NULL')
    .all() as MemoryFact[];

  if (rows.length === 0) return [];

  const queryVec = new Float32Array(queryEmbedding);

  const scored: ScoredFact[] = [];

  for (const row of rows) {
    if (!row.embedding) continue;

    const factVec = deserializeEmbedding(row.embedding);
    const similarity = cosineSimilarity(queryVec, factVec);

    if (similarity < minSimilarity) continue;

    // Temporal decay: score *= 0.5 ^ (ageDays / halfLife)
    const ageDays = (now - row.created_at) / (1000 * 60 * 60 * 24);
    const decay = Math.pow(0.5, ageDays / decayHalfLifeDays);
    const finalScore = similarity * decay;

    scored.push({
      factId: row.id,
      fact: row.fact,
      score: finalScore,
      createdAt: row.created_at,
    });
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── Math ───────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors. Returns value in [-1, 1].
 * Assumes vectors are the same length.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ── Utilities ──────────────────────────────────────────────────────

/**
 * Get IDs of facts that don't have embeddings yet.
 * Used by the migration script.
 */
export function getUnembeddedFactIds(store: AgentStore): number[] {
  const rows = store.db
    .prepare('SELECT id FROM memory_facts WHERE embedding IS NULL ORDER BY id')
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * Get fact content by IDs (for batch embedding).
 */
export function getFactsByIds(store: AgentStore, ids: number[]): { id: number; fact: string }[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return store.db
    .prepare(`SELECT id, fact FROM memory_facts WHERE id IN (${placeholders})`)
    .all(...ids) as { id: number; fact: string }[];
}
