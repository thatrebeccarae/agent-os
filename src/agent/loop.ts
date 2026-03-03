import type { LLMMessage, LLMToolDefinition, LLMResponse, ModelTier } from '../llm/types.js';
import type { ToolContext } from './tools.js';
import { LLMRouter } from '../llm/router.js';
import { executeTool } from './tools.js';

const MAX_ITERATIONS = 10;

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: string;
}

export interface AgentResult {
  response: string;
  messages: LLMMessage[];
  toolCalls: ToolCallRecord[];
  model: string;
  provider: string;
}

/**
 * Run the core agent loop: send user message, handle tool calls until
 * the model produces a final text response (or we hit the iteration cap).
 */
export async function runAgentLoop(
  router: LLMRouter,
  userMessage: string,
  sessionMessages: LLMMessage[],
  systemPrompt: string,
  tools: LLMToolDefinition[],
  tier?: ModelTier,
  toolContext?: ToolContext,
): Promise<AgentResult> {
  // Strip tier override prefixes from the message
  const cleanMessage = userMessage.replace(/@(local|haiku|sonnet|opus)\b/g, '').trim();

  const messages: LLMMessage[] = [
    ...sessionMessages,
    { role: 'user', content: cleanMessage || userMessage },
  ];
  const toolCalls: ToolCallRecord[] = [];
  let lastResponse: LLMResponse | null = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await router.call(messages, systemPrompt, tools, { tier });
    lastResponse = response;

    // Append assistant response to conversation
    messages.push({ role: 'assistant', content: response.content });

    if (response.stopReason !== 'tool_use') {
      // Extract final text
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      return {
        response: text,
        messages,
        toolCalls,
        model: response.model,
        provider: response.provider,
      };
    }

    // Process every tool_use block in the response
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      const result = await executeTool(block.name, block.input, toolContext);
      toolCalls.push({ name: block.name, input: block.input, result });
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: 'user', content: results });
  }

  // Safety: if we exhausted iterations, return whatever we have
  return {
    response: '[Agent loop hit max iterations without a final response]',
    messages,
    toolCalls,
    model: lastResponse?.model ?? 'unknown',
    provider: lastResponse?.provider ?? 'unknown',
  };
}
