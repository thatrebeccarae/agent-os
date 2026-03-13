/**
 * GoalApprovalManager — Telegram inline keyboard prompts for the
 * three-gate goal approval system.
 *
 * Gate 1: Goal Activation — operator confirms extracted goal is real
 * Gate 2: Plan Commitment — operator approves decomposed task list
 *
 * (Gate 3 is inherited from the existing tool approval system —
 *  high-stakes tools like email send, Twitter post, etc. require
 *  per-execution approval via claude-code/approvals.ts)
 *
 * Follows the same pattern as ScheduleApprovalManager.
 */

import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { GoalStore } from './store.js';

// ── Constants ──────────────────────────────────────────────────────

const APPROVAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours (goals are less time-sensitive)

// ── Callback data prefixes ────────────────────────────────────────

const GOAL_APPROVE_PREFIX = 'goal_approve:';
const GOAL_DENY_PREFIX = 'goal_deny:';
const PLAN_APPROVE_PREFIX = 'plan_approve:';
const PLAN_DENY_PREFIX = 'plan_deny:';

// ── Types ──────────────────────────────────────────────────────────

interface PendingApproval {
  messageId: number;
  timer: ReturnType<typeof setTimeout>;
  type: 'goal' | 'plan';
}

type ApprovalCallback = (goalId: string, approved: boolean, type: 'goal' | 'plan') => void;

// ── GoalApprovalManager ───────────────────────────────────────────

export class GoalApprovalManager {
  private bot: Bot;
  private ownerChatId: string;
  private store: GoalStore;
  private pendingApprovals = new Map<string, PendingApproval>();
  private onApprovalCallback: ApprovalCallback | null = null;

  constructor(bot: Bot, ownerChatId: string, store: GoalStore) {
    this.bot = bot;
    this.ownerChatId = ownerChatId;
    this.store = store;
  }

  /**
   * Register a callback for when approvals are resolved.
   * Used by the evaluation engine to activate goals after approval.
   */
  onApproval(callback: ApprovalCallback): void {
    this.onApprovalCallback = callback;
  }

  // ── Gate 1: Goal Activation ───────────────────────────────────

