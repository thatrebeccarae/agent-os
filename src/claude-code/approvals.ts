import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';

interface PendingApproval {
  resolve: (result: { approved: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
  messageId?: number;
  chatId: string;
  description: string;
}

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class ApprovalManager {
  private bot: Bot;
  private ownerChatId: string;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(bot: Bot, ownerChatId: string) {
    this.bot = bot;
    this.ownerChatId = ownerChatId;
  }

  /**
   * Send an approval request to Telegram with inline keyboard.
   * Returns a promise that resolves when the user taps Approve/Deny, timeout, or abort signal.
   */
  async requestApproval(description: string, signal?: AbortSignal): Promise<{ approved: boolean }> {
    // If already aborted, deny immediately
    if (signal?.aborted) {
      return { approved: false };
    }

    const approvalId = crypto.randomUUID();

    const keyboard = new InlineKeyboard()
      .text('Approve', `cc_approve:${approvalId}`)
      .text('Deny', `cc_deny:${approvalId}`);

    // Send as plain text to avoid Markdown parse errors on tool input content
    const messageText = `Claude Code approval needed\n\n${description}`;

    const message = await this.bot.api.sendMessage(
      this.ownerChatId,
      messageText,
      { reply_markup: keyboard },
    );

    return new Promise<{ approved: boolean }>((resolve) => {
      let resolved = false;
      const doResolve = (result: { approved: boolean }) => {
        if (resolved) return;
        resolved = true;
        this.pendingApprovals.delete(approvalId);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        // Edit message to show timeout
        void this.bot.api.editMessageText(
          this.ownerChatId,
          message.message_id,
          `[Timed out] ${description}`,
        ).catch(() => {});
        doResolve({ approved: false });
      }, APPROVAL_TIMEOUT_MS);

      // Listen for abort signal (SDK shutdown / query cancellation)
      const onAbort = () => {
        void this.bot.api.editMessageText(
          this.ownerChatId,
          message.message_id,
          `[Cancelled] ${description}`,
        ).catch(() => {});
        doResolve({ approved: false });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pendingApprovals.set(approvalId, {
        resolve: doResolve,
        timer,
        messageId: message.message_id,
        chatId: this.ownerChatId,
        description,
      });
    });
  }

  /**
   * Handle a callback query from Telegram inline keyboard.
   * Called by the TelegramChannel callback_query handler.
   * Returns true if this callback was handled (was a cc_approve/cc_deny).
   */
  handleCallback(callbackData: string): boolean {
    const approveMatch = callbackData.match(/^cc_approve:(.+)$/);
    const denyMatch = callbackData.match(/^cc_deny:(.+)$/);

    const approvalId = approveMatch?.[1] ?? denyMatch?.[1];
    if (!approvalId) return false;

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false; // Already resolved or timed out

    const approved = !!approveMatch;

    // Edit message to show result (replace buttons with status)
    if (pending.messageId) {
      const statusPrefix = approved ? '[Approved]' : '[Denied]';
      void this.bot.api.editMessageText(
        pending.chatId,
        pending.messageId,
        `${statusPrefix} ${pending.description}`,
      ).catch(() => {});
    }

    pending.resolve({ approved });
    return true;
  }

  /** Cancel all pending approvals (used during shutdown). */
  cancelAll(): void {
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      pending.resolve({ approved: false });
    }
    this.pendingApprovals.clear();
  }

  /** Number of approvals currently waiting for a response. */
  get pendingCount(): number {
    return this.pendingApprovals.size;
  }
}
