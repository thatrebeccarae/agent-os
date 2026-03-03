import { GoogleGenerativeAI, type Content, type Part, SchemaType } from '@google/generative-ai';
import type { LLMMessage, LLMResponse, LLMToolDefinition, LLMContentBlock, LLMProvider } from './types.js';

/**
 * Create a Google Gemini provider for a specific model.
 */
export function createGeminiProvider(model: string, name: string): LLMProvider {
  return {
    name,
    async call(messages, systemPrompt, tools): Promise<LLMResponse> {
      // Per-call map to track tool call IDs → names (Gemini needs function name for responses, not an ID)
      const toolCallNames = new Map<string, string>();

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GEMINI_API_KEY not set');

      const genAI = new GoogleGenerativeAI(apiKey);

      // Convert tool definitions to Gemini format
      // Use type assertion to handle SDK's strict Schema typing
      const geminiTools = tools && tools.length > 0
        ? [{
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: convertSchemaToGemini(t.input_schema),
            })),
          }] as Parameters<typeof genAI.getGenerativeModel>[0]['tools']
        : undefined;

      const generativeModel = genAI.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
        tools: geminiTools,
      });

      // Convert messages to Gemini Content format
      const contents: Content[] = [];

      for (const msg of messages) {
        if (typeof msg.content === 'string') {
          contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
          });
        } else if (Array.isArray(msg.content)) {
          const firstItem = msg.content[0];

          // Tool results → user role with functionResponse parts
          if (firstItem && 'type' in firstItem && firstItem.type === 'tool_result') {
            const parts: Part[] = [];
            for (const item of msg.content) {
              if ('tool_use_id' in item) {
                // We need the function name — store it from the previous tool_use
                const fnName = toolCallNames.get(item.tool_use_id) ?? 'unknown';
                parts.push({
                  functionResponse: {
                    name: fnName,
                    response: { result: typeof item.content === 'string' ? item.content : JSON.stringify(item.content) },
                  },
                });
              }
            }
            contents.push({ role: 'user', parts });
          } else {
            // Content blocks (assistant with tool_use)
            const parts: Part[] = [];
            for (const block of msg.content) {
              if (block.type === 'text') {
                parts.push({ text: block.text });
              } else if (block.type === 'tool_use') {
                toolCallNames.set(block.id, block.name);
                parts.push({
                  functionCall: { name: block.name, args: block.input },
                });
              }
            }
            contents.push({ role: 'model', parts });
          }
        }
      }

      const result = await generativeModel.generateContent({ contents });
      const response = result.response;
      const candidate = response.candidates?.[0];
      if (!candidate) throw new Error('No response candidate from Gemini');

      const content: LLMContentBlock[] = [];
      let hasToolUse = false;

      const parts = candidate.content?.parts ?? [];
      if (parts.length === 0) {
        // Gemini returned no content (safety filter, empty response, etc.)
        const finishReason = candidate.finishReason ?? 'unknown';
        content.push({ type: 'text', text: `[Gemini returned empty response — finishReason: ${finishReason}]` });
      }

      for (const part of parts) {
        if ('text' in part && part.text) {
          content.push({ type: 'text', text: part.text });
        }
        if ('functionCall' in part && part.functionCall) {
          const id = `gemini-${Date.now()}-${part.functionCall.name}`;
          toolCallNames.set(id, part.functionCall.name);
          content.push({
            type: 'tool_use',
            id,
            name: part.functionCall.name,
            input: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
          hasToolUse = true;
        }
      }

      const usage = response.usageMetadata;

      return {
        content,
        stopReason: hasToolUse ? 'tool_use' : 'end_turn',
        model,
        provider: 'gemini',
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}

/**
 * Convert a JSON Schema object to Gemini's schema format.
 * Gemini requires SchemaType enum values instead of string type names.
 */
function convertSchemaToGemini(schema: Record<string, unknown>): {
  type: SchemaType;
  properties?: Record<string, unknown>;
  required?: string[];
} {
  return {
    type: SchemaType.OBJECT,
    properties: (schema.properties ?? {}) as Record<string, unknown>,
    required: (schema.required ?? []) as string[],
  };
}

// Pre-configured providers
export const geminiFlash = createGeminiProvider('gemini-2.0-flash', 'gemini-flash');
export const geminiPro = createGeminiProvider('gemini-2.5-pro', 'gemini-pro');
