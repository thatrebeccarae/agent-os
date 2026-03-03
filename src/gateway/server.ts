import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AgentStore } from '../memory/store.js';
import type { TaskQueue } from '../tasks/queue.js';
import type { TaskTier, TaskSource } from '../tasks/types.js';
import { isOAuthConfigurable, getConsentUrl, exchangeCode, validateOAuthState } from '../gmail/auth.js';
import { mountDashboardRoutes } from '../dashboard/api.js';
import { getDashboardHTML } from '../dashboard/ui.js';
import { AGENT_NAME } from '../config/identity.js';

const DEFAULT_PORT = 3210;

// ── Lazy TaskQueue reference (set after init) ──────────────────────
let _taskQueue: TaskQueue | null = null;

export function setTaskQueue(queue: TaskQueue): void {
  _taskQueue = queue;
}

/**
 * Minimal Express health-check server with webhook support.
 */
export function startHealthServer(store: AgentStore): Server {
  const app = express();
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const startTime = Date.now();

  // JSON body parsing for webhook endpoints
  app.use(express.json());

  // Parse package version at startup
  let version = 'unknown';
  try {
    // Dynamic import would be async; read it synchronously via require workaround
    // Since we're ESM, we rely on the env or a build-time injected value
    version = process.env.npm_package_version ?? '0.1.0';
  } catch {
    // ignore
  }

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      sessions: store.getSessionCount(),
      messages: store.getMessageCount(),
    });
  });

  app.get('/version', (_req, res) => {
    res.json({ version });
  });

  // ── Webhook: create task ────────────────────────────────────────
  app.post('/webhook/task', (req, res) => {
    // Auth check: WEBHOOK_SECRET must be set, and request must include matching bearer token
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (!webhookSecret) {
      res.status(403).json({ error: 'Webhooks disabled — WEBHOOK_SECRET not configured' });
      return;
    }

    const expected = `Bearer ${webhookSecret}`;
    const authHeader = req.headers.authorization ?? '';
    const authMatch = authHeader.length === expected.length &&
      timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
    if (!authMatch) {
      res.status(401).json({ error: 'Unauthorized — invalid or missing bearer token' });
      return;
    }

    if (!_taskQueue) {
      res.status(503).json({ error: 'Task queue not initialized' });
      return;
    }

    const { title, description, priority, tier, source, sessionId: bodySessionId } = req.body as {
      title?: string;
      description?: string;
      priority?: number;
      tier?: string;
      source?: string;
      sessionId?: string;
    };

    // Default sessionId to owner's Telegram chat for result routing
    const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;
    const resolvedSessionId = bodySessionId ?? (ownerChatId ? `telegram:${ownerChatId}` : undefined);

    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Missing required field: title' });
      return;
    }

    const validTiers = ['local', 'cheap', 'capable', 'max'];
    const taskTier = (tier && validTiers.includes(tier) ? tier : 'cheap') as TaskTier;

    const validSources = ['chat', 'webhook', 'schedule', 'system'];
    const taskSource = (source && validSources.includes(source) ? source : 'webhook') as TaskSource;

    const task = _taskQueue.createTask({
      title,
      description,
      priority: typeof priority === 'number' ? priority : 0,
      tier: taskTier,
      source: taskSource,
      sessionId: resolvedSessionId,
    });

    res.status(201).json(task);
  });

  // ── Gmail OAuth flow ───────────────────────────────────────────
  app.get('/oauth/gmail/start', (_req, res) => {
    if (!isOAuthConfigurable()) {
      res.status(400).send('Gmail OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env');
      return;
    }
    res.redirect(getConsentUrl());
  });

  app.get('/oauth/gmail/callback', async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code) {
      res.status(400).send('Missing authorization code.');
      return;
    }
    if (!state || !validateOAuthState(state)) {
      res.status(403).send('Invalid OAuth state — possible CSRF. Try again from /oauth/gmail/start');
      return;
    }
    try {
      const refreshToken = await exchangeCode(code);
      // HTML-escape the token to prevent injection
      const redacted = refreshToken.length > 8
        ? `${refreshToken.slice(0, 4)}...${refreshToken.slice(-4)}`
        : '****';
      res.type('html').send(
        `<h2>Gmail OAuth complete</h2>` +
        `<p>Your refresh token has been generated. Add it to your <code>.env</code> file and restart the agent:</p>` +
        `<pre>GMAIL_REFRESH_TOKEN=${redacted}</pre>` +
        `<p style="color: #666;">Full token logged to server console. You can close this tab.</p>`,
      );
      console.log(`[oauth] Gmail refresh token: ${refreshToken}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).send(`OAuth error: ${msg}`);
    }
  });

  // ── Dashboard ────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.type('html').send(getDashboardHTML());
  });

  mountDashboardRoutes(app);

  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`[health] Server listening on 127.0.0.1:${port}`);
  });

  return server;
}
