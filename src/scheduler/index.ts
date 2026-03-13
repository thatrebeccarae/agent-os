/**
 * Scheduler module barrel export.
 *
 * Provides lazy initialization pattern for the SchedulerEngine,
 * consistent with how TaskQueue and ClaudeCodeExecutor are wired.
 */

export { SchedulerStore } from './store.js';
export { SchedulerEngine } from './engine.js';
export { ScheduleApprovalManager } from './approvals.js';
export type { SchedulerEngineOptions } from './engine.js';
export type { ScheduledJob, CreateJobOpts, UpdateJobOpts } from './types.js';

import type { SchedulerEngine } from './engine.js';
import type { ScheduleApprovalManager } from './approvals.js';

// ── Lazy references (set in index.ts after construction) ───────────

let _engine: SchedulerEngine | null = null;
let _approvalManager: ScheduleApprovalManager | null = null;

export function setSchedulerEngine(engine: SchedulerEngine): void {
  _engine = engine;
}

export function getSchedulerEngine(): SchedulerEngine {
  if (!_engine) throw new Error('SchedulerEngine not initialized — call setSchedulerEngine() first');
  return _engine;
}

export function setScheduleApprovalManager(manager: ScheduleApprovalManager): void {
  _approvalManager = manager;
}

export function getScheduleApprovalManager(): ScheduleApprovalManager | null {
  return _approvalManager;
}

// ── Import tool registration (side-effect: registers the 'schedule' tool) ──
import './tool.js';
