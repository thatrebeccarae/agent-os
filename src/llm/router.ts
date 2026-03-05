import type { LLMProvider, LLMMessage, LLMResponse, LLMToolDefinition, ModelTier } from './types.js';
import { anthropicHaiku, anthropicSonnet, anthropicOpus } from './anthropic.js';
import { openai4oMini, openai4o } from './openai.js';
import { geminiFlash, geminiPro } from './gemini.js';
import { createOllamaProvider } from './ollama.js';

/**
 * LLM Router — picks the right provider based on task tier.
 *
 * Tier routing:
 *   local    → Ollama (free) → Gemini Flash (free tier fallback)
 *   cheap    → Gemini Flash (free) → GPT-4o-mini ($0.15/M) → Haiku ($0.25/M)
 *   capable  → Claude Sonnet ($3/M) → GPT-4o ($2.50/M) → Gemini Pro
 *   max      → Claude Opus ($15/M) → Claude Sonnet → GPT-4o
 *
 * Override in message: @local, @haiku, @sonnet, @opus, @gemini, @gpt
 *
 * Rate limit handling:
 *   On 429, retry the SAME provider after a delay (default 30s, or retry-after header).
 *   Up to MAX_RATE_LIMIT_RETRIES before falling back to next provider.
 *   This prevents mid-conversation model downgrades.
 */

const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 30_000;

interface TierConfig {
  primary: LLMProvider;
  fallbacks: LLMProvider[];
}

/** Check if an error is a rate limit (429) or overload (529). */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b/.test(msg) || /rate.limit/i.test(msg) || /\b529\b/.test(msg) || /overloaded/i.test(msg);
}

/** Check if the error indicates a fully exhausted quota (limit: 0) — not worth retrying. */
function isQuotaExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /limit:\s*0\b/.test(msg) || /exceeded your current quota/i.test(msg);
}

