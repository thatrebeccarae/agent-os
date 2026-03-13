#!/usr/bin/env tsx
/**
 * CLI Setup Wizard — validates environment and tests connectivity.
 *
 * Usage: npx tsx src/cli/setup.ts
 */

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

// ── ANSI colors ────────────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const OK = green('✓');
const FAIL = red('✗');
const WARN = yellow('⚠');

// ── Checks ─────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  critical: boolean;
}

const results: CheckResult[] = [];

function report(r: CheckResult): void {
  const icon = r.status === 'ok' ? OK : r.status === 'fail' ? FAIL : WARN;
  console.log(`  ${icon} ${r.name}: ${r.detail}`);
  results.push(r);
}

async function checkEnvFile(): Promise<void> {
  const envPath = resolve(PROJECT_ROOT, '.env');
  if (existsSync(envPath)) {
    report({ name: '.env file', status: 'ok', detail: 'Found', critical: true });
  } else {
    report({ name: '.env file', status: 'fail', detail: 'Not found — copy .env.example to .env and fill in values', critical: true });
  }
}

async function checkTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    report({ name: 'Telegram', status: 'fail', detail: 'TELEGRAM_BOT_TOKEN not set', critical: true });
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as { ok: boolean; result?: { username: string } };
    if (data.ok) {
      report({ name: 'Telegram', status: 'ok', detail: `Bot: @${data.result?.username}`, critical: true });
    } else {
      report({ name: 'Telegram', status: 'fail', detail: 'Token rejected by Telegram API', critical: true });
    }
  } catch (err) {
    report({ name: 'Telegram', status: 'fail', detail: `Connection failed: ${(err as Error).message}`, critical: true });
  }
}

async function checkLLMProviders(): Promise<void> {
  const providers: { name: string; key: string; testUrl: string; testBody: unknown; parseOk: (data: unknown) => boolean }[] = [
    {
      name: 'Anthropic',
      key: process.env.ANTHROPIC_API_KEY ?? '',
      testUrl: 'https://api.anthropic.com/v1/messages',
      testBody: { model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
      parseOk: (data: unknown) => !!(data as { id?: string }).id,
    },
    {
      name: 'OpenAI',
      key: process.env.OPENAI_API_KEY ?? '',
      testUrl: 'https://api.openai.com/v1/models',
      testBody: null,
      parseOk: (data: unknown) => !!(data as { data?: unknown[] }).data,
    },
    {
      name: 'Gemini',
      key: process.env.GEMINI_API_KEY ?? '',
      testUrl: `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY ?? ''}`,
      testBody: null,
      parseOk: (data: unknown) => !!(data as { models?: unknown[] }).models,
    },
  ];

  let anyConfigured = false;

  for (const p of providers) {
    if (!p.key) {
      report({ name: p.name, status: 'warn', detail: 'Not configured (optional)', critical: false });
      continue;
    }
    anyConfigured = true;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (p.name === 'Anthropic') {
        headers['x-api-key'] = p.key;
        headers['anthropic-version'] = '2023-06-01';
      } else if (p.name === 'OpenAI') {
        headers['Authorization'] = `Bearer ${p.key}`;
      }

      const fetchOpts: RequestInit = {
        signal: AbortSignal.timeout(10000),
        headers,
      };
      if (p.testBody) {
        fetchOpts.method = 'POST';
        fetchOpts.body = JSON.stringify(p.testBody);
      }

      const res = await fetch(p.testUrl, fetchOpts);
      if (res.ok) {
        report({ name: p.name, status: 'ok', detail: 'API key valid', critical: false });
      } else {
        const text = await res.text();
        report({ name: p.name, status: 'fail', detail: `API returned ${res.status}: ${text.slice(0, 100)}`, critical: false });
      }
    } catch (err) {
      report({ name: p.name, status: 'fail', detail: `Connection failed: ${(err as Error).message}`, critical: false });
    }
  }

  // Check Ollama
  const ollamaUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json() as { models?: { name: string }[] };
      const models = data.models?.map((m) => m.name).join(', ') ?? 'none';
      report({ name: 'Ollama', status: 'ok', detail: `Connected — models: ${models}`, critical: false });
      anyConfigured = true;
    } else {
      report({ name: 'Ollama', status: 'warn', detail: 'Not reachable (optional)', critical: false });
    }
  } catch {
    report({ name: 'Ollama', status: 'warn', detail: 'Not reachable (optional)', critical: false });
  }

  if (!anyConfigured) {
    report({ name: 'LLM Provider', status: 'fail', detail: 'No LLM provider configured — set at least one API key or start Ollama', critical: true });
  }
}

