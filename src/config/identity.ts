import path from 'node:path';

const HOME = process.env.HOME || '/tmp';
const REPOS_BASE = path.join(HOME, 'agent-data', 'Repos.nosync');

/** Display name for the agent (used in UI, logs, prompts). */
export const AGENT_NAME = process.env.AGENT_NAME || 'Agent';

/** Display name for the operator (used in prompts, messages). */
export const OPERATOR_NAME = process.env.OPERATOR_NAME || 'Operator';

/** Base path to the Obsidian vault. */
export const VAULT_BASE_PATH = process.env.VAULT_BASE_PATH || path.join(HOME, 'agent-data');

/** Paths the Claude Code agent is allowed to work in. */
export const CLAUDE_CODE_ALLOWED_PATHS: string[] = process.env.CLAUDE_CODE_ALLOWED_PATHS
  ? process.env.CLAUDE_CODE_ALLOWED_PATHS.split(',').map(s => s.trim()).filter(Boolean)
  : [
      path.join(HOME, 'agent-data', 'Repos.nosync') + '/',
      path.join(HOME, 'agent-data', '02-Projects') + '/',
    ];

/** Package name for log prefixes. */
export const PACKAGE_NAME = process.env.PACKAGE_NAME || 'agent-os';

/** Default repo path for Claude Code handoffs when no repo specified. */
export const DEFAULT_REPO_PATH = process.env.DEFAULT_REPO_PATH || path.join(REPOS_BASE, 'agent-os');

/** Map of short aliases to absolute repo paths. Extensible via REPO_ALIASES env var ("alias=path,alias2=path2"). */
export const REPO_ALIASES: Record<string, string> = {
  'agent-os': path.join(REPOS_BASE, 'agent-os'),
  'clay': path.join(REPOS_BASE, 'clay-crm'),
  'clay-crm': path.join(REPOS_BASE, 'clay-crm'),
  // Merge env overrides
  ...Object.fromEntries(
    (process.env.REPO_ALIASES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const [alias, ...rest] = entry.split('=');
        return [alias.trim(), rest.join('=').trim()];
      })
      .filter(([a, p]) => a && p),
  ),
};
