/**
 * Morning RSS digest — fetches unread entries from Miniflux, groups by
 * category, summarizes via cheap LLM, and sends to operator via Telegram.
 *
 * Registered as a scheduled task (daily at 6:30 AM) or can be triggered
 * manually via the task queue.
 */

import { isMinifluxConfigured, getUnreadEntries, getCategories, markEntriesRead } from './client.js';
import type { MinifluxEntry, MinifluxCategory } from './client.js';
import type { LLMRouter } from '../llm/router.js';
import type { LLMMessage } from '../llm/types.js';
import { wrapAndDetect } from '../security/content-boundary.js';

const MAX_ENTRIES = 100;
const MAX_CONTENT_PER_ENTRY = 500;

interface DigestOptions {
  router: LLMRouter;
  sendDigest: (message: string) => Promise<void>;
  markRead?: boolean;
}

/**
 * Generate and send the morning RSS digest.
 * Returns the digest text, or null if there's nothing to report.
 */
export async function generateMorningDigest(opts: DigestOptions): Promise<string | null> {
  if (!isMinifluxConfigured()) {
    console.log('[digest] Miniflux not configured — skipping');
    return null;
  }

  const entries = await getUnreadEntries(MAX_ENTRIES);
  if (entries.length === 0) {
    console.log('[digest] No unread entries');
    return null;
  }

  // Fetch categories for grouping
  const categories = await getCategories();
  const categoryMap = new Map<number, string>();
  for (const cat of categories) {
    categoryMap.set(cat.id, cat.title);
  }

  // Group entries by category
  const grouped = new Map<string, MinifluxEntry[]>();
  for (const entry of entries) {
    // entry.feed has category info via the feed, but we need the feed's category
    // The entries endpoint doesn't always include nested category — use feed title as fallback
    const catName = entry.feed?.title ?? 'Uncategorized';
    const existing = grouped.get(catName);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(catName, [entry]);
    }
  }

  // Build a summary prompt
  const sections: string[] = [];
  for (const [category, catEntries] of grouped) {
    const items = catEntries.map((e) => {
      const rawSnippet = e.content
        ? e.content.replace(/<[^>]+>/g, '').slice(0, MAX_CONTENT_PER_ENTRY)
        : '';
      const snippet = rawSnippet ? wrapAndDetect(rawSnippet, `rss:${e.feed.title}`) : '';
      return `- ${e.title} (${e.feed.title})\n  ${e.url}\n  ${snippet}`;
    });
    sections.push(`## ${category}\n${items.join('\n')}`);
  }

  const prompt = [
    'Summarize this RSS feed digest for a busy executive. Group by category.',
    'For each category, list the most important/interesting items (skip noise).',
    'Use concise bullet points. Highlight anything that seems actionable or time-sensitive.',
    'Keep the total summary under 2000 characters.',
    '',
    ...sections,
  ].join('\n');

  const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
  const systemPrompt =
    'You are a concise news digest assistant. Summarize RSS feed entries into a ' +
    'brief, scannable morning briefing. No fluff. Lead with what matters.';

  try {
    const response = await opts.router.call(messages, systemPrompt, undefined, { tier: 'cheap' });
    const text =
      response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('\n') || 'No summary generated.';

    const digest = `Morning RSS Digest (${entries.length} articles)\n\n${text}`;

    await opts.sendDigest(digest);

    // Optionally mark entries as read after digest
    if (opts.markRead) {
      const ids = entries.map((e) => e.id);
      await markEntriesRead(ids);
      console.log(`[digest] Marked ${ids.length} entries as read`);
    }

    console.log(`[digest] Sent digest with ${entries.length} entries`);
    return digest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[digest] LLM summary failed: ${msg}`);

    // Fallback: send raw list without summary
    const fallback = `Morning RSS Digest (${entries.length} unread articles)\n\n` +
      Array.from(grouped.entries())
        .map(([cat, items]) => `${cat}: ${items.length} article(s)`)
        .join('\n');

    await opts.sendDigest(fallback);
    return fallback;
  }
}

/**
 * Calculate milliseconds until next occurrence of a given hour:minute.
 */
export function msUntilTime(hour: number, minute: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);

  // If the target time already passed today, schedule for tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

/**
 * Schedule the morning digest to run daily at a given time.
 * Returns a cleanup function to cancel the schedule.
 */
export function scheduleMorningDigest(opts: DigestOptions & { hour?: number; minute?: number }): () => void {
  const hour = opts.hour ?? 6;
  const minute = opts.minute ?? 30;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const run = async () => {
    try {
      await generateMorningDigest(opts);
    } catch (err) {
      console.error('[digest] Morning digest failed:', err instanceof Error ? err.message : err);
    }
  };

  // Schedule first run at the target time, then repeat every 24h
  const delay = msUntilTime(hour, minute);
  console.log(`[digest] Scheduled for ${hour}:${String(minute).padStart(2, '0')} (in ${Math.round(delay / 60_000)} min)`);

  timeoutHandle = setTimeout(() => {
    if (stopped) return;
    void run();
    intervalHandle = setInterval(() => {
      if (stopped) return;
      void run();
    }, 24 * 60 * 60 * 1000);
  }, delay);

  return () => {
    stopped = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (intervalHandle) clearInterval(intervalHandle);
  };
}