/** Extract retry delay from error message (Anthropic/OpenAI include retry-after hints). */
function parseRetryDelay(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  // Look for "retry in Xs" or "retry after Xs" patterns
  const match = msg.match(/retry.+?(\d+(?:\.\d+)?)\s*s/i);
  if (match) {
    const seconds = Math.ceil(parseFloat(match[1]));
    // Cap at 120s to avoid unreasonable waits
    return Math.min(seconds * 1000, 120_000);
  }
  return DEFAULT_RETRY_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMRouter {
  private tiers: Record<ModelTier, TierConfig>;

  constructor(ollamaModel?: string) {
    const ollama = createOllamaProvider(ollamaModel ?? process.env.OLLAMA_MODEL ?? 'qwen3.5:9b', 'ollama-local');

    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasGemini = !!process.env.GEMINI_API_KEY;

    this.tiers = {
      local: {
        primary: ollama,
        fallbacks: [
          ...(hasGemini ? [geminiFlash] : []),
          ...(hasOpenAI ? [openai4oMini] : []),
        ],
      },
      cheap: {
        primary: hasGemini ? geminiFlash : hasOpenAI ? openai4oMini : hasAnthropic ? anthropicHaiku : ollama,
        fallbacks: [
          ...(hasGemini && geminiFlash ? [] : hasGemini ? [geminiFlash] : []),
          ...(hasOpenAI ? [openai4oMini] : []),
          ...(hasAnthropic ? [anthropicHaiku] : []),
          ollama,
        ].filter((p, i, arr) => arr.indexOf(p) === i), // dedupe
      },
      capable: {
        primary: hasAnthropic ? anthropicSonnet : hasOpenAI ? openai4o : hasGemini ? geminiPro : ollama,
        fallbacks: [
          ...(hasOpenAI ? [openai4o] : []),
          ...(hasAnthropic ? [anthropicSonnet] : []),
          ...(hasGemini ? [geminiPro, geminiFlash] : []),
          ollama,
        ].filter((p, i, arr) => arr.indexOf(p) === i),
      },
      max: {
        primary: hasAnthropic ? anthropicOpus : hasOpenAI ? openai4o : hasGemini ? geminiPro : ollama,
        fallbacks: [
          ...(hasAnthropic ? [anthropicSonnet] : []),
          ...(hasOpenAI ? [openai4o] : []),
          ...(hasGemini ? [geminiPro, geminiFlash] : []),
          ollama,
        ].filter((p, i, arr) => arr.indexOf(p) === i),
      },
    };
  }

  /**
   * Route a message to the appropriate provider.
   */
  async call(
    messages: LLMMessage[],
    systemPrompt: string,
    tools?: LLMToolDefinition[],
    options?: { tier?: ModelTier },
  ): Promise<LLMResponse> {
    const tier = options?.tier ?? this.detectTier(messages);
    const config = this.tiers[tier];

    console.log(`[router] Tier: ${tier} → ${config.primary.name}`);

    try {
      return await config.primary.call(messages, systemPrompt, tools);
    } catch (err) {
      // Rate limit on primary → retry with backoff before falling back
      // Skip retries if quota is fully exhausted (limit: 0)
      if (isRateLimitError(err) && !isQuotaExhausted(err)) {
        const retryResult = await this.retryWithBackoff(
          config.primary, messages, systemPrompt, tools,
        );
        if (retryResult) return retryResult;
      }

      console.error(`[router] ${config.primary.name} failed:`, (err as Error).message);
      return this.callWithFallback(config, messages, systemPrompt, tools);
    }
  }

  /**
   * Retry a provider after rate limit with exponential backoff.
   * Returns the response if a retry succeeds, null if all retries exhausted.
   */
  private async retryWithBackoff(
    provider: LLMProvider,
    messages: LLMMessage[],
    systemPrompt: string,
    tools?: LLMToolDefinition[],
  ): Promise<LLMResponse | null> {
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      const delay = DEFAULT_RETRY_DELAY_MS * attempt; // 30s, 60s
      console.log(`[router] ${provider.name} rate-limited — retry ${attempt}/${MAX_RATE_LIMIT_RETRIES} in ${delay / 1000}s`);
      await sleep(delay);

      try {
        return await provider.call(messages, systemPrompt, tools);
      } catch (retryErr) {
        if (!isRateLimitError(retryErr)) {
          // Non-rate-limit error — stop retrying, fall through to fallback
          console.error(`[router] ${provider.name} retry failed (non-rate-limit):`, (retryErr as Error).message);
          return null;
        }
        console.warn(`[router] ${provider.name} still rate-limited after retry ${attempt}`);
      }
    }
    console.warn(`[router] ${provider.name} retries exhausted — falling back`);
    return null;
  }

  /**
   * Detect which tier to use based on the latest user message.
   */
  private detectTier(messages: LLMMessage[]): ModelTier {
    const lastMsg = messages[messages.length - 1];

    // If the last message contains tool_results, this is a continuation —
    // stay at capable tier so the same model summarizes its own tool output.
    if (Array.isArray(lastMsg?.content) &&
        lastMsg.content.some((b) => 'type' in b && b.type === 'tool_result')) {
      return 'capable';
    }

    const text = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

    // Explicit overrides
    if (/@opus\b/.test(text)) return 'max';
    if (/@sonnet\b/.test(text)) return 'capable';
    if (/@(haiku|gpt|gemini)\b/.test(text)) return 'cheap';
    if (/@local\b/.test(text)) return 'local';

    // Escalate to capable tier if the message suggests tool use or complex intent

    // Imperative verbs that signal action
    const startsWithAction = /^\s*(show|check|find|get|read|send|create|set|update|run|trigger|schedule|draft|write|add|remove|delete|cancel|open|search|list|summarize|pull|fetch|move|copy|archive|forward|reply|respond|review|fix|debug|build|deploy|refactor|analyze|compare|merge|push|commit|organize)\b/i;

    // Domain nouns that imply tool use
    const domainNouns = /\b(email|emails|inbox|gmail|draft|calendar|meeting|event|call|vault|note|notes|daily note|project|task|workflow|claude|code|rss|feed|digest|reminder|contact|repo|branch|pr|pull request|schedule|appointment|free time|busy|agenda|morning|pipeline|n8n|miniflux|browser|screenshot|website)\b/i;

    // Questions from phone almost always need tools
    const hasQuestion = text.includes('?');

    // Long messages = complex intent
    if (text.length > 150) return 'capable';
    if (startsWithAction.test(text)) return 'capable';
    if (domainNouns.test(text)) return 'capable';
    if (hasQuestion && text.length > 15) return 'capable';
    if (hasQuestion) return 'cheap';

    // Short messages without action signals → local (cost savings)
    if (text.length < 80) return 'local';

    return 'cheap';
  }

  /**
   * Try fallback providers after a failure.
   * Rate-limited fallbacks also get retry attempts before moving to next.
   */
  private async callWithFallback(
    config: TierConfig,
    messages: LLMMessage[],
    systemPrompt: string,
    tools?: LLMToolDefinition[],
  ): Promise<LLMResponse> {
    for (const provider of config.fallbacks) {
      if (provider === config.primary) continue;
      try {
        console.log(`[router] Fallback → ${provider.name}`);
        return await provider.call(messages, systemPrompt, tools);
      } catch (err) {
        // Rate limit on fallback — retry before moving to next
        // Skip retries if quota is fully exhausted (limit: 0)
        if (isRateLimitError(err) && !isQuotaExhausted(err)) {
          const retryResult = await this.retryWithBackoff(
            provider, messages, systemPrompt, tools,
          );
          if (retryResult) return retryResult;
        }
        console.error(`[router] ${provider.name} failed:`, (err as Error).message);
        continue;
      }
    }

    throw new Error('All LLM providers failed');
  }

  /**
   * Check if Ollama is reachable.
   */
  async checkOllama(): Promise<boolean> {
    try {
      const base = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Report which providers are available.
   */
  getStatus(): Record<string, boolean> {
    return {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
    };
  }
}
