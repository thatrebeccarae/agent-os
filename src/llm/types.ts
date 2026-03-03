/**
 * Provider-agnostic LLM types.
 * All providers normalize their responses to these types.
 */

export type MessageRole = 'user' | 'assistant';

export interface LLMMessage {
  role: MessageRole;
  content: string | LLMContentBlock[] | LLMToolResult[];
}

export interface LLMTextBlock {
  type: 'text';
  text: string;
}

export interface LLMToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LLMContentBlock = LLMTextBlock | LLMToolUseBlock;

export interface LLMToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMResponse {
  content: LLMContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  model: string;
  provider: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type ModelTier = 'local' | 'cheap' | 'capable' | 'max';

export interface LLMProvider {
  name: string;
  call(
    messages: LLMMessage[],
    systemPrompt: string,
    tools?: LLMToolDefinition[],
  ): Promise<LLMResponse>;
}
