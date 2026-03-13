/**
 * GoalEvaluator — periodic convergence scoring for active goals.
 *
 * Runs at each goal's review_cadence_hours interval. Uses a cheap LLM call
 * to assess progress against success criteria. Implements anti-thrashing
 * hysteresis to prevent circular replanning.
 *
 * Integrates with the scheduler (Phase 28) for periodic evaluation jobs
 * and with the goal approval system for plan revision requests.
 */

import type { LLMRouter } from '../llm/router.js';
import type { LLMMessage } from '../llm/types.js';
import type { AgentStore } from '../memory/store.js';
import type { GoalStore } from './store.js';
import type { Goal, GoalEvaluation } from './types.js';

// ── Constants ──────────────────────────────────────────────────────

/** After this many consecutive non-converging evaluations, trigger plan revision. */
const PLAN_REVISION_THRESHOLD = 3;

/** Minimum improvement needed to justify a plan change (anti-thrashing). */
const STABILITY_DELTA = 0.15;

// ── Evaluation prompt ─────────────────────────────────────────────

const EVAL_SYSTEM_PROMPT = `You evaluate goal progress for an AI assistant named Agent.

Given a goal and its recent history, assess:
1. Progress score (0.0 to 1.0) — how close to completion
2. Whether progress is converging (trending toward success) or diverging
3. Brief evidence supporting your assessment

Output a JSON object with exactly these fields:
{
  "progress_score": 0.0-1.0,
  "is_converging": true/false,
  "evidence": "brief explanation"
}

Rules:
- Be honest — if there's no evidence of progress, score low
- Consider both quantitative metrics and qualitative signals
- A score of 1.0 means success criteria are fully met
- "is_converging" means the trend is positive, even if score is low
- Return ONLY the JSON object, no other text`;

// ── GoalEvaluator ─────────────────────────────────────────────────

export interface GoalEvaluatorOptions {
  store: GoalStore;
  agentStore: AgentStore;
  router: LLMRouter;
  notifyCallback: (message: string) => Promise<void>;
}

export class GoalEvaluator {
  private store: GoalStore;
  private agentStore: AgentStore;
  private router: LLMRouter;
  private notifyCallback: (message: string) => Promise<void>;

  constructor(opts: GoalEvaluatorOptions) {
    this.store = opts.store;
    this.agentStore = opts.agentStore;
    this.router = opts.router;
    this.notifyCallback = opts.notifyCallback;
  }

