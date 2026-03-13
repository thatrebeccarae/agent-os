/**
 * Goal tools — lets Agent create, manage, decompose, and evaluate goals.
 *
 * 6 tools:
 *   create_goal     — extract objective from conversation, create in 'pending' status
 *   list_goals      — show active goals with latest convergence scores
 *   update_goal     — modify goal details, pause/resume, adjust budget
 *   complete_goal   — mark goal as completed or abandoned
 *   decompose_goal  — break goal into scheduled actions (triggers plan approval)
 *   evaluate_goal   — run on-demand convergence check
 */

import { register } from '../agent/tools.js';
import { getGoalStore, getGoalApprovalManager } from './index.js';
import { getGoalEvaluator } from './evaluator-ref.js';
import { getSchedulerEngine } from '../scheduler/index.js';
import type { GoalStatus } from './types.js';

// ══════════════════════════════════════════════════════════════════
// create_goal
// ══════════════════════════════════════════════════════════════════

register({
  name: 'create_goal',
  description:
    'Create a new goal for Agent to pursue. Goals represent persistent objectives ' +
    'that Agent tracks across conversations. New goals enter "pending" status and ' +
    'require operator approval before becoming active.\n\n' +
    'Provide clear success criteria so progress can be measured. Optional safety ' +
    'constraints limit what actions can be taken (e.g., "max_follows_per_day": 10).',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short, descriptive goal title',
      },
      description: {
        type: 'string',
        description: 'Detailed description of what to achieve and why',
      },
      success_target: {
        type: 'string',
        description: 'What success looks like — the measurable end state',
      },
      success_kpi: {
        type: 'string',
        description: 'Key performance indicator to track (optional)',
      },
      success_baseline: {
        type: 'string',
        description: 'Current starting state (optional)',
      },
      safety_constraints: {
        type: 'object',
        description: 'Per-goal limits, e.g., {"max_follows_per_day": 10, "no_dms": true}',
      },
      action_budget: {
        type: 'number',
        description: 'Maximum actions before auto-pause (default: 100)',
      },
      review_cadence_hours: {
        type: 'number',
        description: 'Hours between automatic progress evaluations (default: 24)',
      },
      deadline: {
        type: 'string',
        description: 'ISO-8601 deadline (optional)',
      },
      priority: {
        type: 'number',
        description: 'Priority level, higher = more important (default: 1)',
      },
    },
    required: ['title', 'description', 'success_target'],
  },
  handler: async (input) => {
    const store = getGoalStore();

    const title = input.title as string;
    const description = input.description as string;
    const successTarget = input.success_target as string;

    try {
      const goal = store.createGoal({
        title,
        description,
        priority: (input.priority as number | undefined) ?? 1,
        successCriteria: {
          target: successTarget,
          kpi: input.success_kpi as string | undefined,
          baseline: input.success_baseline as string | undefined,
        },
        safetyConstraints: input.safety_constraints as Record<string, string | number | boolean> | undefined,
        actionBudget: input.action_budget as number | undefined,
        reviewCadenceHours: input.review_cadence_hours as number | undefined,
        deadline: input.deadline as string | undefined,
      });

      // Store as memory fact for vector search
      if (_agentStore) {
        _agentStore.addFact(
          `[goal_created] "${title}": ${description}. Target: ${successTarget}`,
          'goal-system',
        );
      }

      // Send approval request (Gate 1)
      const approvalMgr = getGoalApprovalManager();
      if (approvalMgr) {
        void approvalMgr.requestGoalApproval(goal.goalId);
      }

      return (
        `Goal created — awaiting operator approval.\n\n` +
        `ID: ${goal.goalId}\n` +
        `Title: ${goal.title}\n` +
        `Status: ${goal.status}\n` +
        `Success target: ${successTarget}\n` +
        `Action budget: ${goal.actionBudget}\n` +
        `Review cadence: every ${goal.reviewCadenceHours}h\n\n` +
        `The operator has been sent an approval request via Telegram.`
      );
    } catch (err) {
      return `Error creating goal: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ══════════════════════════════════════════════════════════════════
// list_goals
// ══════════════════════════════════════════════════════════════════

register({
  name: 'list_goals',
  description:
    'List all goals with their current status, latest convergence scores, and progress summaries. ' +
    'Optionally filter by status (pending, active, completed, abandoned, paused).',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'active', 'completed', 'abandoned', 'paused'],
        description: 'Filter by status (optional — shows all if omitted)',
      },
    },
  },
  handler: async (input) => {
    const store = getGoalStore();
    const status = input.status as GoalStatus | undefined;

    const goals = store.listGoals(status ? { status } : undefined);
    if (goals.length === 0) {
      return status ? `No ${status} goals.` : 'No goals.';
    }

    const lines = goals.map((g) => {
      const latestEval = store.getLatestEvaluation(g.goalId);
      const evalStr = latestEval
        ? `Score: ${latestEval.progressScore.toFixed(2)}, converging: ${latestEval.isConverging ? 'yes' : 'no'}`
        : 'Not evaluated yet';
      const budget = `${g.actionsSpent}/${g.actionBudget} actions`;
      const deadline = g.deadline ? `\n  Deadline: ${g.deadline}` : '';
      const target = g.successCriteria?.target
        ? `\n  Target: ${g.successCriteria.target}`
        : '';

      return (
        `• ${g.title} [${g.goalId.slice(0, 8)}]\n` +
        `  Status: ${g.status} | Priority: ${g.priority}\n` +
        `  Progress: ${evalStr}\n` +
        `  Budget: ${budget}` +
        target +
        deadline
      );
    });

    return `Goals (${goals.length}):\n\n${lines.join('\n\n')}`;
  },
});

// ══════════════════════════════════════════════════════════════════
// update_goal
// ══════════════════════════════════════════════════════════════════

register({
  name: 'update_goal',
  description:
    'Modify an existing goal — change title, description, priority, budget, cadence, ' +
    'deadline, or status (pause/resume). Cannot change status to completed/abandoned ' +
    '(use complete_goal for that).',
  input_schema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'Goal ID' },
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'number' },
      action_budget: { type: 'number' },
      review_cadence_hours: { type: 'number' },
      deadline: { type: 'string', description: 'ISO-8601 deadline, or null to remove' },
      paused: { type: 'boolean', description: 'Set true to pause, false to resume' },
    },
    required: ['goal_id'],
  },
  handler: async (input) => {
    const store = getGoalStore();
    const goalId = input.goal_id as string;

    const existing = store.getGoal(goalId);
    if (!existing) return `Error: No goal found with ID ${goalId}`;

    let status: GoalStatus | undefined;
    if (input.paused === true) status = 'paused';
    else if (input.paused === false && existing.status === 'paused') status = 'active';

    const updated = store.updateGoal(goalId, {
      title: input.title as string | undefined,
      description: input.description as string | undefined,
      priority: input.priority as number | undefined,
      status,
      actionBudget: input.action_budget as number | undefined,
      reviewCadenceHours: input.review_cadence_hours as number | undefined,
      deadline: input.deadline as string | undefined,
    });

    if (!updated) return `Error: Failed to update goal ${goalId}`;

    return (
      `Goal updated.\n\n` +
      `ID: ${updated.goalId}\n` +
      `Title: ${updated.title}\n` +
      `Status: ${updated.status}\n` +
      `Priority: ${updated.priority}\n` +
      `Budget: ${updated.actionsSpent}/${updated.actionBudget}\n` +
      `Review cadence: every ${updated.reviewCadenceHours}h`
    );
  },
});

// ══════════════════════════════════════════════════════════════════
// complete_goal
// ══════════════════════════════════════════════════════════════════

register({
  name: 'complete_goal',
  description:
    'Mark a goal as completed (success) or abandoned (no longer worth pursuing). ' +
    'Provide a final assessment explaining why.',
  input_schema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'Goal ID' },
      outcome: {
        type: 'string',
        enum: ['completed', 'abandoned'],
        description: 'Whether the goal was achieved or abandoned',
      },
      final_assessment: {
        type: 'string',
        description: 'Final evaluation — why this goal succeeded or was abandoned',
      },
    },
    required: ['goal_id', 'outcome', 'final_assessment'],
  },
  handler: async (input) => {
    const store = getGoalStore();
    const goalId = input.goal_id as string;
    const outcome = input.outcome as 'completed' | 'abandoned';
    const assessment = input.final_assessment as string;

    const existing = store.getGoal(goalId);
    if (!existing) return `Error: No goal found with ID ${goalId}`;

    // Store final evaluation
    store.addEvaluation({
      goalId,
      progressScore: outcome === 'completed' ? 1.0 : 0.0,
      evidence: `[Final] ${assessment}`,
      isConverging: outcome === 'completed',
    });

    // Update status
    store.updateGoal(goalId, { status: outcome });

    // Store completion as memory fact for vector search
    if (_agentStore) {
      _agentStore.addFact(
        `[goal_${outcome}] "${existing.title}": ${assessment}`,
        'goal-system',
      );
    }

    // Disable any linked scheduled jobs
    const tasks = store.getGoalTasks(goalId);
    const schedulerEngine = getSchedulerEngine();
    const schedulerStore = schedulerEngine.getStore();
    let disabledJobs = 0;

    for (const task of tasks) {
      if (task.scheduledJobId) {
        const job = schedulerStore.getJob(task.scheduledJobId);
        if (job && job.enabled) {
          schedulerStore.updateJob(task.scheduledJobId, { enabled: false });
          disabledJobs++;
        }
      }
    }

    const jobNote = disabledJobs > 0
      ? `\n${disabledJobs} linked scheduled job(s) disabled.`
      : '';

    return (
      `Goal "${existing.title}" marked as ${outcome}.${jobNote}\n\n` +
      `Final assessment: ${assessment}`
    );
  },
});

// ══════════════════════════════════════════════════════════════════
// decompose_goal
// ══════════════════════════════════════════════════════════════════

register({
  name: 'decompose_goal',
  description:
    'Break an active goal into scheduled actions. Analyzes the goal against available ' +
    'tools and creates a plan of scheduled jobs to pursue it. The decomposed plan ' +
    'requires operator approval (Gate 2) before scheduled jobs begin executing.\n\n' +
    'Provide the planned actions as a JSON array of task objects.',
  input_schema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'Goal ID (must be active)' },
      tasks: {
        type: 'array',
        description: 'Array of planned tasks to schedule',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Task name (becomes scheduled job name)' },
            tool_name: { type: 'string', description: 'Tool to use' },
            prompt: { type: 'string', description: 'What the agent should do' },
            schedule_type: {
              type: 'string',
              enum: ['at', 'every', 'cron'],
              description: 'Schedule type',
            },
            schedule_expr: {
              type: 'string',
              description: 'Schedule expression (ISO-8601, ms interval, or cron)',
            },
          },
          required: ['name', 'prompt', 'schedule_type', 'schedule_expr'],
        },
      },
    },
    required: ['goal_id', 'tasks'],
  },
  handler: async (input, context) => {
    const store = getGoalStore();
    const goalId = input.goal_id as string;

    const goal = store.getGoal(goalId);
    if (!goal) return `Error: No goal found with ID ${goalId}`;
    if (goal.status !== 'active') {
      return `Error: Goal must be active to decompose. Current status: ${goal.status}`;
    }

    const tasks = input.tasks as Array<{
      name: string;
      tool_name?: string;
      prompt: string;
      schedule_type: string;
      schedule_expr: string;
    }>;

    if (!tasks || tasks.length === 0) {
      return 'Error: At least one task is required.';
    }

    // Create goal_tasks entries and collect IDs (jobs not yet created — pending plan approval)
    const createdTasks: string[] = [];
    const goalTaskIds: string[] = [];
    for (const t of tasks) {
      const goalTask = store.addGoalTask({
        goalId,
        toolName: t.tool_name,
      });
      goalTaskIds.push(goalTask.taskId);
      createdTasks.push(`• ${t.name} (${t.schedule_type}: ${t.schedule_expr}) → task ${goalTask.taskId.slice(0, 8)}`);
    }

    // Build plan summary for approval
    const planSummary = tasks.map((t) =>
      `• ${t.name}\n  Schedule: ${t.schedule_type} ${t.schedule_expr}\n  Action: ${t.prompt.slice(0, 100)}${t.prompt.length > 100 ? '...' : ''}`
    ).join('\n\n');

    // Persist plan data to SQLite so it survives restarts between
    // decomposition and approval. Keyed by goal ID.
    const planData = JSON.stringify({
      goalId,
      sessionId: context.sessionId,
      tasks: tasks.map((t, i) => ({
        ...t,
        goalTaskId: goalTaskIds[i],
      })),
    });

    savePendingPlan(goalId, planData);

    // Send plan approval request (Gate 2)
    const approvalMgr = getGoalApprovalManager();
    if (approvalMgr) {
      void approvalMgr.requestPlanApproval(goalId, planSummary);
    }

    return (
      `Goal decomposed into ${tasks.length} task(s) — awaiting plan approval.\n\n` +
      `Goal: ${goal.title}\n\n` +
      `Planned tasks:\n${createdTasks.join('\n')}\n\n` +
      `The operator has been sent a plan approval request via Telegram. ` +
      `Scheduled jobs will be created after approval.`
    );
  },
});

// ── Pending plan persistence (survives restarts) ──────────────────

import type { AgentStore } from '../memory/store.js';

const PLAN_KEY_PREFIX = 'goal_pending_plan:';

let _agentStore: AgentStore | null = null;

export function setGoalAgentStore(agentStore: AgentStore): void {
  _agentStore = agentStore;
}

function savePendingPlan(goalId: string, planJson: string): void {
  if (_agentStore) {
    _agentStore.setInboxState(`${PLAN_KEY_PREFIX}${goalId}`, planJson);
  } else {
    console.warn('[goals] AgentStore not set — pending plan stored in memory only');
  }
}

function loadPendingPlan(goalId: string): string | null {
  if (_agentStore) {
    return _agentStore.getInboxState(`${PLAN_KEY_PREFIX}${goalId}`);
  }
  return null;
}

function clearPendingPlan(goalId: string): void {
  if (_agentStore) {
    // Clear by setting to empty — inbox_state uses upsert
    _agentStore.setInboxState(`${PLAN_KEY_PREFIX}${goalId}`, '');
  }
}

/**
 * Called by the approval callback when a plan is approved.
 * Creates the scheduled jobs from the stored plan data.
 */
export async function activatePendingPlan(goalId: string): Promise<void> {
  const planJson = loadPendingPlan(goalId);
  if (!planJson) {
    console.warn(`[goals] No pending plan found for goal ${goalId}`);
    return;
  }

  clearPendingPlan(goalId);

  const plan = JSON.parse(planJson) as {
    goalId: string;
    sessionId?: string;
    tasks: Array<{
      name: string;
      tool_name?: string;
      prompt: string;
      schedule_type: string;
      schedule_expr: string;
      goalTaskId?: string;
    }>;
  };

  const store = getGoalStore();
  const schedulerEngine = getSchedulerEngine();
  const schedulerStore = schedulerEngine.getStore();

  for (const task of plan.tasks) {
    try {
      // Create scheduled job linked to this goal
      const job = schedulerStore.createJob({
        name: `[goal] ${task.name}`,
        scheduleType: task.schedule_type as 'at' | 'every' | 'cron',
        scheduleExpr: task.schedule_expr,
        payloadPrompt: task.prompt,
        deliveryMode: 'announce',
        deliveryTarget: plan.sessionId,
        goalId: plan.goalId,
        source: 'agent',
      });

      // The scheduler job is created as 'approved' since the plan was already approved
      schedulerStore.approveJob(job.jobId);

      // Link the scheduled job to the goal task
      if (task.goalTaskId) {
        store.linkScheduledJob(task.goalTaskId, job.jobId);
      }

      console.log(`[goals] Created scheduled job "${job.name}" for goal ${plan.goalId}`);
    } catch (err) {
      console.error(`[goals] Failed to create job "${task.name}":`, (err as Error).message);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// evaluate_goal
// ══════════════════════════════════════════════════════════════════

register({
  name: 'evaluate_goal',
  description:
    'Run an on-demand convergence check for a goal. Assesses progress against ' +
    'success criteria using recent task results and evaluation history. ' +
    'Also runs automatically at each goal\'s review_cadence_hours interval.',
  input_schema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'Goal ID' },
    },
    required: ['goal_id'],
  },
  handler: async (input) => {
    const store = getGoalStore();
    const goalId = input.goal_id as string;

    const goal = store.getGoal(goalId);
    if (!goal) return `Error: No goal found with ID ${goalId}`;

    const evaluator = getGoalEvaluator();
    if (!evaluator) {
      return 'Error: Goal evaluator not initialized.';
    }

    const evaluation = await evaluator.evaluateGoal(goal);
    if (!evaluation) {
      return 'Evaluation failed — see logs for details.';
    }

    const consecutiveNonConverging = store.getConsecutiveNonConverging(goalId);
    const budget = `${goal.actionsSpent}/${goal.actionBudget}`;

    return (
      `Evaluation for "${goal.title}":\n\n` +
      `Progress: ${(evaluation.progressScore * 100).toFixed(0)}%\n` +
      `Converging: ${evaluation.isConverging ? 'yes' : 'no'}\n` +
      `Evidence: ${evaluation.evidence}\n\n` +
      `Budget: ${budget} actions\n` +
      `Consecutive non-converging: ${consecutiveNonConverging}`
    );
  },
});
