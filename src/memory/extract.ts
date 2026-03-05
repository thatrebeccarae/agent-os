import type { LLMMessage } from '../llm/types.js';
import type { LLMRouter } from '../llm/router.js';
import type { AgentStore } from './store.js';

// ── Store ref (set via init) ──────────────────────────────────────

let _store: AgentStore | null = null;

export function setExtractStore(store: AgentStore): void {
  _store = store;
}

// ── Types ──────────────────────────────────────────────────────────

type FactCategory = 'preference' | 'fact' | 'context' | 'instruction';

interface ExtractedFact {
  category: FactCategory;
  content: string;
}

// ── Extraction prompt ──────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You extract facts worth remembering from a conversation between a user and an AI assistant.

Output a JSON array of objects with "category" and "content" fields. Categories:
- "preference" — user likes/dislikes, style choices, tool preferences
- "fact" — concrete info about the user, their work, projects, people they mention
- "context" — situational context like deadlines, ongoing situations, decisions made
- "instruction" — explicit standing instructions for how the assistant should behave

Rules:
- Only extract facts that would be useful in FUTURE conversations
- Skip greetings, small talk, and transient/ephemeral things
- Skip things the assistant said unless the user confirmed them
- Be concise — each fact should be one clear sentence
- If nothing is worth remembering, return an empty array: []
- Return ONLY the JSON array, no other text`;

// ── Counters for throttling (persisted to SQLite) ─────────────────

const sessionTurnCounts = new Map<string, number>();

const EXTRACT_EVERY_N_TURNS = 5;

function turnCountKey(sessionId: string): string {
  return `extract_turns:${sessionId}`;
}

/**
 * Check whether extraction should run for this session turn.
 * Returns true every N turns to avoid over-extracting.
 * Turn counts are persisted to SQLite so they survive daemon restarts.
 */
export function shouldExtract(sessionId: string, lastUserMessage?: string): boolean {
  // Immediate extraction for explicit "remember" requests
  if (lastUserMessage && /\bremember\b/i.test(lastUserMessage)) {
    return true;
  }

  // Load from DB on first access for this session
  if (!sessionTurnCounts.has(sessionId) && _store) {
    const stored = _store.getInboxState(turnCountKey(sessionId));
    if (stored) sessionTurnCounts.set(sessionId, Number(stored));
  }

  // Cap the map to avoid unbounded memory growth
  if (sessionTurnCounts.size > 100) {
    sessionTurnCounts.clear();
  }

  const count = (sessionTurnCounts.get(sessionId) ?? 0) + 1;
  sessionTurnCounts.set(sessionId, count);

  // Persist to DB
  if (_store) {
    _store.setInboxState(turnCountKey(sessionId), String(count));
  }

  return count % EXTRACT_EVERY_N_TURNS === 0;
}

// ── Core extraction ────────────────────────────────────────────────

const VALID_CATEGORIES = new Set<FactCategory>(['preference', 'fact', 'context', 'instruction']);

/**
 * Extract memorable facts from recent conversation messages using a cheap LLM call.
 * Returns an array of categorized facts, or an empty array if nothing notable.
 */
export async function extractFacts(
  router: LLMRouter,
  recentMessages: LLMMessage[],
): Promise<ExtractedFact[]> {
  // Build a condensed transcript for the LLM
  const transcript = recentMessages
    .map((m) => {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b): b is { type: 'text'; text: string } => 'text' in b)
              .map((b) => b.text)
              .join(' ')
          : '';
      return `${m.role}: ${text}`;
    })
    .join('\n');

  // Skip if the transcript is too short to have substance
  if (transcript.length < 100) {
    return [];
  }

  const messages: LLMMessage[] = [
    { role: 'user', content: `Extract memorable facts from this conversation:\n\n${transcript}` },
  ];

  const response = await router.call(messages, EXTRACTION_SYSTEM_PROMPT, [], { tier: 'cheap' });

  const responseText = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseFacts(responseText);
}

/**
 * Parse the LLM's JSON response into typed ExtractedFact objects.
 * Handles markdown code fences, trailing commas, and other common LLM quirks.
 */
function parseFacts(raw: string): ExtractedFact[] {
  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    cleaned = cleaned.trim();

    const parsed: unknown = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item): item is ExtractedFact =>
        typeof item === 'object' &&
        item !== null &&
        'category' in item &&
        'content' in item &&
        typeof (item as Record<string, unknown>).category === 'string' &&
        typeof (item as Record<string, unknown>).content === 'string' &&
        VALID_CATEGORIES.has((item as Record<string, unknown>).category as FactCategory),
    );
  } catch {
    console.error('[extract] Failed to parse facts from LLM response:', raw.slice(0, 200));
    return [];
  }
}

// ── Fire-and-forget integration ────────────────────────────────────

const EXTERNAL_CONTENT_MARKER = '<<<EXTERNAL_UNTRUSTED_CONTENT';

/**
 * Run fact extraction and store results. Designed to be called as fire-and-forget.
 * Catches all errors internally so it never disrupts the main flow.
 */
export async function extractAndStoreFacts(
  router: LLMRouter,
  store: AgentStore,
  sessionId: string,
  recentMessages: LLMMessage[],
): Promise<void> {
  try {
    // Check if any message contains external content markers
    const hasExternalContent = recentMessages.some((m) => {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b): b is { type: 'text'; text: string } => 'text' in b)
              .map((b) => b.text)
              .join(' ')
          : '';
      return text.includes(EXTERNAL_CONTENT_MARKER);
    });

    const facts = await extractFacts(router, recentMessages);

    for (const fact of facts) {
      const tag = hasExternalContent
        ? `[${fact.category}] [from_external_content] ${fact.content}`
        : `[${fact.category}] ${fact.content}`;
      store.addFact(tag, sessionId);
    }

    if (facts.length > 0) {
      console.log(`[extract] Stored ${facts.length} fact(s) from session ${sessionId}`);
    }
  } catch (err) {
    console.error('[extract] Fact extraction failed (non-fatal):', (err as Error).message);
  }
}