  /**
   * Evaluate a single goal's progress. Uses a cheap LLM call to assess
   * convergence based on success criteria and recent task results.
   *
   * Called both on schedule (periodic) and on-demand (via evaluate_goal tool).
   */
  async evaluateGoal(goal: Goal): Promise<GoalEvaluation | null> {
    try {
      // Gather context for the evaluation
      const tasks = this.store.getGoalTasks(goal.goalId);
      const recentEvals = this.store.getRecentEvaluations(goal.goalId, 5);

      const taskSummary = tasks.length > 0
        ? tasks.map((t) =>
            `- ${t.toolName ?? 'unknown'}: ${t.lastStatus ?? 'not run'}${t.lastRunAt ? ` (${t.lastRunAt})` : ''}`
          ).join('\n')
        : 'No tasks linked yet';

      const evalHistory = recentEvals.length > 0
        ? recentEvals.map((e) =>
            `- ${e.timestamp}: score=${e.progressScore.toFixed(2)}, converging=${e.isConverging}, evidence: ${e.evidence.slice(0, 100)}`
          ).join('\n')
        : 'No prior evaluations';

      const criteria = goal.successCriteria
        ? `Target: ${goal.successCriteria.target}${goal.successCriteria.kpi ? `, KPI: ${goal.successCriteria.kpi}` : ''}${goal.successCriteria.baseline ? `, Baseline: ${goal.successCriteria.baseline}` : ''}`
        : 'No specific success criteria defined';

      const prompt =
        `Goal: ${goal.title}\n` +
        `Description: ${goal.description}\n` +
        `Success criteria: ${criteria}\n` +
        `Actions spent: ${goal.actionsSpent}/${goal.actionBudget}\n` +
        `Deadline: ${goal.deadline ?? 'none'}\n\n` +
        `Task results:\n${taskSummary}\n\n` +
        `Evaluation history:\n${evalHistory}`;

      const messages: LLMMessage[] = [
        { role: 'user', content: prompt },
      ];

      const response = await this.router.call(messages, EVAL_SYSTEM_PROMPT, [], { tier: 'cheap' });

      const responseText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      const parsed = this.parseEvaluation(responseText);
      if (!parsed) {
        console.error('[goal-eval] Failed to parse evaluation response');
        return null;
      }

      // Store the evaluation
      const evaluation = this.store.addEvaluation({
        goalId: goal.goalId,
        progressScore: parsed.progressScore,
        evidence: parsed.evidence,
        isConverging: parsed.isConverging,
      });

      // Store evaluation as a memory fact for vector search
      // So future conversations can surface goal context via "How's my X going?"
      this.agentStore.addFact(
        `[goal_eval] Goal "${goal.title}": progress=${parsed.progressScore.toFixed(2)}, converging=${parsed.isConverging}. ${parsed.evidence}`,
        'goal-evaluator',
      );

      // Check for auto-actions
      await this.handlePostEvaluation(goal, evaluation);

      return evaluation;
    } catch (err) {
      console.error('[goal-eval] Evaluation failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * Run evaluations for all goals that are due.
   * Called by the scheduler engine on a periodic basis.
   */
  async evaluateDueGoals(): Promise<void> {
    const goals = this.store.getGoalsNeedingEvaluation();
    if (goals.length === 0) return;

    console.log(`[goal-eval] Evaluating ${goals.length} goal(s)`);

    for (const goal of goals) {
      await this.evaluateGoal(goal);
    }
  }

  // ── Post-evaluation actions ───────────────────────────────────

  /**
   * Handle automatic actions after an evaluation:
   * - Budget exhaustion → auto-pause + notify
   * - Success → propose completion
   * - Consecutive non-convergence → trigger plan revision request
   */
  private async handlePostEvaluation(goal: Goal, evaluation: GoalEvaluation): Promise<void> {
    // Check for success
    if (evaluation.progressScore >= 0.95) {
      await this.notifyCallback(
        `Goal "${goal.title}" appears to be achieved (score: ${evaluation.progressScore.toFixed(2)}).\n\n` +
        `Evidence: ${evaluation.evidence}\n\n` +
        `Use the complete_goal tool to mark it as completed, or continue tracking.`,
      );
      return;
    }

    // Check budget exhaustion
    if (this.store.isBudgetExhausted(goal.goalId)) {
      this.store.pauseGoal(goal.goalId);
      await this.notifyCallback(
        `Goal "${goal.title}" has been auto-paused — action budget exhausted ` +
        `(${goal.actionsSpent}/${goal.actionBudget} actions used without measurable progress).\n\n` +
        `Want me to try a different approach or shelve this?`,
      );
      return;
    }

    // Check for anti-thrashing: consecutive non-converging evaluations
    const consecutiveNonConverging = this.store.getConsecutiveNonConverging(goal.goalId);
    if (consecutiveNonConverging >= PLAN_REVISION_THRESHOLD) {
      await this.notifyCallback(
        `Goal "${goal.title}" has had ${consecutiveNonConverging} consecutive evaluations ` +
        `showing no convergence.\n\n` +
        `Latest: ${evaluation.evidence}\n\n` +
        `The current approach may not be working. Should I revise the plan, ` +
        `adjust the approach, or pause this goal?`,
      );
    }
  }

  // ── Response parsing ──────────────────────────────────────────

  private parseEvaluation(raw: string): {
    progressScore: number;
    isConverging: boolean;
    evidence: string;
  } | null {
    try {
      let cleaned = raw.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      cleaned = cleaned.trim();

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      const progressScore = Number(parsed.progress_score);
      if (isNaN(progressScore) || progressScore < 0 || progressScore > 1) return null;

      const isConverging = Boolean(parsed.is_converging);
      const evidence = typeof parsed.evidence === 'string' ? parsed.evidence : 'No evidence provided';

      return { progressScore, isConverging, evidence };
    } catch {
      console.error('[goal-eval] Failed to parse evaluation:', raw.slice(0, 200));
      return null;
    }
  }

  /**
   * Check anti-thrashing hysteresis: only recommend a plan change
   * if the new approach is meaningfully better than the current one.
   */
  shouldChangePlan(
    currentScore: number,
    proposedScore: number,
  ): boolean {
    return proposedScore > currentScore + STABILITY_DELTA;
  }
}
