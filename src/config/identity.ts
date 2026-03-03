import path from 'node:path';

const HOME = process.env.HOME || '/tmp';

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
