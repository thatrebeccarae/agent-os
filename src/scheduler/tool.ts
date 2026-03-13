/**
 * Schedule tool — lets Agent create and manage her own recurring jobs.
 *
 * Actions: add, list, update, remove, run, status
 *
 * Agent-created jobs enter 'pending' approval status and must be
 * approved by the operator before they execute.
 */

import { register } from '../agent/tools.js';
import { getSchedulerEngine, getScheduleApprovalManager } from './index.js';
import { validateScheduleExpr, formatSchedule } from './schedule.js';
import type { ScheduleType, DeliveryMode } from './types.js';

// ── Register the tool ──────────────────────────────────────────────

register({
  name: 'schedule',
  description:
    'Create and manage recurring scheduled jobs. Jobs execute automatically on their schedule. ' +
    'New jobs require operator approval before they start running.\n\n' +
    'Actions:\n' +
    '- add: Create a new scheduled job\n' +
    '- list: Show all scheduled jobs\n' +
    '- update: Modify an existing job\n' +
    '- remove: Delete a job\n' +
    '- run: Manually trigger a job now\n' +
    '- status: Show scheduler engine status\n\n' +
    'Schedule types:\n' +
    '- "at": One-shot at ISO-8601 datetime (e.g., "2026-03-14T09:00:00-07:00")\n' +
    '- "every": Recurring interval in milliseconds (e.g., "1800000" for 30 min)\n' +
    '- "cron": Cron expression with timezone (e.g., "0 7 * * *" for daily at 7 AM)',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'list', 'update', 'remove', 'run', 'status'],
        description: 'Action to perform',
      },
      // For 'add':
      name: { type: 'string', description: 'Unique job name (for add)' },
      schedule_type: {
        type: 'string',
        enum: ['at', 'every', 'cron'],
        description: 'Schedule type (for add)',
      },
      schedule_expr: {
        type: 'string',
        description: 'Schedule expression — ISO-8601, ms interval, or cron (for add/update)',
      },
      prompt: {
        type: 'string',
        description: 'What the agent should do when this job runs (for add/update)',
      },
      delivery_mode: {
        type: 'string',
        enum: ['none', 'announce', 'webhook'],
        description: 'How to deliver results (default: announce to operator)',
      },
      // For update/remove/run:
      job_id: { type: 'string', description: 'Job ID (for update/remove/run)' },
      // For update:
      enabled: { type: 'boolean', description: 'Enable/disable job (for update)' },
    },
    required: ['action'],
  },
  handler: async (input, context) => {
    const action = input.action as string;
    const engine = getSchedulerEngine();
    const store = engine.getStore();

    switch (action) {
      // ── ADD ───────────────────────────────────────────────────
      case 'add': {
        const name = input.name as string | undefined;
        const scheduleType = input.schedule_type as ScheduleType | undefined;
        const scheduleExpr = input.schedule_expr as string | undefined;
        const prompt = input.prompt as string | undefined;

        if (!name || !scheduleType || !scheduleExpr || !prompt) {
          return 'Error: "add" requires name, schedule_type, schedule_expr, and prompt.';
        }

        // Check for duplicate name
        if (store.getJobByName(name)) {
          return `Error: A job named "${name}" already exists. Choose a different name or remove the existing one.`;
        }

        // Validate expression
        const validationError = validateScheduleExpr(scheduleType, scheduleExpr);
        if (validationError) {
          return `Error: Invalid schedule expression — ${validationError}`;
        }

        try {
          const job = store.createJob({
            name,
            scheduleType,
            scheduleExpr,
            payloadPrompt: prompt,
            deliveryMode: (input.delivery_mode as DeliveryMode) ?? 'announce',
            deliveryTarget: context.sessionId,
            source: 'agent',
          });

          const schedule = formatSchedule(job.scheduleType, job.scheduleExpr, job.timezone);

          // Send Telegram approval request (non-blocking)
          const approvalMgr = getScheduleApprovalManager();
          if (approvalMgr) {
            void approvalMgr.requestApproval(job.jobId);
          }

          return (
            `Job created — awaiting operator approval.\n\n` +
            `ID: ${job.jobId}\n` +
            `Name: ${job.name}\n` +
            `Schedule: ${schedule}\n` +
            `Status: ${job.approvalStatus}\n\n` +
            `The operator has been sent an approval request via Telegram.`
          );
        } catch (err) {
          return `Error creating job: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // ── LIST ──────────────────────────────────────────────────
      case 'list': {
        const jobs = store.listJobs();
        if (jobs.length === 0) {
          return 'No scheduled jobs.';
        }

        const lines = jobs.map((j) => {
          const schedule = formatSchedule(j.scheduleType, j.scheduleExpr, j.timezone);
          const status = j.approvalStatus === 'pending'
            ? '⏳ pending approval'
            : j.enabled
              ? `✓ ${j.status}`
              : `✗ disabled`;
          const lastRun = j.lastRunAt
            ? new Date(j.lastRunAt).toLocaleString()
            : 'never';
          const errors = j.consecutiveErrors > 0
            ? ` (${j.consecutiveErrors} errors)`
            : '';

          return (
            `• ${j.name} [${j.jobId.slice(0, 8)}]\n` +
            `  Schedule: ${schedule}\n` +
            `  Status: ${status}${errors}\n` +
            `  Last run: ${lastRun}\n` +
            `  Prompt: ${j.payloadPrompt.slice(0, 80)}${j.payloadPrompt.length > 80 ? '...' : ''}`
          );
        });

        return `Scheduled jobs (${jobs.length}):\n\n${lines.join('\n\n')}`;
      }

      // ── UPDATE ────────────────────────────────────────────────
      case 'update': {
        const jobId = input.job_id as string | undefined;
        if (!jobId) return 'Error: "update" requires job_id.';

        const existing = store.getJob(jobId);
        if (!existing) return `Error: No job found with ID ${jobId}`;

        const updated = store.updateJob(jobId, {
          scheduleExpr: input.schedule_expr as string | undefined,
          payloadPrompt: input.prompt as string | undefined,
          deliveryMode: input.delivery_mode as DeliveryMode | undefined,
          enabled: input.enabled as boolean | undefined,
        });

        if (!updated) return `Error: Failed to update job ${jobId}`;

        const schedule = formatSchedule(updated.scheduleType, updated.scheduleExpr, updated.timezone);
        return (
          `Job updated.\n\n` +
          `ID: ${updated.jobId}\n` +
          `Name: ${updated.name}\n` +
          `Schedule: ${schedule}\n` +
          `Enabled: ${updated.enabled}\n` +
          `Status: ${updated.status}`
        );
      }

      // ── REMOVE ────────────────────────────────────────────────
      case 'remove': {
        const jobId = input.job_id as string | undefined;
        if (!jobId) return 'Error: "remove" requires job_id.';

        const job = store.getJob(jobId);
        if (!job) return `Error: No job found with ID ${jobId}`;

        const removed = store.removeJob(jobId);
        return removed
          ? `Job "${job.name}" removed.`
          : `Error: Failed to remove job ${jobId}`;
      }

      // ── RUN (manual trigger) ──────────────────────────────────
      case 'run': {
        const jobId = input.job_id as string | undefined;
        if (!jobId) return 'Error: "run" requires job_id.';

        const job = store.getJob(jobId);
        if (!job) return `Error: No job found with ID ${jobId}`;

        if (job.approvalStatus !== 'approved') {
          return `Error: Job "${job.name}" hasn't been approved yet. Ask the operator to approve it first.`;
        }

        // Force-trigger by temporarily setting next_run_at to now
        store.updateJob(jobId, {}); // no-op update to get fresh state
        await engine.tick(); // will pick up due jobs

        return `Triggered manual run of "${job.name}". Check task queue for execution.`;
      }

      // ── STATUS ────────────────────────────────────────────────
      case 'status': {
        const allJobs = store.listJobs();
        const active = allJobs.filter((j) => j.status === 'active' && j.approvalStatus === 'approved').length;
        const pending = allJobs.filter((j) => j.approvalStatus === 'pending').length;
        const disabled = allJobs.filter((j) => j.status === 'disabled').length;
        const completed = allJobs.filter((j) => j.status === 'completed').length;

        return (
          `Scheduler engine: ${engine.isRunning ? 'running' : 'stopped'}\n` +
          `Total jobs: ${allJobs.length}\n` +
          `  Active: ${active}\n` +
          `  Pending approval: ${pending}\n` +
          `  Disabled: ${disabled}\n` +
          `  Completed: ${completed}`
        );
      }

      default:
        return `Unknown action: ${action}. Valid actions: add, list, update, remove, run, status`;
    }
  },
});