  /**
   * Send a goal activation approval request.
   * Called when a new goal is created via create_goal tool.
   */
  async requestGoalApproval(goalId: string): Promise<void> {
    const goal = this.store.getGoal(goalId);
    if (!goal) return;

    const keyboard = new InlineKeyboard()
      .text('Activate Goal', `${GOAL_APPROVE_PREFIX}${goalId}`)
      .text('Deny', `${GOAL_DENY_PREFIX}${goalId}`);

    const criteria = goal.successCriteria
      ? `\nSuccess criteria: ${goal.successCriteria.target}`
      : '';
    const deadline = goal.deadline
      ? `\nDeadline: ${goal.deadline}`
      : '';
    const budget = `\nAction budget: ${goal.actionBudget}`;

    const text =
      `New goal needs approval\n\n` +
      `Title: ${goal.title}\n` +
      `Description: ${goal.description.slice(0, 300)}${goal.description.length > 300 ? '...' : ''}` +
      criteria + deadline + budget;

    try {
      const message = await this.bot.api.sendMessage(
        this.ownerChatId,
        text,
        { reply_markup: keyboard },
      );

      const timer = setTimeout(() => {
        this.pendingApprovals.delete(goalId);
        void this.bot.api.editMessageText(
          this.ownerChatId,
          message.message_id,
          `[Timed out — still pending] ${text}`,
        ).catch(() => {});
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApprovals.set(goalId, {
        messageId: message.message_id,
        timer,
        type: 'goal',
      });
    } catch (err) {
      console.error('[goal-approval] Failed to send goal approval request:', err instanceof Error ? err.message : err);
    }
  }

  // ── Gate 2: Plan Commitment ───────────────────────────────────

  /**
   * Send a plan commitment approval request.
   * Called when decompose_goal produces a task list.
   */
  async requestPlanApproval(goalId: string, planSummary: string): Promise<void> {
    const goal = this.store.getGoal(goalId);
    if (!goal) return;

    const keyboard = new InlineKeyboard()
      .text('Approve Plan', `${PLAN_APPROVE_PREFIX}${goalId}`)
      .text('Deny Plan', `${PLAN_DENY_PREFIX}${goalId}`);

    const text =
      `Decomposed plan needs approval\n\n` +
      `Goal: ${goal.title}\n\n` +
      `Plan:\n${planSummary.slice(0, 500)}${planSummary.length > 500 ? '...' : ''}`;

    try {
      const message = await this.bot.api.sendMessage(
        this.ownerChatId,
        text,
        { reply_markup: keyboard },
      );

      // Use a plan-specific key to avoid collision with goal approval
      const key = `plan:${goalId}`;

      const timer = setTimeout(() => {
        this.pendingApprovals.delete(key);
        void this.bot.api.editMessageText(
          this.ownerChatId,
          message.message_id,
          `[Timed out — still pending] ${text}`,
        ).catch(() => {});
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApprovals.set(key, {
        messageId: message.message_id,
        timer,
        type: 'plan',
      });
    } catch (err) {
      console.error('[goal-approval] Failed to send plan approval request:', err instanceof Error ? err.message : err);
    }
  }

  // ── Callback Handler ──────────────────────────────────────────

  /**
   * Handle a callback query from Telegram inline keyboard.
   * Returns true if this callback was recognized (goal/plan prefix).
   */
  handleCallback(callbackData: string): boolean {
    let goalId: string | undefined;
    let approved: boolean;
    let type: 'goal' | 'plan';

    if (callbackData.startsWith(GOAL_APPROVE_PREFIX)) {
      goalId = callbackData.slice(GOAL_APPROVE_PREFIX.length);
      approved = true;
      type = 'goal';
    } else if (callbackData.startsWith(GOAL_DENY_PREFIX)) {
      goalId = callbackData.slice(GOAL_DENY_PREFIX.length);
      approved = false;
      type = 'goal';
    } else if (callbackData.startsWith(PLAN_APPROVE_PREFIX)) {
      goalId = callbackData.slice(PLAN_APPROVE_PREFIX.length);
      approved = true;
      type = 'plan';
    } else if (callbackData.startsWith(PLAN_DENY_PREFIX)) {
      goalId = callbackData.slice(PLAN_DENY_PREFIX.length);
      approved = false;
      type = 'plan';
    } else {
      return false;
    }

    // Clean up pending state
    const key = type === 'plan' ? `plan:${goalId}` : goalId;
    const pending = this.pendingApprovals.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(key);
    }

    // Update goal status based on approval
    if (type === 'goal') {
      if (approved) {
        this.store.activateGoal(goalId);
        if (pending) {
          void this.bot.api.editMessageText(
            this.ownerChatId,
            pending.messageId,
            `[Activated] Goal: ${this.store.getGoal(goalId)?.title ?? goalId}`,
          ).catch(() => {});
        }
        console.log(`[goal-approval] Goal "${goalId}" activated`);
      } else {
        this.store.updateGoal(goalId, { status: 'abandoned' });
        if (pending) {
          void this.bot.api.editMessageText(
            this.ownerChatId,
            pending.messageId,
            `[Denied] Goal: ${this.store.getGoal(goalId)?.title ?? goalId}`,
          ).catch(() => {});
        }
        console.log(`[goal-approval] Goal "${goalId}" denied`);
      }
    } else {
      // Plan approval
      const goal = this.store.getGoal(goalId);
      const label = goal?.title ?? goalId;
      if (approved) {
        if (pending) {
          void this.bot.api.editMessageText(
            this.ownerChatId,
            pending.messageId,
            `[Plan Approved] ${label} — scheduled tasks will begin executing`,
          ).catch(() => {});
        }
        console.log(`[goal-approval] Plan for goal "${goalId}" approved`);
      } else {
        // Pause the goal — plan was rejected, needs replanning
        this.store.pauseGoal(goalId);
        if (pending) {
          void this.bot.api.editMessageText(
            this.ownerChatId,
            pending.messageId,
            `[Plan Denied] ${label} — goal paused, needs replanning`,
          ).catch(() => {});
        }
        console.log(`[goal-approval] Plan for goal "${goalId}" denied — goal paused`);
      }
    }

    // Notify callback listeners
    this.onApprovalCallback?.(goalId, approved, type);

    return true;
  }

  /** Cancel all pending approval timeouts (used during shutdown). */
  cancelAll(): void {
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
    }
    this.pendingApprovals.clear();
  }
}
