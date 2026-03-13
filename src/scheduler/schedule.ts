/**
 * Schedule computation — determines the next run time for scheduled jobs.
 *
 * Supports three schedule types:
 * - 'at':    one-shot at a specific ISO-8601 datetime
 * - 'every': recurring interval in milliseconds
 * - 'cron':  cron expression with timezone support (via croner)
 */

import { Cron } from 'croner';
import type { ScheduleType } from './types.js';

// ── Cache parsed Cron objects (up to 128 entries) ──────────────────

const cronCache = new Map<string, Cron>();
const MAX_CACHE_SIZE = 128;

function getCron(expr: string, timezone: string): Cron {
  const key = `${expr}|${timezone}`;
  let cached = cronCache.get(key);
  if (cached) return cached;

  cached = new Cron(expr, { timezone });
  if (cronCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry
    const firstKey = cronCache.keys().next().value;
    if (firstKey) cronCache.delete(firstKey);
  }
  cronCache.set(key, cached);
  return cached;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Compute the next run time in epoch milliseconds.
 * Throws if the expression is invalid or the one-shot time is in the past.
 */
export function computeNextRun(
  type: ScheduleType,
  expr: string,
  timezone: string,
): number {
  const now = Date.now();

  switch (type) {
    case 'at': {
      const target = new Date(expr).getTime();
      if (isNaN(target)) {
        throw new Error(`Invalid ISO-8601 datetime: ${expr}`);
      }
      if (target <= now) {
        throw new Error(`One-shot time is in the past: ${expr}`);
      }
      return target;
    }

    case 'every': {
      const intervalMs = parseInt(expr, 10);
      if (isNaN(intervalMs) || intervalMs <= 0) {
        throw new Error(`Invalid interval (must be positive integer ms): ${expr}`);
      }
      return now + intervalMs;
    }

    case 'cron': {
      const cron = getCron(expr, timezone);
      const next = cron.nextRun();
      if (!next) {
        throw new Error(`Cron expression has no future runs: ${expr}`);
      }
      return next.getTime();
    }

    default:
      throw new Error(`Unknown schedule type: ${type}`);
  }
}

/**
 * Validate a schedule expression without computing next run.
 * Returns null if valid, or an error message string.
 */
export function validateScheduleExpr(
  type: ScheduleType,
  expr: string,
  timezone: string = 'America/Los_Angeles',
): string | null {
  try {
    switch (type) {
      case 'at': {
        const target = new Date(expr).getTime();
        if (isNaN(target)) return `Invalid ISO-8601 datetime: ${expr}`;
        return null;
      }
      case 'every': {
        const ms = parseInt(expr, 10);
        if (isNaN(ms) || ms <= 0) return `Invalid interval (positive integer ms required): ${expr}`;
        return null;
      }
      case 'cron': {
        // Cron constructor throws on invalid expressions
        new Cron(expr, { timezone });
        return null;
      }
      default:
        return `Unknown schedule type: ${type}`;
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Format a schedule for human display.
 */
export function formatSchedule(type: ScheduleType, expr: string, timezone: string): string {
  switch (type) {
    case 'at':
      return `once at ${expr}`;
    case 'every': {
      const ms = parseInt(expr, 10);
      if (ms < 60_000) return `every ${ms / 1_000}s`;
      if (ms < 3_600_000) return `every ${ms / 60_000}min`;
      if (ms < 86_400_000) return `every ${ms / 3_600_000}h`;
      return `every ${ms / 86_400_000}d`;
    }
    case 'cron':
      return `cron: ${expr} (${timezone})`;
    default:
      return expr;
  }
}
