import Anthropic from '@anthropic-ai/sdk';
import type { LLMMessage, LLMResponse, LLMToolDefinition, LLMContentBlock, LLMProvider } from './types.js';

/**
 * Create an Anthropic provider for a specific model.
 */
export function createAnthropicProvider(model: string, name: string): LLMProvider {
  const client = new Anthropic();

  return {
    name,
    async call(messages, systemPrompt, tools): Promise<LLMResponse> {
      const params: Anthropic.MessageCreateParams = {
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages as Anthropic.MessageParam[],
      };

      if (tools && tools.length > 0) {
        params.tools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        }));
      }

      const response = await client.messages.create(params);

      // Normalize to provider-agnostic types
      const content: LLMContentBlock[] = response.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        }
        return { type: 'text' as const, text: '' };
      });

      return {
        content,
        stopReason: response.stop_reason ?? 'end_turn',
        model: response.model,
        provider: 'anthropic',
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}

// Pre-configured providers for each tier
export const anthropicHaiku = createAnthropicProvider('claude-haiku-4-5-20251001', 'anthropic-haiku');
export const anthropicSonnet = createAnthropicProvider('claude-sonnet-4-6', 'anthropic-sonnet');
export const anthropicOpus = createAnthropicProvider('claude-opus-4-6', 'anthropic-opus');
