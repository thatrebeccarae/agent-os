/**
 * ScheduleApprovalManager — sends Telegram inline keyboard prompts
 * when agent-created scheduled jobs need operator approval.
 *
 * Follows the same pattern as claude-code/approvals.ts but for
 * scheduled job approval/denial.
 */

import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { SchedulerStore } from './store.js';
import { formatSchedule } from './schedule.js';

// ── Constants ──────────────────────────────────────────────────────

const APPROVAL_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour (jobs are less urgent than bash commands)

// ── Callback data prefixes ─────────────────────────────────────────

const APPROVE_PREFIX = 'sched_approve:';
const DENY_PREFIX = 'sched_deny:';

// ── ScheduleApprovalManager ────────────────────────────────────────

export class ScheduleApprovalManager {
  private bot: Bot;
  private ownerChatId: string;
  private store: SchedulerStore;
  private pendingMessages = new Map<string, { messageId: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(bot: Bot, ownerChatId: string, store: SchedulerStore) {
    this.bot = bot;
    this.ownerChatId = ownerChatId;
    this.store = store;
  }

  /**
   * Send an approval request for a newly created scheduled job.
   * Non-blocking — the approval resolves via callback query handler.
   */
  async requestApproval(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job) return;

    const schedule = formatSchedule(job.scheduleType, job.scheduleExpr, job.timezone);

    const keyboard = new InlineKeyboard()
      .text('Approve', `${APPROVE_PREFIX}${jobId}`)
      .text('Deny', `${DENY_PREFIX}${jobId}`);

    const text =
      `New scheduled job needs approval\n\n` +
      `Name: ${job.name}\n` +
      `Schedule: ${schedule}\n` +
      `Task: ${job.payloadPrompt.slice(0, 200)}${job.payloadPrompt.length > 200 ? '...' : ''}`;

    try {
      const message = await this.bot.api.sendMessage(
        this.ownerChatId,
        text,
        { reply_markup: keyboard },
      );

      // Set timeout — auto-deny if no response
      const timer = setTimeout(() => {
        this.pendingMessages.delete(jobId);
        // Don't auto-deny, just let it sit as pending — operator can approve later
        void this.bot.api.editMessageText(
          this.ownerChatId,
          message.message_id,
          `[Timed out — still pending] ${text}`,
        ).catch(() => {});
      }, APPROVAL_TIMEOUT_MS);

      this.pendingMessages.set(jobId, { messageId: message.message_id, timer });
    } catch (err) {
      console.error('[schedule-approval] Failed to send approval request:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Handle a callback query from Telegram inline keyboard.
   * Returns true if this callback was recognized (sched_approve/sched_deny prefix).
   */
  handleCallback(callbackData: string): boolean {
    let jobId: string | undefined;
    let approved: boolean;

    if (callbackData.startsWith(APPROVE_PREFIX)) {
      jobId = callbackData.slice(APPROVE_PREFIX.length);
      approved = true;
    } else if (callbackData.startsWith(DENY_PREFIX)) {
      jobId = callbackData.slice(DENY_PREFIX.length);
      approved = false;
    } else {
      return false;
    }

    // Clean up pending state
    const pending = this.pendingMessages.get(jobId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingMessages.delete(jobId);
    }

    // Update the job in the store
    if (approved) {
      const job = this.store.approveJob(jobId);
      if (job && pending) {
        const schedule = formatSchedule(job.scheduleType, job.scheduleExpr, job.timezone);
        void this.bot.api.editMessageText(
          this.ownerChatId,
          pending.messageId,
          `[Approved] ${job.name}\nSchedule: ${schedule}\nNext run: ${new Date(job.nextRunAt).toLocaleString()}`,
        ).catch(() => {});
      }
      console.log(`[schedule-approval] Job "${jobId}" approved`);
    } else {
      const job = this.store.denyJob(jobId);
      if (job && pending) {
        void this.bot.api.editMessageText(
          this.ownerChatId,
          pending.messageId,
          `[Denied] ${job.name}`,
        ).catch(() => {});
      }
      console.log(`[schedule-approval] Job "${jobId}" denied`);
    }

    return true;
  }

  /** Cancel all pending approval timeouts (used during shutdown). */
  cancelAll(): void {
    for (const [, pending] of this.pendingMessages) {
      clearTimeout(pending.timer);
    }
    this.pendingMessages.clear();
  }
}
