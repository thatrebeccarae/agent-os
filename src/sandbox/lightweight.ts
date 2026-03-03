/**
 * Tier 1 — Lightweight sandbox: direct execution with path restrictions.
 * For simple, trusted commands (ls, cat, git status, etc.).
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ExecutionResult, ExecutionOptions } from './executor.js';
import { truncate } from './utils.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024; // 10 KB

/** Commands allowed in lightweight mode. */
const ALLOW_LIST = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'find',
  'grep',
  'sort',
  'uniq',
  'diff',
  'echo',
  'pwd',
  'date',
  'whoami',
  'which',
  'file',
  'tree',
  'du',
  'df',
  'git',
  'pnpm',
  'jq',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'sed',
  'awk',
  'tr',
  'cut',
  'xargs',
]);

/**
 * Parse a command string into the base command name.
 * We only check the first token (before pipes, semicolons, etc.).
 */
function parseBaseCommand(command: string): string {
  const trimmed = command.trim();
  // Handle env vars prefix like "FOO=bar cmd ..."
  let rest = trimmed;
  while (/^\w+=\S*\s/.test(rest)) {
    rest = rest.replace(/^\w+=\S*\s+/, '');
  }
  const first = rest.split(/\s/)[0];
  return path.basename(first);
}

/** Shell metacharacters that enable command chaining / injection. */
const DANGEROUS_PATTERNS = /[|;&`\n\r]|\$\(|&&|\|\||>>?|<</;

/** Check if a command is allowed in lightweight mode. */
export function isAllowed(command: string): boolean {
  // Reject any command containing shell metacharacters that could chain
  // arbitrary commands (pipes, semicolons, &&, ||, backticks, $(), redirects).
  if (DANGEROUS_PATTERNS.test(command)) {
    return false;
  }
  const base = parseBaseCommand(command);
  return ALLOW_LIST.has(base);
}

/** Execute a command in lightweight sandbox mode. */
export async function executeLightweight(
  command: string,
  workspaceDir: string,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  const base = parseBaseCommand(command);
  if (!ALLOW_LIST.has(base)) {
    return {
      stdout: '',
      stderr: `Command not in allow-list: ${base}`,
      exitCode: 126,
      timedOut: false,
      truncated: false,
    };
  }

  return new Promise((resolve) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      {
        cwd: workspaceDir,
        timeout: timeoutMs,
        maxBuffer: maxOutput * 2, // extra headroom; we truncate ourselves
        env: {
          HOME: workspaceDir,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: process.env.LANG ?? 'en_US.UTF-8',
          TERM: process.env.TERM ?? 'xterm',
        },
      },
      (error, stdout, stderr) => {
        const timedOut = error !== null && 'killed' in error && error.killed === true;

        const outResult = truncate(stdout, maxOutput);
        const errResult = truncate(stderr, maxOutput);

        const exitCode = child.exitCode ?? (error ? 1 : 0);

        resolve({
          stdout: outResult.text,
          stderr: errResult.text,
          exitCode,
          timedOut,
          truncated: outResult.truncated || errResult.truncated,
        });
      },
    );
  });
}
