import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../channels/types.js';
import type { LLMMessage } from '../llm/types.js';
import { LLMRouter } from '../llm/router.js';
import { AgentStore } from '../memory/store.js';
import { searchMemory } from '../memory/search.js';
import { runAgentLoop } from '../agent/loop.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { getToolDefinitions } from '../agent/tools.js';
import { shouldExtract, extractAndStoreFacts } from '../memory/extract.js';
import { wrapExternalContent } from '../security/content-boundary.js';

/**
 * Gateway connects channel adapters to the agent loop.
 * It routes inbound messages through the agent and sends responses back.
 */
export class Gateway {
  private channels: ChannelAdapter[] = [];
  private store: AgentStore;
  private router: LLMRouter;
  private sessionLocks = new Map<string, Promise<void>>();

  constructor(store: AgentStore, router: LLMRouter) {
    this.store = store;
    this.router = router;
  }

  /**
   * Register a channel adapter and wire up its message handler.
   */
  registerChannel(channel: ChannelAdapter): void {
    channel.onMessage(async (inbound: InboundMessage) => {
      await this.handleMessage(inbound, channel);
    });
    this.channels.push(channel);
    console.log(`[gateway] Registered channel: ${channel.type}`);
  }

  /**
   * Send a proactive message to a session (e.g., from background task worker).
   * Session IDs are formatted as "channelType:channelId".
   */
  async sendToSession(sessionId: string, text: string): Promise<void> {
    const [channelType, channelId] = sessionId.split(':', 2);
    if (!channelType || !channelId) {
      console.error(`[gateway] Invalid session ID for notification: ${sessionId}`);
      return;
    }
    const channel = this.channels.find((c) => c.type === channelType);
    if (!channel) {
      console.error(`[gateway] No channel found for type: ${channelType}`);
      return;
    }
    const outbound: OutboundMessage = { channelType, channelId, text };
    await channel.sendMessage(outbound);
  }

  /**
   * Process an inbound message, serialized per session to prevent
   * concurrent handling from corrupting message order.
   */
  private async handleMessage(
    inbound: InboundMessage,
    channel: ChannelAdapter,
  ): Promise<void> {
    const sessionId = `${inbound.channelType}:${inbound.channelId}`;
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const current = prev.then(() => this._handleMessage(inbound, channel)).catch(() => {});
    this.sessionLocks.set(sessionId, current);
    await current;
  }

  /**
   * Actual message processing implementation (called under per-session lock).
   */
  private async _handleMessage(
    inbound: InboundMessage,
    channel: ChannelAdapter,
  ): Promise<void> {
    const sessionId = `${inbound.channelType}:${inbound.channelId}`;

    console.log(
      `[gateway] ${inbound.channelType}/${inbound.senderName}: ${inbound.text.slice(0, 80)}${inbound.text.length > 80 ? '...' : ''}`,
    );

    try {
      // 1. Ensure session exists
      this.store.getOrCreateSession(sessionId);

      // 2. Load session history and convert to LLM message format
      const storedMessages = this.store.getSessionMessages(sessionId);
      const sessionMessages: LLMMessage[] = storedMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      // 3. Search memory for relevant context
      const memoryContext = this.buildMemoryContext(inbound.text);

      // 4. Build system prompt
      const systemPrompt = buildSystemPrompt({ memoryContext });

      // 5. Wrap non-owner channel messages with content boundaries
      const agentInput = inbound.channelType === 'slack'
        ? wrapExternalContent(inbound.text, `slack:${inbound.senderName}`)
        : inbound.text;

      // 6. Run agent loop (pass sessionId so tools like create_task can link back)
      const result = await runAgentLoop(
        this.router,
        agentInput,
        sessionMessages,
        systemPrompt,
        getToolDefinitions(),
        undefined, // tier — use default
        { sessionId },
      );

      // 7. Save user message and assistant response to store (raw text, not wrapped)
      this.store.appendMessage(sessionId, 'user', inbound.text);
      this.store.appendMessage(sessionId, 'assistant', result.response);

      // Save any tool calls
      for (const tc of result.toolCalls) {
        this.store.appendMessage(sessionId, 'tool_result', tc.result, tc.name);
      }

      // 8. Send response back via the channel
      const responseWithMeta = result.provider !== 'ollama'
        ? `${result.response}\n\n_[${result.provider}/${result.model}]_`
        : result.response;

      const outbound: OutboundMessage = {
        channelType: inbound.channelType,
        channelId: inbound.channelId,
        text: responseWithMeta,
      };

      await channel.sendMessage(outbound);

      // 9. Fire-and-forget: extract memorable facts from this exchange
      if (shouldExtract(sessionId)) {
        // Build the recent exchange as LLMMessages for extraction
        const recentForExtraction: LLMMessage[] = [
          { role: 'user' as const, content: inbound.text },
          { role: 'assistant' as const, content: result.response },
        ];
        void extractAndStoreFacts(this.router, this.store, sessionId, recentForExtraction);
      }
    } catch (err) {
      console.error(`[gateway] Error processing message in session ${sessionId}:`, err);

      const errorMsg: OutboundMessage = {
        channelType: inbound.channelType,
        channelId: inbound.channelId,
        text: 'Sorry, I encountered an error processing your message. Please try again.',
      };
      try {
        await channel.sendMessage(errorMsg);
      } catch {
        console.error('[gateway] Failed to send error message back to channel');
      }
    }
  }

  /**
   * Search long-term memory (FTS) and gather recent short-term facts.
   * Returns a combined context string, or undefined if nothing relevant was found.
   */
  private buildMemoryContext(query: string): string | undefined {
    const sections: string[] = [];

    // Long-term: FTS search for facts related to the user's message
    try {
      const ftsResult = searchMemory(this.store, query, 5);
      if (!ftsResult.startsWith('[No relevant')) {
        sections.push(ftsResult);
      }
    } catch {
      // FTS match syntax errors are non-fatal — skip silently
    }

    // Short-term: most recent facts (session-agnostic recency)
    try {
      const recentFacts = this.store.getRecentFacts(5);
      if (recentFacts.length > 0) {
        const lines = recentFacts.map((f) => `- ${f.fact}`);
        sections.push(`Recent facts:\n${lines.join('\n')}`);
      }
    } catch {
      // Non-fatal
    }

    return sections.length > 0 ? sections.join('\n\n') : undefined;
  }

  /**
   * Start all registered channels.
   */
  async start(): Promise<void> {
    console.log(`[gateway] Starting ${this.channels.length} channel(s)...`);

    // Report provider availability
    const ollamaUp = await this.router.checkOllama();
    const status = this.router.getStatus();
    console.log(`[gateway] Providers: Ollama=${ollamaUp ? 'up' : 'down'} Anthropic=${status.anthropic} OpenAI=${status.openai} Gemini=${status.gemini}`);

    for (const channel of this.channels) {
      await channel.start();
    }
    console.log('[gateway] All channels started');
  }

  /**
   * Stop all registered channels.
   */
  async stop(): Promise<void> {
    console.log('[gateway] Stopping all channels...');
    for (const channel of this.channels) {
      try {
        await channel.stop();
      } catch (err) {
        console.error(`[gateway] Error stopping ${channel.type}:`, err);
      }
    }
    console.log('[gateway] All channels stopped');
  }
}
