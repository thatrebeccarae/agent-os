/**
 * Goal Extraction — Two-Pass significance filtering.
 *
 * Piggybacks on memory extraction (src/memory/extract.ts). Runs alongside
 * fact extraction as a cheap LLM call to detect goal-worthy signals in
 * conversation.
 *
 * Pass 1: Significance Filtering — scans for temporal/impact markers, assigns
 *         confidence score. Cheap regex + heuristic pass (no LLM call).
 * Pass 2: Structured Parameterization — if confidence > threshold, LLM fills
 *         a 5W schema and proposes success criteria.
 *
 * Mid-confidence signals trigger a confirmation question rather than
 * silent goal creation.
 */

import type { LLMMessage } from '../llm/types.js';
import type { LLMRouter } from '../llm/router.js';

// ── Constants ──────────────────────────────────────────────────────

const HIGH_CONFIDENCE_THRESHOLD = 0.8;
const MID_CONFIDENCE_THRESHOLD = 0.4;

// ── Signal weights for Pass 1 ─────────────────────────────────────

interface SignalMatch {
  pattern: RegExp;
  weight: number;
  label: string;
}

const TEMPORAL_SIGNALS: SignalMatch[] = [
  { pattern: /\b(every|daily|weekly|monthly|each)\s+(day|week|month|morning|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, weight: 0.35, label: 'recurring temporal' },
  { pattern: /\b(every)\s+\d+\s*(minutes?|hours?|days?|weeks?)\b/i, weight: 0.35, label: 'interval temporal' },
  { pattern: /\b(at|by|before|after|until)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/i, weight: 0.2, label: 'time reference' },
  { pattern: /\bcron\b|\bcrontab\b/i, weight: 0.3, label: 'cron reference' },
  { pattern: /\b(keep an eye on|monitor|watch|track)\b/i, weight: 0.3, label: 'monitoring intent' },
];

const IMPACT_SIGNALS: SignalMatch[] = [
  { pattern: /\b(grow|increase|boost|improve|maximize|optimize|reduce|minimize|decrease)\b/i, weight: 0.25, label: 'optimization intent' },
  { pattern: /\b(start|begin|launch|set up|establish|build)\b/i, weight: 0.15, label: 'initiative intent' },
  { pattern: /\b(i want (you to|to)|i need (you to|to)|i'd like (you to|to)|can you|please)\s+(always|regularly|consistently)\b/i, weight: 0.3, label: 'standing instruction' },
  { pattern: /\b(goal|objective|target|milestone|aim)\b/i, weight: 0.2, label: 'explicit goal' },
  { pattern: /\b(kpi|metric|measure|benchmark)\b/i, weight: 0.15, label: 'measurement intent' },
];

const LOW_SIGNAL_PATTERNS: RegExp[] = [
  /\b(look up|check|what('s| is)|how (do|does|to)|where|when|who|search for|find)\b/i, // one-off queries
  /\b(weather|time|date|price|stock)\b/i, // ephemeral lookups
];

// ── Types ──────────────────────────────────────────────────────────

export interface GoalSignal {
  confidence: number;
  matchedSignals: string[];
  sourceText: string;
}

export interface ExtractedGoal {
  title: string;
  description: string;
  successTarget: string;
  successKpi?: string;
  successBaseline?: string;
  reviewCadenceHours?: number;
  deadline?: string;
  confidence: number;
}

// ── Pass 1: Significance Filtering ────────────────────────────────

/**
 * Scan user messages for goal-worthy signals using regex heuristics.
 * Returns a confidence score and matched signal labels.
 * No LLM call — this is the cheap first pass.
 */
export function detectGoalSignals(userMessages: string[]): GoalSignal | null {
  const fullText = userMessages.join(' ');

  // Quick reject: too short to be a goal
  if (fullText.length < 20) return null;

  // Check for low-signal patterns that suggest one-off queries
  const isLowSignal = LOW_SIGNAL_PATTERNS.some((p) => p.test(fullText));

  let confidence = 0;
  const matchedSignals: string[] = [];

  for (const signal of [...TEMPORAL_SIGNALS, ...IMPACT_SIGNALS]) {
    if (signal.pattern.test(fullText)) {
      confidence += signal.weight;
      matchedSignals.push(signal.label);
    }
  }

  // Dampen if it looks like a one-off query
  if (isLowSignal && matchedSignals.length <= 1) {
    confidence *= 0.3;
  }

  // Cap at 1.0
  confidence = Math.min(confidence, 1.0);

  if (confidence < MID_CONFIDENCE_THRESHOLD) return null;

  return {
    confidence,
    matchedSignals,
    sourceText: fullText.slice(0, 500),
  };
}

// ── Pass 2: Structured Parameterization ───────────────────────────

const GOAL_EXTRACTION_PROMPT = `You extract goal information from a conversation where a user wants an AI assistant to pursue an ongoing objective.

Given the conversation excerpt, extract:
1. A short goal title
2. A detailed description of what to achieve
3. A measurable success target
4. A KPI to track (if measurable)
5. The current baseline (if mentioned)
6. How often to review progress (in hours, default 24)
7. A deadline (ISO-8601, if mentioned)

Output a JSON object:
{
  "title": "short title",
  "description": "detailed description",
  "success_target": "measurable end state",
  "success_kpi": "metric to track" or null,
  "success_baseline": "current state" or null,
  "review_cadence_hours": 24,
  "deadline": "ISO-8601" or null
}

Rules:
- Only extract if there's a clear, persistent objective (not a one-off task)
- The success target should be specific and measurable where possible
- If the user's intent is vague, make the target descriptive but honest
- Return ONLY the JSON object, no other text`;

/**
 * Use a cheap LLM call to extract structured goal parameters from
 * conversation text. Only called when Pass 1 confidence exceeds the
 * high threshold.
 */
export async function extractGoalParams(
  router: LLMRouter,
  conversationText: string,
): Promise<ExtractedGoal | null> {
  try {
    const messages: LLMMessage[] = [
      { role: 'user', content: `Extract goal from this conversation:\n\n${conversationText}` },
    ];

    const response = await router.call(messages, GOAL_EXTRACTION_PROMPT, [], { tier: 'cheap' });

    const responseText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return parseGoalExtraction(responseText);
  } catch (err) {
    console.error('[goal-extract] Extraction failed:', (err as Error).message);
    return null;
  }
}

/**
 * Build a confirmation question for mid-confidence signals.
 * Returns the question text that Agent should ask the operator.
 */
export function buildConfirmationQuestion(signal: GoalSignal): string {
  // Extract the most relevant snippet
  const snippet = signal.sourceText.slice(0, 200);
  return (
    `It sounds like you'd like me to set up an ongoing goal based on: "${snippet}..."\n\n` +
    `Should I create a goal for this and track progress? ` +
    `I can break it down into scheduled actions and evaluate regularly.`
  );
}

// ── Parsing ───────────────────────────────────────────────────────

function parseGoalExtraction(raw: string): ExtractedGoal | null {
  try {
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    cleaned = cleaned.trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const title = parsed.title as string;
    const description = parsed.description as string;
    const successTarget = parsed.success_target as string;

    if (!title || !description || !successTarget) return null;

    return {
      title,
      description,
      successTarget,
      successKpi: (parsed.success_kpi as string) ?? undefined,
      successBaseline: (parsed.success_baseline as string) ?? undefined,
      reviewCadenceHours: typeof parsed.review_cadence_hours === 'number'
        ? parsed.review_cadence_hours
        : undefined,
      deadline: (parsed.deadline as string) ?? undefined,
      confidence: 1.0, // Pass 2 succeeded — full confidence
    };
  } catch {
    console.error('[goal-extract] Failed to parse goal extraction:', raw.slice(0, 200));
    return null;
  }
}
