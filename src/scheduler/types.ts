/**
 * Self-Scheduling types — Phase 28.
 *
 * Defines the ScheduledJob shape and related enums for the agent-managed
 * cron/interval/one-shot scheduling system.
 */

// ── Schedule Types ─────────────────────────────────────────────────

export type ScheduleType = 'at' | 'every' | 'cron';
export type PayloadMode = 'systemEvent' | 'agentTurn';
export type DeliveryMode = 'none' | 'announce' | 'webhook';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type JobStatus = 'active' | 'paused' | 'disabled' | 'completed';

// ── ScheduledJob ───────────────────────────────────────────────────

export interface ScheduledJob {
  jobId: string;
  name: string;
  scheduleType: ScheduleType;
  scheduleExpr: string;           // ISO-8601, ms interval, or cron expression
  timezone: string;
  payloadMode: PayloadMode;
  payloadPrompt: string;          // what the agent should do
  deliveryMode: DeliveryMode;
  deliveryTarget: string | null;  // session ID or webhook URL
  enabled: boolean;
  status: JobStatus;
  goalId: string | null;          // FK to Phase 29 goals table (nullable)
  nextRunAt: number;              // epoch ms
  lastRunAt: number | null;
  lastStatus: string | null;
  consecutiveErrors: number;
  maxConsecutiveErrors: number;
  approvalStatus: ApprovalStatus;
  source: 'agent' | 'system';    // system = migrated monitors (pre-approved)
  createdAt: string;
}

// ── Create / Update DTOs ───────────────────────────────────────────

export interface CreateJobOpts {
  name: string;
  scheduleType: ScheduleType;
  scheduleExpr: string;
  timezone?: string;
  payloadMode?: PayloadMode;
  payloadPrompt: string;
  deliveryMode?: DeliveryMode;
  deliveryTarget?: string;
  goalId?: string;
  source?: 'agent' | 'system';
  maxConsecutiveErrors?: number;
}

export interface UpdateJobOpts {
  name?: string;
  scheduleExpr?: string;
  payloadPrompt?: string;
  deliveryMode?: DeliveryMode;
  deliveryTarget?: string;
  enabled?: boolean;
  maxConsecutiveErrors?: number;
}

// ── SQLite Row Shape ───────────────────────────────────────────────

export interface ScheduledJobRow {
  job_id: string;
  name: string;
  schedule_type: string;
  schedule_expr: string;
  timezone: string;
  payload_mode: string;
  payload_prompt: string;
  delivery_mode: string;
  delivery_target: string | null;
  enabled: number;
  status: string;
  goal_id: string | null;
  next_run_at: number;
  last_run_at: number | null;
  last_status: string | null;
  consecutive_errors: number;
  max_consecutive_errors: number;
  approval_status: string;
  source: string;
  created_at: string;
}
