import { isGmailConfigured } from '../gmail/auth.js';

/**
 * Returns the owner's Telegram session ID for proactive alerts,
 * or null if TELEGRAM_OWNER_CHAT_ID is not configured.
 */
export function getOwnerSessionId(): string | null {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) return null;
  return `telegram:${chatId}`;
}

/**
 * Proactive monitoring requires both the owner chat ID (for alert delivery)
 * and Gmail credentials (for inbox monitoring). Docker monitoring only
 * needs the owner chat ID.
 */
export function isProactiveEnabled(): boolean {
  return !!getOwnerSessionId();
}

/**
 * Inbox monitoring specifically requires Gmail to be configured.
 */
export function isInboxMonitorEnabled(): boolean {
  return !!getOwnerSessionId() && isGmailConfigured();
}

/**
 * Calendar monitoring requires owner chat ID and Google Calendar configured.
 */
export function isCalendarMonitorEnabled(): boolean {
  return !!getOwnerSessionId() && isGmailConfigured();
}
