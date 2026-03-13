/**
 * First-run onboarding wizard.
 * When the operator messages Agent for the first time, walks through setup:
 * - Welcome + capability overview
 * - Quiet hours preferences
 * - Monitor preferences (inbox, Docker)
 * - Marks onboarding complete
 *
 * Subsequent conversations skip onboarding entirely.
 */

import type { AgentStore } from '../memory/store.js';
import { AGENT_NAME, OPERATOR_NAME } from '../config/identity.js';

// ── Schema ─────────────────────────────────────────────────────────

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS operator_preferences (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  )
`;

/**
 * Initialize the operator_preferences table. Call during app bootstrap.
 */
export function initOnboardingSchema(store: AgentStore): void {
  store.db.exec(CREATE_TABLE);
}

// ── Preference helpers ─────────────────────────────────────────────

export function getPreference(store: AgentStore, key: string): string | null {
  const row = store.db
    .prepare('SELECT value FROM operator_preferences WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setPreference(store: AgentStore, key: string, value: string): void {
  store.db
    .prepare(
      `INSERT INTO operator_preferences (key, value, updated_at)
       VALUES (?, ?, unixepoch('now') * 1000)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value);
}

// ── Onboarding state ───────────────────────────────────────────────

/**
 * Check if onboarding has been completed.
 */
export function isOnboardingComplete(store: AgentStore): boolean {
  return getPreference(store, 'onboarding_complete') === 'true';
}

/**
 * Mark onboarding as complete.
 */
export function completeOnboarding(store: AgentStore): void {
  setPreference(store, 'onboarding_complete', 'true');
}

// ── Welcome message ────────────────────────────────────────────────

/**
 * Generate the welcome message for first-time users.
 * This gets injected into the system prompt for the first conversation,
 * so the LLM can guide the onboarding naturally.
 */
export function getOnboardingPrompt(): string {
  return `IMPORTANT: This is the operator's FIRST conversation with you. Guide them through a brief onboarding. Be warm and conversational — this is your first impression.

Walk through these topics naturally (don't dump them all at once — have a conversation):

1. WELCOME: Introduce yourself briefly. Mention your key capabilities:
   - Email monitoring and triage (Gmail)
   - Calendar awareness
   - Web search and browsing
   - File and note management (Obsidian vault)
   - RSS feed monitoring
   - Task management
   - Code assistance (via Claude Code handoff)
   - Twitter/X management

2. QUIET HOURS: Ask what hours they'd prefer you stay quiet (no proactive notifications). Suggest 10 PM to 7 AM as a default. When they answer, confirm what you understood.

3. MONITORS: Ask which proactive monitors they'd like enabled:
   - Inbox monitoring (checks email every 30 min, sends digest of important messages)
   - Docker service health (checks every 15 min, alerts on service outages)
   - RSS morning digest (daily summary of new feed items)
   Ask about each one — some people find proactive notifications helpful, others find them annoying.

4. WRAP UP: Confirm their choices, let them know they can change preferences anytime by asking you. Mark onboarding complete.

After the conversation covers these topics, use the internal function to save their preferences. Don't ask all questions at once — pace the conversation naturally across multiple exchanges.`;
}

/**
 * Generate a system prompt addition for ongoing conversations (post-onboarding).
 * Injects saved preferences as context.
 */
export function getPreferencesContext(store: AgentStore): string | undefined {
  if (!isOnboardingComplete(store)) return undefined;

  const prefs: string[] = [];

  const quietStart = getPreference(store, 'quiet_hours_start');
  const quietEnd = getPreference(store, 'quiet_hours_end');
  if (quietStart && quietEnd) {
    prefs.push(`Quiet hours: ${quietStart} to ${quietEnd}`);
  }

  const inboxMonitor = getPreference(store, 'inbox_monitor');
  if (inboxMonitor) {
    prefs.push(`Inbox monitor: ${inboxMonitor}`);
  }

  const dockerMonitor = getPreference(store, 'docker_monitor');
  if (dockerMonitor) {
    prefs.push(`Docker monitor: ${dockerMonitor}`);
  }

  const rssDigest = getPreference(store, 'rss_digest');
  if (rssDigest) {
    prefs.push(`RSS digest: ${rssDigest}`);
  }

  if (prefs.length === 0) return undefined;
  return `Operator preferences:\n${prefs.map((p) => `- ${p}`).join('\n')}`;
}
