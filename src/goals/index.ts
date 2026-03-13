/**
 * Goals module barrel export — Phase 29.
 *
 * Provides lazy initialization pattern for GoalStore, GoalApprovalManager,
 * and GoalEvaluator. Consistent with how SchedulerEngine and
 * ScheduleApprovalManager are wired in src/scheduler/.
 */

export { GoalStore } from './store.js';
export { GoalApprovalManager } from './approvals.js';
export { GoalEvaluator } from './evaluator.js';
export { setGoalEvaluator, getGoalEvaluator } from './evaluator-ref.js';
export { activatePendingPlan, setGoalAgentStore } from './tools.js';
export type {
  Goal,
  GoalRelation,
  GoalTask,
  GoalEvaluation,
  CreateGoalOpts,
  UpdateGoalOpts,
  GoalStatus,
} from './types.js';

import type { GoalStore } from './store.js';
import type { GoalApprovalManager } from './approvals.js';

// ── Lazy references (set in index.ts after construction) ───────────

let _store: GoalStore | null = null;
let _approvalManager: GoalApprovalManager | null = null;

export function setGoalStore(store: GoalStore): void {
  _store = store;
}

export function getGoalStore(): GoalStore {
  if (!_store) throw new Error('GoalStore not initialized — call setGoalStore() first');
  return _store;
}

export function setGoalApprovalManager(manager: GoalApprovalManager): void {
  _approvalManager = manager;
}

export function getGoalApprovalManager(): GoalApprovalManager | null {
  return _approvalManager;
}

// ── Import tool registration (side-effect: registers goal tools) ──
import './tools.js';
