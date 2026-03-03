/**
 * Miniflux RSS tools for Agent.
 *
 * Gated behind MINIFLUX_API_KEY — returns empty array if not configured.
 */

import type { Tool } from '../agent/tools.js';
import {
  isMinifluxConfigured,
  searchEntries,
  listFeeds,
  getCategories,
  getUnreadEntries,
  markEntriesRead,
} from './client.js';

function formatEntry(e: { id: number; title: string; url: string; author: string; published_at: string; feed: { title: string } }): string {
  const date = new Date(e.published_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const author = e.author ? ` — ${e.author}` : '';
  return `[${e.id}] ${e.title}${author} (${e.feed.title}, ${date})\n  ${e.url}`;
}

export function getMinifluxTools(): Tool[] {
  if (!isMinifluxConfigured()) return [];

  return [
    {
      name: 'rss_search',
      description:
        'Search RSS feed entries by query string. Returns matching articles ' +
        'sorted by date (newest first).',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: {
            type: 'number',
            description: 'Max results (default 10)',
          },
        },
        required: ['query'],
      },
      handler: async (input) => {
        const query = input.query as string;
        const limit = (input.limit as number) ?? 10;
        if (!query.trim()) return 'Error: empty search query';

        const entries = await searchEntries(query, limit);
        if (entries.length === 0) return `No RSS entries found for "${query}".`;
        return `${entries.length} result(s) for "${query}":\n\n${entries.map(formatEntry).join('\n\n')}`;
      },
    },
    {
      name: 'rss_feeds',
      description:
        'List all subscribed RSS feeds with their ID, title, site URL, and unread count.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const feeds = await listFeeds();
        if (feeds.length === 0) return 'No feeds subscribed.';

        const totalUnread = feeds.reduce((sum, f) => sum + f.unread_count, 0);
        const lines = feeds.map(
          (f) =>
            `[${f.id}] ${f.title} — ${f.unread_count} unread\n  ${f.site_url}`,
        );
        return `${feeds.length} feed(s), ${totalUnread} total unread:\n\n${lines.join('\n\n')}`;
      },
    },
    {
      name: 'rss_recent',
      description:
        'Get recent unread RSS entries. Optionally filter by category name.',
      input_schema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max entries (default 20)',
          },
          category: {
            type: 'string',
            description: 'Filter by category name (optional)',
          },
        },
        required: [],
      },
      handler: async (input) => {
        const limit = (input.limit as number) ?? 20;
        const categoryName = input.category as string | undefined;

        let categoryId: number | undefined;
        if (categoryName) {
          const categories = await getCategories();
          const match = categories.find(
            (c) => c.title.toLowerCase() === categoryName.toLowerCase(),
          );
          if (!match) {
            const available = categories.map((c) => c.title).join(', ');
            return `Category "${categoryName}" not found. Available: ${available}`;
          }
          categoryId = match.id;
        }

        const entries = await getUnreadEntries(limit, categoryId);
        if (entries.length === 0) {
          const suffix = categoryName ? ` in "${categoryName}"` : '';
          return `No unread entries${suffix}.`;
        }

        return `${entries.length} unread entry/entries:\n\n${entries.map(formatEntry).join('\n\n')}`;
      },
    },
    {
      name: 'rss_mark_read',
      description:
        'Mark RSS entries as read by their IDs. Use entry IDs from rss_search or rss_recent results.',
      input_schema: {
        type: 'object',
        properties: {
          entry_ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'Array of entry IDs to mark as read',
          },
        },
        required: ['entry_ids'],
      },
      handler: async (input) => {
        const entryIds = input.entry_ids as number[];
        if (entryIds.length === 0) return 'Error: no entry IDs provided.';
        await markEntriesRead(entryIds);
        return `Marked ${entryIds.length} entry/entries as read.`;
      },
    },
  ];
}
