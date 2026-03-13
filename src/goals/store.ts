/**
 * GoalStore — SQLite persistence for the goal persistence system.
 *
 * Handles schema creation, CRUD, and query operations for the
 * goals, goal_relations, goal_tasks, and goal_evaluations tables.
 * Follows the same patterns as SchedulerStore.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  Goal,
  GoalRow,
  GoalRelation,
  GoalRelationRow,
  GoalTask,
  GoalTaskRow,
  GoalEvaluation,
  GoalEvaluationRow,
  GoalStatus,
  CreateGoalOpts,
  UpdateGoalOpts,
  SuccessCriteria,
  SafetyConstraints,
  RelationType,
} from './types.js';

// ── Constants ──────────────────────────────────────────────────────

const MAX_ACTIVE_GOALS = 10;
const DEFAULT_ACTION_BUDGET = 100;
const DEFAULT_REVIEW_CADENCE_HOURS = 24;

// ── Row → Domain mapping ──────────────────────────────────────────

function rowToGoal(row: GoalRow): Goal {
  return {
    goalId: row.goal_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status as GoalStatus,
    successCriteria: row.success_criteria ? JSON.parse(row.success_criteria) as SuccessCriteria : null,
    safetyConstraints: row.safety_constraints ? JSON.parse(row.safety_constraints) as SafetyConstraints : null,
    actionBudget: row.action_budget,
    actionsSpent: row.actions_spent,
    reviewCadenceHours: row.review_cadence_hours,
    deadline: row.deadline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    approvalToken: row.approval_token,
  };
}

function rowToRelation(row: GoalRelationRow): GoalRelation {
  return {
    parentGoalId: row.parent_goal_id,
    childGoalId: row.child_goal_id,
    relationType: row.relation_type as RelationType,
  };
}

function rowToTask(row: GoalTaskRow): GoalTask {
  return {
    taskId: row.task_id,
    goalId: row.goal_id,
    scheduledJobId: row.scheduled_job_id,
    toolName: row.tool_name,
    toolParams: row.tool_params ? JSON.parse(row.tool_params) as Record<string, unknown> : null,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
  };
}

function rowToEvaluation(row: GoalEvaluationRow): GoalEvaluation {
  return {
    evalId: row.eval_id,
    goalId: row.goal_id,
    timestamp: row.timestamp,
    progressScore: row.progress_score,
    evidence: row.evidence,
    isConverging: row.is_converging === 1,
  };
}

// ── GoalStore ─────────────────────────────────────────────────────

export class GoalStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  // ── Schema ────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        goal_id              TEXT    PRIMARY KEY,
        title                TEXT    NOT NULL,
        description          TEXT    NOT NULL,
        priority             INTEGER NOT NULL DEFAULT 1,
        status               TEXT    NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'active', 'completed', 'abandoned', 'paused')),
        success_criteria     TEXT,
        safety_constraints   TEXT,
        action_budget        INTEGER NOT NULL DEFAULT ${DEFAULT_ACTION_BUDGET},
        actions_spent        INTEGER NOT NULL DEFAULT 0,
        review_cadence_hours INTEGER NOT NULL DEFAULT ${DEFAULT_REVIEW_CADENCE_HOURS},
        deadline             TEXT,
        created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT,
        completed_at         TEXT,
        approval_token       TEXT
      );

      CREATE TABLE IF NOT EXISTS goal_relations (
        parent_goal_id TEXT NOT NULL,
        child_goal_id  TEXT NOT NULL,
        relation_type  TEXT NOT NULL CHECK (relation_type IN ('decomposition', 'dependency')),
        FOREIGN KEY(parent_goal_id) REFERENCES goals(goal_id),
        FOREIGN KEY(child_goal_id) REFERENCES goals(goal_id),
        PRIMARY KEY(parent_goal_id, child_goal_id)
      );

      CREATE TABLE IF NOT EXISTS goal_tasks (
        task_id          TEXT PRIMARY KEY,
        goal_id          TEXT NOT NULL,
        scheduled_job_id TEXT,
        tool_name        TEXT,
        tool_params      TEXT,
        last_run_at      TEXT,
        last_status      TEXT,
        FOREIGN KEY(goal_id) REFERENCES goals(goal_id)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_tasks_goal
        ON goal_tasks(goal_id);

      CREATE INDEX IF NOT EXISTS idx_goal_tasks_job
        ON goal_tasks(scheduled_job_id) WHERE scheduled_job_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS goal_evaluations (
        eval_id        INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id        TEXT    NOT NULL,
        timestamp      TEXT    NOT NULL DEFAULT (datetime('now')),
        progress_score REAL   NOT NULL,
        evidence       TEXT   NOT NULL,
        is_converging  INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(goal_id) REFERENCES goals(goal_id)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_evaluations_goal
        ON goal_evaluations(goal_id, timestamp);
    `);
  }

  // ══════════════════════════════════════════════════════════════
  // Goals CRUD
  // ══════════════════════════════════════════════════════════════

  // ── Create ──────────────────────────────────────────────────

  createGoal(opts: CreateGoalOpts): Goal {
    const activeCount = this.getActiveGoalCount();
    if (activeCount >= MAX_ACTIVE_GOALS) {
      throw new Error(`Maximum active goals reached (${MAX_ACTIVE_GOALS}). Complete or abandon existing goals first.`);
    }

    const goalId = randomUUID();
    const approvalToken = randomUUID();

    this.db.prepare(`
      INSERT INTO goals (
        goal_id, title, description, priority, status,
        success_criteria, safety_constraints,
        action_budget, review_cadence_hours, deadline,
        approval_token
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      goalId,
      opts.title,
      opts.description,
      opts.priority ?? 1,
      opts.successCriteria ? JSON.stringify(opts.successCriteria) : null,
      opts.safetyConstraints ? JSON.stringify(opts.safetyConstraints) : null,
      opts.actionBudget ?? DEFAULT_ACTION_BUDGET,
      opts.reviewCadenceHours ?? DEFAULT_REVIEW_CADENCE_HOURS,
      opts.deadline ?? null,
      approvalToken,
    );

    return this.getGoal(goalId)!;
  }

  // ── Read ────────────────────────────────────────────────────

  getGoal(goalId: string): Goal | null {
    const row = this.db
      .prepare('SELECT * FROM goals WHERE goal_id = ?')
      .get(goalId) as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  listGoals(filter?: { status?: GoalStatus }): Goal[] {
    let sql = 'SELECT * FROM goals WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }

    sql += ' ORDER BY priority DESC, created_at ASC';

    const rows = this.db.prepare(sql).all(...params) as GoalRow[];
    return rows.map(rowToGoal);
  }

  getActiveGoalCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM goals WHERE status IN ('pending', 'active')")
      .get() as { count: number };
    return row.count;
  }

  // ── Update ──────────────────────────────────────────────────

  updateGoal(goalId: string, opts: UpdateGoalOpts): Goal | null {
    const existing = this.getGoal(goalId);
    if (!existing) return null;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (opts.title !== undefined) {
      sets.push('title = ?');
      params.push(opts.title);
    }
    if (opts.description !== undefined) {
      sets.push('description = ?');
      params.push(opts.description);
    }
    if (opts.priority !== undefined) {
      sets.push('priority = ?');
      params.push(opts.priority);
    }
    if (opts.status !== undefined) {
      sets.push('status = ?');
      params.push(opts.status);
      if (opts.status === 'completed' || opts.status === 'abandoned') {
        sets.push("completed_at = datetime('now')");
      }
    }
    if (opts.successCriteria !== undefined) {
      sets.push('success_criteria = ?');
      params.push(JSON.stringify(opts.successCriteria));
    }
    if (opts.safetyConstraints !== undefined) {
      sets.push('safety_constraints = ?');
      params.push(JSON.stringify(opts.safetyConstraints));
    }
    if (opts.actionBudget !== undefined) {
      sets.push('action_budget = ?');
      params.push(opts.actionBudget);
    }
    if (opts.reviewCadenceHours !== undefined) {
      sets.push('review_cadence_hours = ?');
      params.push(opts.reviewCadenceHours);
    }
    if (opts.deadline !== undefined) {
      sets.push('deadline = ?');
      params.push(opts.deadline);
    }

    if (sets.length === 0) return existing;

    sets.push("updated_at = datetime('now')");
    params.push(goalId);

    this.db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE goal_id = ?`).run(...params);
    return this.getGoal(goalId);
  }

  activateGoal(goalId: string): Goal | null {
    return this.updateGoal(goalId, { status: 'active' });
  }

  pauseGoal(goalId: string): Goal | null {
    return this.updateGoal(goalId, { status: 'paused' });
  }

  incrementActionsSpent(goalId: string, count: number = 1): Goal | null {
    this.db.prepare(`
      UPDATE goals
      SET actions_spent = actions_spent + ?, updated_at = datetime('now')
      WHERE goal_id = ?
    `).run(count, goalId);
    return this.getGoal(goalId);
  }

  // ── Delete ──────────────────────────────────────────────────

  removeGoal(goalId: string): boolean {
    // Remove related data first
    this.db.prepare('DELETE FROM goal_evaluations WHERE goal_id = ?').run(goalId);
    this.db.prepare('DELETE FROM goal_tasks WHERE goal_id = ?').run(goalId);
    this.db.prepare('DELETE FROM goal_relations WHERE parent_goal_id = ? OR child_goal_id = ?').run(goalId, goalId);
    const result = this.db.prepare('DELETE FROM goals WHERE goal_id = ?').run(goalId);
    return result.changes > 0;
  }

  // ══════════════════════════════════════════════════════════════
  // Goal Relations
  // ══════════════════════════════════════════════════════════════

  addRelation(parentGoalId: string, childGoalId: string, relationType: RelationType): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO goal_relations (parent_goal_id, child_goal_id, relation_type)
      VALUES (?, ?, ?)
    `).run(parentGoalId, childGoalId, relationType);
  }

  getChildGoals(parentGoalId: string): GoalRelation[] {
    const rows = this.db
      .prepare('SELECT * FROM goal_relations WHERE parent_goal_id = ?')
      .all(parentGoalId) as GoalRelationRow[];
    return rows.map(rowToRelation);
  }

  getParentGoals(childGoalId: string): GoalRelation[] {
    const rows = this.db
      .prepare('SELECT * FROM goal_relations WHERE child_goal_id = ?')
      .all(childGoalId) as GoalRelationRow[];
    return rows.map(rowToRelation);
  }

  // ══════════════════════════════════════════════════════════════
  // Goal Tasks
  // ══════════════════════════════════════════════════════════════

  addGoalTask(opts: {
    goalId: string;
    scheduledJobId?: string;
    toolName?: string;
    toolParams?: Record<string, unknown>;
  }): GoalTask {
    const taskId = randomUUID();

    this.db.prepare(`
      INSERT INTO goal_tasks (task_id, goal_id, scheduled_job_id, tool_name, tool_params)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      taskId,
      opts.goalId,
      opts.scheduledJobId ?? null,
      opts.toolName ?? null,
      opts.toolParams ? JSON.stringify(opts.toolParams) : null,
    );

    return this.getGoalTask(taskId)!;
  }

  getGoalTask(taskId: string): GoalTask | null {
    const row = this.db
      .prepare('SELECT * FROM goal_tasks WHERE task_id = ?')
      .get(taskId) as GoalTaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  getGoalTasks(goalId: string): GoalTask[] {
    const rows = this.db
      .prepare('SELECT * FROM goal_tasks WHERE goal_id = ?')
      .all(goalId) as GoalTaskRow[];
    return rows.map(rowToTask);
  }

  updateGoalTaskStatus(taskId: string, status: string): void {
    this.db.prepare(`
      UPDATE goal_tasks
      SET last_status = ?, last_run_at = datetime('now')
      WHERE task_id = ?
    `).run(status, taskId);
  }

  linkScheduledJob(taskId: string, scheduledJobId: string): void {
    this.db.prepare(
      'UPDATE goal_tasks SET scheduled_job_id = ? WHERE task_id = ?'
    ).run(scheduledJobId, taskId);
  }

  removeGoalTask(taskId: string): boolean {
    const result = this.db.prepare('DELETE FROM goal_tasks WHERE task_id = ?').run(taskId);
    return result.changes > 0;
  }

  // ══════════════════════════════════════════════════════════════
  // Goal Evaluations
  // ══════════════════════════════════════════════════════════════

  addEvaluation(opts: {
    goalId: string;
    progressScore: number;
    evidence: string;
    isConverging: boolean;
  }): GoalEvaluation {
    const result = this.db.prepare(`
      INSERT INTO goal_evaluations (goal_id, progress_score, evidence, is_converging)
      VALUES (?, ?, ?, ?)
    `).run(opts.goalId, opts.progressScore, opts.evidence, opts.isConverging ? 1 : 0);

    return this.getEvaluation(Number(result.lastInsertRowid))!;
  }

  getEvaluation(evalId: number): GoalEvaluation | null {
    const row = this.db
      .prepare('SELECT * FROM goal_evaluations WHERE eval_id = ?')
      .get(evalId) as GoalEvaluationRow | undefined;
    return row ? rowToEvaluation(row) : null;
  }

  getRecentEvaluations(goalId: string, limit: number = 10): GoalEvaluation[] {
    const rows = this.db
      .prepare('SELECT * FROM goal_evaluations WHERE goal_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(goalId, limit) as GoalEvaluationRow[];
    return rows.map(rowToEvaluation);
  }

  /**
   * Check if a goal's recent evaluations show convergence.
   * Returns null if no evaluations exist.
   */
  isConverging(goalId: string, lookback: number = 3): boolean | null {
    const evals = this.getRecentEvaluations(goalId, lookback);
    if (evals.length === 0) return null;
    // Majority vote on recent convergence signals
    const convergingCount = evals.filter((e) => e.isConverging).length;
    return convergingCount > evals.length / 2;
  }

  /**
   * Count consecutive non-converging evaluations.
   * Used for anti-thrashing: 3 consecutive → trigger plan revision.
   */
  getConsecutiveNonConverging(goalId: string): number {
    const evals = this.getRecentEvaluations(goalId, 10);
    let count = 0;
    for (const e of evals) {
      if (!e.isConverging) count++;
      else break;
    }
    return count;
  }

  /**
   * Get the latest evaluation for a goal.
   */
  getLatestEvaluation(goalId: string): GoalEvaluation | null {
    const row = this.db
      .prepare('SELECT * FROM goal_evaluations WHERE goal_id = ? ORDER BY timestamp DESC LIMIT 1')
      .get(goalId) as GoalEvaluationRow | undefined;
    return row ? rowToEvaluation(row) : null;
  }

  // ══════════════════════════════════════════════════════════════
  // Budget Checks
  // ══════════════════════════════════════════════════════════════

  /**
   * Check if a goal has exhausted its action budget.
   */
  isBudgetExhausted(goalId: string): boolean {
    const goal = this.getGoal(goalId);
    if (!goal) return true;
    return goal.actionsSpent >= goal.actionBudget;
  }

  /**
   * Get goals that need periodic evaluation (active goals whose
   * last evaluation is older than their review cadence).
   */
  getGoalsNeedingEvaluation(): Goal[] {
    const rows = this.db.prepare(`
      SELECT g.* FROM goals g
      WHERE g.status = 'active'
        AND (
          NOT EXISTS (
            SELECT 1 FROM goal_evaluations e
            WHERE e.goal_id = g.goal_id
          )
          OR (
            SELECT MAX(e.timestamp) FROM goal_evaluations e
            WHERE e.goal_id = g.goal_id
          ) < datetime('now', '-' || g.review_cadence_hours || ' hours')
        )
    `).all() as GoalRow[];
    return rows.map(rowToGoal);
  }
}
