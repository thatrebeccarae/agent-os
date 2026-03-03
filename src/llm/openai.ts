import OpenAI from 'openai';
import type { LLMMessage, LLMResponse, LLMToolDefinition, LLMContentBlock, LLMProvider } from './types.js';

/**
 * Create an OpenAI provider for a specific model.
 */
export function createOpenAIProvider(model: string, name: string): LLMProvider {
  let client: OpenAI | null = null;

  return {
    name,
    async call(messages, systemPrompt, tools): Promise<LLMResponse> {
      if (!client) {
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
        client = new OpenAI();
      }
      // Convert to OpenAI message format
      const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
      ];

      for (const msg of messages) {
        if (typeof msg.content === 'string') {
          openaiMessages.push({ role: msg.role, content: msg.content });
        } else if (Array.isArray(msg.content)) {
          // Handle tool results
          const firstItem = msg.content[0];
          if (firstItem && 'type' in firstItem && firstItem.type === 'tool_result') {
            for (const item of msg.content) {
              if ('tool_use_id' in item) {
                openaiMessages.push({
                  role: 'tool',
                  tool_call_id: item.tool_use_id,
                  content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
                });
              }
            }
          } else {
            // Handle content blocks (assistant response with tool_use)
            const textParts = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
            const toolUseParts = msg.content.filter((b) => b.type === 'tool_use');

            const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
              role: 'assistant',
              content: textParts || null,
            };

            if (toolUseParts.length > 0) {
              assistantMsg.tool_calls = toolUseParts.map((b) => ({
                id: b.type === 'tool_use' ? b.id : '',
                type: 'function' as const,
                function: {
                  name: b.type === 'tool_use' ? b.name : '',
                  arguments: b.type === 'tool_use' ? JSON.stringify(b.input) : '{}',
                },
              }));
            }

            openaiMessages.push(assistantMsg);
          }
        }
      }

      // Convert tool definitions
      const openaiTools: OpenAI.ChatCompletionTool[] | undefined =
        tools && tools.length > 0
          ? tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema as Record<string, unknown>,
              },
            }))
          : undefined;

      const response = await client.chat.completions.create({
        model,
        messages: openaiMessages,
        tools: openaiTools,
        max_tokens: 4096,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error('No response choice from OpenAI');

      const content: LLMContentBlock[] = [];

      // Add text content
      if (choice.message.content) {
        content.push({ type: 'text', text: choice.message.content });
      }

      // Add tool calls
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          if (tc.type === 'function') {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.function.arguments || '{}');
            } catch {
              input = { _raw: tc.function.arguments };
            }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }
      }

      const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use'
        : choice.finish_reason === 'stop' ? 'end_turn'
        : choice.finish_reason ?? 'end_turn';

      return {
        content,
        stopReason,
        model: response.model,
        provider: 'openai',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

// Pre-configured providers (lazy — won't throw without API key until actually called)
export const openai4oMini = createOpenAIProvider('gpt-4o-mini', 'openai-4o-mini');
export const openai4o = createOpenAIProvider('gpt-4o', 'openai-4o');
