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
 */

interface TierConfig {
  primary: LLMProvider;
  fallbacks: LLMProvider[];
}

export class LLMRouter {
  private tiers: Record<ModelTier, TierConfig>;

  constructor(ollamaModel?: string) {
    const ollama = createOllamaProvider(ollamaModel ?? 'qwen2.5:7b', 'ollama-local');

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
      console.error(`[router] ${config.primary.name} failed:`, (err as Error).message);
      return this.callWithFallback(config, messages, systemPrompt, tools);
    }
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

    // Escalate to capable tier if the message suggests complexity or tool use
    const toolKeywords = /\b(search|create|read|write|run|edit|delete|update|find|list|execute|build|deploy|install|analyze|debug|fix|refactor|email|emails|inbox|gmail|draft|archive|unread|label|calendar|schedule|meeting|event|browse|navigate|screenshot|task|remind)\b/i;
    if (text.length > 200 || toolKeywords.test(text)) return 'capable';

    // Short simple messages → local if Ollama available, else cheap
    if (text.length < 100) return 'local';

    return 'cheap';
  }

  /**
   * Try fallback providers after a failure.
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
