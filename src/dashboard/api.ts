/**
 * Dashboard API route handlers.
 * Mounted on the Express health server in gateway/server.ts.
 */

import type { Express } from 'express';
import type { AgentStore } from '../memory/store.js';
import type { TaskQueue } from '../tasks/queue.js';
import type { LLMRouter } from '../llm/router.js';
import type { ClaudeCodeExecutor } from '../claude-code/executor.js';
import type { InboxMonitor } from '../inbox/monitor.js';
import type { DockerMonitor } from '../inbox/docker-monitor.js';
import type { CalendarMonitor } from '../inbox/calendar-monitor.js';
import type { HeartbeatMonitor } from '../heartbeat/monitor.js';
import type { TaskStatus } from '../tasks/types.js';
import { getRecentLogs } from './log-buffer.js';

export interface DashboardState {
  store: AgentStore;
  taskQueue: TaskQueue;
  router: LLMRouter;
  claudeCodeExecutor: ClaudeCodeExecutor | null;
  inboxMonitor: InboxMonitor | null;
  dockerMonitor: DockerMonitor | null;
  calendarMonitor: CalendarMonitor | null;
  heartbeatMonitor: HeartbeatMonitor | null;
  startTime: number;
}

let _state: DashboardState | null = null;

export function setDashboardState(state: DashboardState): void {
  _state = state;
}

export function mountDashboardRoutes(app: Express): void {
  app.get('/api/status', (_req, res) => {
    if (!_state) {
      res.status(503).json({ error: 'Dashboard not initialized' });
      return;
    }

    const { store, taskQueue, router, claudeCodeExecutor, inboxMonitor, dockerMonitor, calendarMonitor, heartbeatMonitor, startTime } = _state;
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    const ccInfo = claudeCodeExecutor?.isActive()
      ? claudeCodeExecutor.getActiveInfo()
      : null;

    const heartbeatResult = heartbeatMonitor?.getLastResult() ?? null;

    res.json({
      uptime: uptimeSeconds,
      startTime,
      providers: router.getStatus(),
      sessions: store.getSessionCount(),
      messages: store.getMessageCount(),
      tasks: {
        pending: taskQueue.getPendingCount(),
        recent: taskQueue.listTasks(undefined, 5).length,
      },
      monitors: {
        inbox: inboxMonitor ? 'active' : 'disabled',
        docker: dockerMonitor ? 'active' : 'disabled',
        calendar: calendarMonitor ? 'active' : 'disabled',
      },
      heartbeat: heartbeatMonitor
        ? { status: 'active', lastPulse: heartbeatResult?.timestamp ?? null, lastAction: heartbeatResult?.action ?? null }
        : { status: 'disabled' },
      claudeCode: ccInfo
        ? { active: true, title: ccInfo.title, startedAt: ccInfo.startedAt.toISOString(), durationMs: Date.now() - ccInfo.startedAt.getTime() }
        : { active: false },
    });
  });

  app.get('/api/tasks', (req, res) => {
    if (!_state) {
      res.status(503).json({ error: 'Dashboard not initialized' });
      return;
    }

    const status = req.query.status as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const validStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'];
    const filterStatus = status && validStatuses.includes(status) ? (status as TaskStatus) : undefined;

    const tasks = _state.taskQueue.listTasks(filterStatus, limit);
    res.json({ tasks, count: tasks.length });
  });

  app.get('/api/sessions', (_req, res) => {
    if (!_state) {
      res.status(503).json({ error: 'Dashboard not initialized' });
      return;
    }

    // Query sessions with message counts from SQLite directly
    const rows = _state.store.db
      .prepare(
        `SELECT s.id, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count
         FROM sessions s
         ORDER BY s.updated_at DESC
         LIMIT 20`,
      )
      .all() as { id: string; created_at: number; updated_at: number; message_count: number }[];

    res.json({ sessions: rows, count: rows.length });
  });

  app.get('/api/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const logs = getRecentLogs(limit);
    res.json({ logs, count: logs.length });
  });

  app.get('/api/memory', (req, res) => {
    if (!_state) {
      res.status(503).json({ error: 'Dashboard not initialized' });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const facts = _state.store.getRecentFacts(limit);
    res.json({
      facts: facts.map((f) => ({
        id: f.id,
        fact: f.fact,
        sourceSession: f.source_session,
        createdAt: f.created_at,
      })),
      count: facts.length,
    });
  });

  app.get('/api/monitors', (_req, res) => {
    if (!_state) {
      res.status(503).json({ error: 'Dashboard not initialized' });
      return;
    }

    res.json({
      inbox: _state.inboxMonitor ? { status: 'active' } : { status: 'disabled' },
      docker: _state.dockerMonitor ? { status: 'active' } : { status: 'disabled' },
      calendar: _state.calendarMonitor ? { status: 'active' } : { status: 'disabled' },
      heartbeat: _state.heartbeatMonitor ? { status: 'active' } : { status: 'disabled' },
    });
  });
}
