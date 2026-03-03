import type { LLMMessage, LLMResponse, LLMToolDefinition, LLMContentBlock, LLMProvider } from './types.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

/**
 * Create an Ollama provider for a specific local model.
 * Ollama uses a simple chat completion API — no native tool calling.
 * Tools are injected into the system prompt as instructions.
 */
export function createOllamaProvider(model: string, name: string): LLMProvider {
  return {
    name,
    async call(messages, systemPrompt, tools): Promise<LLMResponse> {
      // Build system prompt with tool descriptions if provided
      let fullSystem = systemPrompt;
      if (tools && tools.length > 0) {
        fullSystem += '\n\n## Available Tools\n';
        fullSystem += 'You can use tools by responding with a JSON block like:\n';
        fullSystem += '```json\n{"tool": "tool_name", "input": {...}}\n```\n\n';
        for (const t of tools) {
          fullSystem += `- **${t.name}**: ${t.description}\n`;
        }
        fullSystem += '\nIf you don\'t need a tool, just respond with plain text.\n';
      }

      // Convert to Ollama format
      const ollamaMessages: OllamaChatMessage[] = [
        { role: 'system', content: fullSystem },
      ];

      for (const msg of messages) {
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        ollamaMessages.push({ role: msg.role, content });
      }

      const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: ollamaMessages,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama error ${response.status}: ${await response.text()}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const text = data.message.content;

      // Try to detect tool use in the response (local models use text-based tool calling)
      const toolMatch = text.match(/```json\s*\n?\s*\{\s*"tool"\s*:/s);
      if (toolMatch) {
        try {
          const jsonStart = text.indexOf('{', toolMatch.index);
          const jsonEnd = text.indexOf('```', jsonStart);
          const jsonStr = text.slice(jsonStart, jsonEnd).trim();
          const parsed = JSON.parse(jsonStr) as { tool: string; input: Record<string, unknown> };

          const content: LLMContentBlock[] = [
            {
              type: 'tool_use',
              id: `ollama-${Date.now()}`,
              name: parsed.tool,
              input: parsed.input ?? {},
            },
          ];

          return {
            content,
            stopReason: 'tool_use',
            model: data.model,
            provider: 'ollama',
            usage: {
              inputTokens: data.prompt_eval_count ?? 0,
              outputTokens: data.eval_count ?? 0,
            },
          };
        } catch {
          // Failed to parse tool call — treat as text
        }
      }

      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        model: data.model,
        provider: 'ollama',
        usage: {
          inputTokens: data.prompt_eval_count ?? 0,
          outputTokens: data.eval_count ?? 0,
        },
      };
    },
  };
}
