#!/usr/bin/env tsx
/**
 * One-time migration: embed all existing memory facts that don't have embeddings.
 * Idempotent — safe to run multiple times.
 *
 * Usage: npx tsx src/memory/migrate-embeddings.ts
 */

import 'dotenv/config';
import { AgentStore } from './store.js';
import { embedBatch } from './embeddings.js';
import { storeEmbedding, getUnembeddedFactIds, getFactsByIds } from './vector-store.js';

const BATCH_SIZE = 10;

async function main(): Promise<void> {
  const store = new AgentStore();

  const unembeddedIds = getUnembeddedFactIds(store);
  console.log(`[migrate] Found ${unembeddedIds.length} facts without embeddings`);

  if (unembeddedIds.length === 0) {
    console.log('[migrate] Nothing to do');
    store.close();
    return;
  }

  let embedded = 0;
  let skipped = 0;

  for (let i = 0; i < unembeddedIds.length; i += BATCH_SIZE) {
    const batchIds = unembeddedIds.slice(i, i + BATCH_SIZE);
    const facts = getFactsByIds(store, batchIds);

    const texts = facts.map((f) => f.fact);
    const embeddings = await embedBatch(texts);

    for (let j = 0; j < facts.length; j++) {
      const vec = embeddings[j];
      if (vec) {
        storeEmbedding(store, facts[j].id, vec);
        embedded++;
      } else {
        skipped++;
      }
    }

    console.log(`[migrate] Progress: ${Math.min(i + BATCH_SIZE, unembeddedIds.length)}/${unembeddedIds.length} (${embedded} embedded, ${skipped} skipped)`);
  }

  console.log(`[migrate] Done: ${embedded} embedded, ${skipped} skipped`);
  store.close();
}

main().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
