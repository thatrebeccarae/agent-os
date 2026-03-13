/**
 * Goal Persistence types — Phase 29.
 *
 * Defines the Goal, GoalRelation, GoalTask, and GoalEvaluation shapes
 * for the hybrid BDI + HTN goal persistence system.
 */

// ── Goal Status ─────────────────────────────────────────────────

export type GoalStatus = 'pending' | 'active' | 'completed' | 'abandoned' | 'paused';

// ── Success Criteria ────────────────────────────────────────────

export interface SuccessCriteria {
  baseline?: string;       // starting state description
  target: string;          // desired end state
  kpi?: string;            // measurable indicator
  evalInterval?: string;   // how often to check (human-readable)
}

// ── Safety Constraints ──────────────────────────────────────────

export interface SafetyConstraints {
  [key: string]: string | number | boolean;
  // e.g., "max_follows_per_day": 10, "no_dms": true
}

// ── Goal ────────────────────────────────────────────────────────

export interface Goal {
  goalId: string;
  title: string;
  description: string;
  priority: number;
  status: GoalStatus;
  successCriteria: SuccessCriteria | null;
  safetyConstraints: SafetyConstraints | null;
  actionBudget: number;
  actionsSpent: number;
  reviewCadenceHours: number;
  deadline: string | null;        // ISO-8601
  createdAt: string;
  updatedAt: string | null;
  completedAt: string | null;
  approvalToken: string | null;   // links to operator's manual approval
}

// ── Goal Relations ──────────────────────────────────────────────

export type RelationType = 'decomposition' | 'dependency';

export interface GoalRelation {
  parentGoalId: string;
  childGoalId: string;
  relationType: RelationType;
}

// ── Goal Tasks (bridges Phase 28 scheduled_jobs) ────────────────

export interface GoalTask {
  taskId: string;
  goalId: string;
  scheduledJobId: string | null;  // FK to scheduled_jobs
  toolName: string | null;
  toolParams: Record<string, unknown> | null;
  lastRunAt: string | null;
  lastStatus: string | null;
}

// ── Goal Evaluations ────────────────────────────────────────────

export interface GoalEvaluation {
  evalId: number;
  goalId: string;
  timestamp: string;
  progressScore: number;          // 0.0 to 1.0
  evidence: string;               // reasoning for the score
  isConverging: boolean;          // trending toward success?
}

// ── Create / Update DTOs ────────────────────────────────────────

export interface CreateGoalOpts {
  title: string;
  description: string;
  priority?: number;
  successCriteria?: SuccessCriteria;
  safetyConstraints?: SafetyConstraints;
  actionBudget?: number;
  reviewCadenceHours?: number;
  deadline?: string;
}

export interface UpdateGoalOpts {
  title?: string;
  description?: string;
  priority?: number;
  status?: GoalStatus;
  successCriteria?: SuccessCriteria;
  safetyConstraints?: SafetyConstraints;
  actionBudget?: number;
  reviewCadenceHours?: number;
  deadline?: string | null;
}

// ── SQLite Row Shapes ───────────────────────────────────────────

export interface GoalRow {
  goal_id: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  success_criteria: string | null;
  safety_constraints: string | null;
  action_budget: number;
  actions_spent: number;
  review_cadence_hours: number;
  deadline: string | null;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
  approval_token: string | null;
}

export interface GoalRelationRow {
  parent_goal_id: string;
  child_goal_id: string;
  relation_type: string;
}

export interface GoalTaskRow {
  task_id: string;
  goal_id: string;
  scheduled_job_id: string | null;
  tool_name: string | null;
  tool_params: string | null;
  last_run_at: string | null;
  last_status: string | null;
}

export interface GoalEvaluationRow {
  eval_id: number;
  goal_id: string;
  timestamp: string;
  progress_score: number;
  evidence: string;
  is_converging: number;
}
