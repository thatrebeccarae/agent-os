import { App } from '@slack/bolt';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import { splitMessage } from './utils.js';

/** Minimal shape of a regular Slack message event (no subtype). */
interface SlackMessageEvent {
  type: 'message';
  subtype?: string;
  user?: string;
  text?: string;
  ts: string;
  channel: string;
  channel_type?: string;
}

// Slack's hard limit is 4000 chars; leave margin
const MAX_MESSAGE_LENGTH = 3000;

interface SlackChannelOptions {
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  channelId?: string;
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 * Slack uses *bold* (not **bold**), _italic_ (same), and ```code``` (same).
 */
function toSlackMrkdwn(text: string): string {
  // Convert **bold** to *bold* (Slack uses single asterisks for bold)
  let result = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert [text](url) to <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert bare URLs that aren't already in angle brackets
  // (Slack auto-links URLs but wrapping them ensures correct display)

  return result;
}

export class SlackChannel implements ChannelAdapter {
  readonly type = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private channelId: string | undefined;
  private allowedUserIds: Set<string> | null;
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private useSocketMode: boolean;

  constructor(options: SlackChannelOptions) {
    this.channelId = options.channelId;
    this.useSocketMode = Boolean(options.appToken);

    // Parse SLACK_ALLOWED_USERS env var (comma-separated usernames or IDs)
    const allowedRaw = process.env.SLACK_ALLOWED_USERS?.trim();
    this.allowedUserIds = allowedRaw
      ? new Set(allowedRaw.split(',').map((s) => s.trim()).filter(Boolean))
      : null;

    if (this.useSocketMode) {
      this.app = new App({
        token: options.botToken,
        appToken: options.appToken,
        socketMode: true,
        // Bolt requires signingSecret even in socket mode, but it's not used
        signingSecret: options.signingSecret || 'not-used-in-socket-mode',
      });
    } else {
      this.app = new App({
        token: options.botToken,
        signingSecret: options.signingSecret || 'not-configured',
      });
    }
  }

  async start(): Promise<void> {
    // Fetch bot's own user ID so we can detect mentions and filter self-messages
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id as string | undefined;
      console.log(`[slack] Bot user ID: ${this.botUserId}`);
    } catch (err) {
      console.error('[slack] Failed to fetch bot identity:', err);
    }

    // Handler for processing any incoming Slack event
    const handleSlackEvent = async (
      user: string | undefined,
      text: string | undefined,
      channel: string,
      channelType: string | undefined,
      ts: string,
      say: (text: string) => Promise<unknown>,
    ): Promise<void> => {
      // Skip messages from the bot itself
      if (this.botUserId && user === this.botUserId) return;

      // Access control: check user against allowed list
      if (this.allowedUserIds && user) {
        if (!this.allowedUserIds.has(user)) {
          console.warn(`[slack] Blocked message from unauthorized user: ${user}`);
          return;
        }
      }

      if (!this.messageHandler) {
        console.warn('[slack] No message handler registered, ignoring message');
        return;
      }

      // Strip the bot mention from the text for cleaner processing
      let cleanText = text || '';
      if (this.botUserId) {
        cleanText = cleanText.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
      }

      if (!cleanText) return;

      console.log(`[slack] Received message from ${user} in ${channel}: ${cleanText.slice(0, 80)}`);

      // Look up user info for display name
      let senderName = user || 'unknown';
      try {
        if (user) {
          const userInfo = await this.app.client.users.info({ user });
          senderName =
            userInfo.user?.real_name ||
            userInfo.user?.profile?.display_name ||
            userInfo.user?.name ||
            user;
        }
      } catch {
        // Non-fatal — fall back to user ID
      }

      const inbound: InboundMessage = {
        channelType: 'slack',
        channelId: channel,
        senderId: user || 'unknown',
        senderName,
        text: cleanText,
        timestamp: parseFloat(ts) * 1000,
        raw: { user, text, channel, channel_type: channelType, ts },
      };

      try {
        await this.messageHandler(inbound);
      } catch (err) {
        console.error('[slack] Handler error:', err);
        try {
          await say('Sorry, something went wrong processing your message.');
        } catch {
          console.error('[slack] Failed to send error reply');
        }
      }
    };

    // Listen for @mentions in channels
    this.app.event('app_mention', async ({ event, say }) => {
      console.log(`[slack] app_mention event from ${event.user}`);
      await handleSlackEvent(event.user, event.text, event.channel, 'channel', event.ts, say);
    });

    // Listen for DMs and channel messages where bot is mentioned
    this.app.message(async ({ message, say }) => {
      if (message.subtype) return;
      const msg = message as SlackMessageEvent;

      const isDM = msg.channel_type === 'im';
      // In channels, skip unless mentioned (app_mention handler covers that)
      if (!isDM) return;

      console.log(`[slack] DM from ${msg.user}`);
      await handleSlackEvent(msg.user, msg.text, msg.channel, msg.channel_type, msg.ts, say);
    });

    await this.app.start();
    console.log(`[slack] Bot started (${this.useSocketMode ? 'Socket Mode' : 'HTTP Mode'})`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
    console.log('[slack] Bot stopped');
  }

  async sendMessage(msg: OutboundMessage): Promise<void> {
    const formatted = toSlackMrkdwn(msg.text);
    const chunks = splitMessage(formatted, MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      await this.app.client.chat.postMessage({
        channel: msg.channelId,
        text: chunk,
        ...(msg.replyToId ? { thread_ts: msg.replyToId } : {}),
      });
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }
}
