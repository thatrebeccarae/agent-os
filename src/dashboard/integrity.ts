/**
 * Config file integrity checker.
 * Computes SHA-256 hashes of critical config files at startup, then
 * periodically re-checks for unexpected modifications.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface FileHash {
  path: string;
  hash: string | null; // null = existence-only check (e.g. .env)
  existenceOnly: boolean;
  existed: boolean;
}

let baselineHashes: FileHash[] = [];
let intervalId: ReturnType<typeof setInterval> | null = null;
let _sendAlert: ((message: string) => Promise<void>) | null = null;
let _projectRoot: string = '';

function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function computeBaseline(projectRoot: string): FileHash[] {
  const files: { rel: string; existenceOnly: boolean }[] = [
    { rel: 'config/soul.md', existenceOnly: false },
    { rel: '.env', existenceOnly: true },
    { rel: 'package.json', existenceOnly: false },
  ];

  return files.map(({ rel, existenceOnly }) => {
    const fullPath = resolve(projectRoot, rel);
    const exists = existsSync(fullPath);
    return {
      path: fullPath,
      hash: exists && !existenceOnly ? hashFile(fullPath) : null,
      existenceOnly,
      existed: exists,
    };
  });
}

async function checkIntegrity(): Promise<void> {
  const alerts: string[] = [];

  for (const baseline of baselineHashes) {
    const exists = existsSync(baseline.path);

    if (baseline.existenceOnly) {
      if (baseline.existed && !exists) {
        alerts.push(`MISSING: ${baseline.path} was deleted`);
      } else if (!baseline.existed && exists) {
        alerts.push(`NEW: ${baseline.path} appeared unexpectedly`);
      }
      continue;
    }

    if (!exists) {
      alerts.push(`MISSING: ${baseline.path} was deleted`);
      continue;
    }

    const currentHash = hashFile(baseline.path);
    if (baseline.hash && currentHash !== baseline.hash) {
      alerts.push(`MODIFIED: ${baseline.path} hash changed`);
      // Update baseline after alerting (alert once per change)
      baseline.hash = currentHash;
    }
  }

  if (alerts.length > 0 && _sendAlert) {
    const message = `\u{1F6A8} Config Integrity Alert\n\n${alerts.join('\n')}\n\nReview immediately — this could indicate tampering.`;
    try {
      await _sendAlert(message);
    } catch (err) {
      console.error('[integrity] Failed to send alert:', err);
    }
  }
}

/**
 * Start the integrity checker. Computes baselines and begins periodic checks.
 */
export function startIntegrityChecker(
  projectRoot: string,
  sendAlert: (message: string) => Promise<void>,
): void {
  _projectRoot = projectRoot;
  _sendAlert = sendAlert;
  baselineHashes = computeBaseline(projectRoot);

  const hashCount = baselineHashes.filter((h) => h.hash).length;
  const existCount = baselineHashes.filter((h) => h.existenceOnly && h.existed).length;
  console.log(`[integrity] Baseline computed: ${hashCount} hashed, ${existCount} existence-only`);

  intervalId = setInterval(() => void checkIntegrity(), CHECK_INTERVAL_MS);
}

/**
 * Stop the integrity checker.
 */
export function stopIntegrityChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
