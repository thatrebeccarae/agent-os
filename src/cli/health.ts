#!/usr/bin/env tsx
/**
 * Health Check — quick connectivity test for all configured services.
 *
 * Usage: npx tsx src/cli/health.ts
 */

import 'dotenv/config';

// ── ANSI ───────────────────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const OK = green('✓');
const FAIL = red('✗');
const SKIP = yellow('–');

// ── Service checks ─────────────────────────────────────────────────

interface ServiceCheck {
  name: string;
  critical: boolean;
  check: () => Promise<{ up: boolean; detail: string }>;
}

const services: ServiceCheck[] = [
  {
    name: 'Telegram Bot',
    critical: true,
    check: async () => {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) return { up: false, detail: 'Not configured' };
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json() as { ok: boolean; result?: { username: string } };
      return data.ok
        ? { up: true, detail: `@${data.result?.username}` }
        : { up: false, detail: 'Token invalid' };
    },
  },
  {
    name: 'Anthropic',
    critical: false,
    check: async () => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { up: false, detail: 'Not configured' };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok ? { up: true, detail: 'OK' } : { up: false, detail: `HTTP ${res.status}` };
    },
  },
  {
    name: 'OpenAI',
    critical: false,
    check: async () => {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return { up: false, detail: 'Not configured' };
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { up: true, detail: 'OK' } : { up: false, detail: `HTTP ${res.status}` };
    },
  },
  {
    name: 'Ollama',
    critical: false,
    check: async () => {
      const url = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { up: false, detail: `HTTP ${res.status}` };
      const data = await res.json() as { models?: { name: string }[] };
      return { up: true, detail: `${data.models?.length ?? 0} model(s)` };
    },
  },
  {
    name: 'Gmail OAuth',
    critical: false,
    check: async () => {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const token = process.env.GMAIL_REFRESH_TOKEN_PRIMARY ?? process.env.GMAIL_REFRESH_TOKEN;
      if (!clientId || !clientSecret || !token) return { up: false, detail: 'Not configured' };
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: token, grant_type: 'refresh_token' }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { up: true, detail: 'Token valid' } : { up: false, detail: `Refresh failed (${res.status})` };
    },
  },
  {
    name: 'Miniflux',
    critical: false,
    check: async () => {
      const key = process.env.MINIFLUX_API_KEY;
      if (!key) return { up: false, detail: 'Not configured' };
      const url = process.env.MINIFLUX_URL ?? 'http://localhost:8080';
      const res = await fetch(`${url}/v1/me`, { headers: { 'X-Auth-Token': key }, signal: AbortSignal.timeout(5000) });
      return res.ok ? { up: true, detail: 'Connected' } : { up: false, detail: `HTTP ${res.status}` };
    },
  },
  {
    name: 'n8n',
    critical: false,
    check: async () => {
      const key = process.env.N8N_API_KEY;
      if (!key) return { up: false, detail: 'Not configured' };
      const url = process.env.N8N_URL ?? 'http://localhost:5678';
      const res = await fetch(`${url}/api/v1/workflows?limit=1`, { headers: { 'x-n8n-api-key': key }, signal: AbortSignal.timeout(5000) });
      return res.ok ? { up: true, detail: 'Connected' } : { up: false, detail: `HTTP ${res.status}` };
    },
  },
];

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${bold('Agent Health Check')}\n`);

  let criticalDown = false;

  for (const svc of services) {
    try {
      const result = await svc.check();
      if (result.up) {
        console.log(`  ${OK} ${svc.name}: ${result.detail}`);
      } else if (result.detail === 'Not configured') {
        console.log(`  ${SKIP} ${svc.name}: ${yellow('not configured')}`);
      } else {
        console.log(`  ${FAIL} ${svc.name}: ${result.detail}`);
        if (svc.critical) criticalDown = true;
      }
    } catch (err) {
      console.log(`  ${FAIL} ${svc.name}: ${(err as Error).message}`);
      if (svc.critical) criticalDown = true;
    }
  }

  console.log();
  if (criticalDown) {
    console.log(red('Critical service(s) down.\n'));
    process.exit(1);
  } else {
    console.log(green('All critical services healthy.\n'));
  }
}

main().catch((err) => {
  console.error('Health check failed:', err);
  process.exit(1);
});