async function checkGmail(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN_PRIMARY ?? process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    report({ name: 'Gmail', status: 'warn', detail: 'Not configured (optional)', critical: false });
    return;
  }
  if (!refreshToken) {
    report({ name: 'Gmail', status: 'warn', detail: 'OAuth client set but no refresh token — run the OAuth flow', critical: false });
    return;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      report({ name: 'Gmail', status: 'ok', detail: 'OAuth token refresh successful', critical: false });
    } else {
      report({ name: 'Gmail', status: 'fail', detail: `OAuth refresh failed (${res.status})`, critical: false });
    }
  } catch (err) {
    report({ name: 'Gmail', status: 'fail', detail: `Connection error: ${(err as Error).message}`, critical: false });
  }
}

async function checkMiniflux(): Promise<void> {
  const apiKey = process.env.MINIFLUX_API_KEY;
  if (!apiKey) {
    report({ name: 'Miniflux', status: 'warn', detail: 'Not configured (optional)', critical: false });
    return;
  }
  const url = process.env.MINIFLUX_URL ?? 'http://localhost:8080';
  try {
    const res = await fetch(`${url}/v1/me`, {
      headers: { 'X-Auth-Token': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      report({ name: 'Miniflux', status: 'ok', detail: 'Connected', critical: false });
    } else {
      report({ name: 'Miniflux', status: 'fail', detail: `API returned ${res.status}`, critical: false });
    }
  } catch (err) {
    report({ name: 'Miniflux', status: 'fail', detail: `Connection failed: ${(err as Error).message}`, critical: false });
  }
}

async function checkN8n(): Promise<void> {
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) {
    report({ name: 'n8n', status: 'warn', detail: 'Not configured (optional)', critical: false });
    return;
  }
  const url = process.env.N8N_URL ?? 'http://localhost:5678';
  try {
    const res = await fetch(`${url}/api/v1/workflows?limit=1`, {
      headers: { 'x-n8n-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      report({ name: 'n8n', status: 'ok', detail: 'Connected', critical: false });
    } else {
      report({ name: 'n8n', status: 'fail', detail: `API returned ${res.status}`, critical: false });
    }
  } catch (err) {
    report({ name: 'n8n', status: 'fail', detail: `Connection failed: ${(err as Error).message}`, critical: false });
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${bold('Agent Setup Wizard')}\n`);
  console.log(dim('Checking environment and connectivity...\n'));

  await checkEnvFile();
  await checkTelegram();
  await checkLLMProviders();
  await checkGmail();
  await checkMiniflux();
  await checkN8n();

  // Summary
  const criticalFails = results.filter((r) => r.critical && r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  const successes = results.filter((r) => r.status === 'ok');

  console.log(`\n${bold('Summary')}`);
  console.log(`  ${green(String(successes.length))} passed  ${yellow(String(warnings.length))} optional  ${red(String(criticalFails.length))} critical\n`);

  if (criticalFails.length > 0) {
    console.log(red('Fix critical issues before starting the agent:'));
    for (const f of criticalFails) {
      console.log(`  ${FAIL} ${f.name}: ${f.detail}`);
    }
    console.log();
    process.exit(1);
  }

  console.log(green('All critical checks passed. Run `pnpm dev` to start the agent.\n'));
}

main().catch((err) => {
  console.error('Setup wizard failed:', err);
  process.exit(1);
});
