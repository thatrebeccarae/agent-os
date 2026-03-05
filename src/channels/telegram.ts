import { Bot } from 'grammy';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import { splitMessage } from './utils.js';

// Telegram limits messages to 4096 characters
const MAX_MESSAGE_LENGTH = 4096;

export class TelegramChannel implements ChannelAdapter {
  readonly type = 'telegram';

  private bot: Bot;
  private allowedUserIds: Set<string> | null;
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private callbackHandler: ((data: string, answerCallback: () => Promise<boolean>) => Promise<void>) | null = null;

  constructor(token: string, allowedUserIds?: string[]) {
    this.bot = new Bot(token);
    this.allowedUserIds = allowedUserIds ? new Set(allowedUserIds) : null;

    // Global error handler — log and continue, don't crash the bot
    this.bot.catch((err) => {
      console.error('[telegram] Bot error:', err.message ?? err);
    });
  }

  async start(): Promise<void> {
    // Register the text message listener before starting
    this.bot.on('message:text', async (ctx) => {
      const senderId = String(ctx.from.id);
      const senderName =
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
        ctx.from.username ||
        senderId;

      // Access control: check user ID or username against allowed list
      if (this.allowedUserIds) {
        const username = ctx.from.username ?? '';
        const isAllowed = this.allowedUserIds.has(senderId) || (username && this.allowedUserIds.has(username));
        if (!isAllowed) {
          const label = username ? `@${username}` : senderId;
          console.warn(`[telegram] Blocked message from unauthorized user: ${label}`);
          await ctx.reply('Unauthorized.');
          return;
        }
      }

      if (!this.messageHandler) {
        console.warn('[telegram] No message handler registered, ignoring message');
        return;
      }

      const inbound: InboundMessage = {
        channelType: 'telegram',
        channelId: String(ctx.chat.id),
        senderId,
        senderName,
        text: ctx.message.text,
        timestamp: ctx.message.date * 1000, // Telegram sends seconds, we want ms
        raw: ctx.message,
      };

      try {
        await this.messageHandler(inbound);
      } catch (err) {
        console.error('[telegram] Handler error:', err);
        try {
          await ctx.reply('Sorry, something went wrong processing your message.');
        } catch {
          // If even the error reply fails, just log it
          console.error('[telegram] Failed to send error reply');
        }
      }
    });

    // Callback query handler for inline keyboards (Claude Code approvals, etc.)
    this.bot.on('callback_query:data', async (ctx) => {
      // Access control: check callback sender against allowed list
      if (this.allowedUserIds) {
        const senderId = String(ctx.from.id);
        const username = ctx.from.username ?? '';
        const isAllowed = this.allowedUserIds.has(senderId) || (username && this.allowedUserIds.has(username));
        if (!isAllowed) {
          await ctx.answerCallbackQuery({ text: 'Unauthorized' });
          return;
        }
      }

      if (this.callbackHandler) {
        await this.callbackHandler(ctx.callbackQuery.data, () => ctx.answerCallbackQuery());
      } else {
        await ctx.answerCallbackQuery();
      }
    });

    // Start long polling (non-blocking — grammY handles this internally)
    this.bot.start({
      onStart: (botInfo) => {
        console.log(`[telegram] Bot started: @${botInfo.username}`);
      },
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    console.log('[telegram] Bot stopped');
  }

  async sendMessage(msg: OutboundMessage): Promise<void> {
    const chunks = splitMessage(msg.text, MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(msg.channelId, chunk, {
          parse_mode: 'Markdown',
          ...(msg.replyToId ? { reply_to_message_id: Number(msg.replyToId) } : {}),
        });
      } catch (err) {
        // If Markdown parsing fails, retry without it
        console.warn('[telegram] Markdown send failed, retrying as plain text');
        await this.bot.api.sendMessage(msg.channelId, chunk, {
          ...(msg.replyToId ? { reply_to_message_id: Number(msg.replyToId) } : {}),
        });
      }
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /** Register a handler for inline keyboard callback queries. */
  onCallbackQuery(handler: (data: string, answerCallback: () => Promise<boolean>) => Promise<void>): void {
    this.callbackHandler = handler;
  }

  /** Send a "typing" indicator to a chat. */
  async sendTypingIndicator(channelId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(channelId, 'typing');
    } catch {
      // Non-fatal — typing indicators are best-effort
    }
  }

  /** Expose the grammy Bot instance (for direct API use, e.g. inline keyboards). */
  getBot(): Bot {
    return this.bot;
  }
}
