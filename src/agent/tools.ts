import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { LLMToolDefinition } from '../llm/types.js';
import { executeCommand, checkDockerAvailability } from '../sandbox/executor.js';
import type { TaskQueue } from '../tasks/queue.js';
import type { TaskStatus, TaskTier } from '../tasks/types.js';
import { VAULT_BASE_PATH, OPERATOR_NAME, REPO_ALIASES, DEFAULT_REPO_PATH } from '../config/identity.js';

/** Context passed to tool handlers for session-aware operations. */
export interface ToolContext {
  sessionId?: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (input: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

// Path validation — file ops sandboxed to workspace or vault
const WORKSPACE_DIR = path.resolve(process.cwd(), 'data', 'workspace');
const VAULT_DIR = path.resolve(VAULT_BASE_PATH);

async function resolveRealPath(resolved: string): Promise<string> {
  try {
    return await fsp.realpath(resolved);
  } catch {
    // File doesn't exist yet — resolve the parent directory instead
    const parent = path.dirname(resolved);
    const realParent = await fsp.realpath(parent);
    return path.join(realParent, path.basename(resolved));
  }
}

async function resolveWorkspacePath(filePath: string): Promise<string> {
  const resolved = path.resolve(WORKSPACE_DIR, filePath);
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }
  const real = await resolveRealPath(resolved);
  if (!real.startsWith(WORKSPACE_DIR)) {
    throw new Error(`Path escapes workspace via symlink: ${filePath}`);
  }
  return real;
}

// Vault paths Agent can read (everything) and write (specific safe locations)
const VAULT_WRITABLE_PREFIXES = [
  path.join(VAULT_DIR, '01-Inbox'),
  path.join(VAULT_DIR, '02-Projects'),
  path.join(VAULT_DIR, '03-Areas'),
  path.join(VAULT_DIR, '05-Archive'),
  path.join(VAULT_DIR, '06-Daily'),
  path.join(VAULT_DIR, '07-Meetings'),
  path.join(VAULT_DIR, '08-People'),
];

async function resolveVaultReadPath(filePath: string): Promise<string> {
  const resolved = path.resolve(VAULT_DIR, filePath);
  if (!resolved.startsWith(VAULT_DIR)) {
    throw new Error(`Path escapes vault: ${filePath}`);
  }
  const real = await resolveRealPath(resolved);
  if (!real.startsWith(VAULT_DIR)) {
    throw new Error(`Path escapes vault via symlink: ${filePath}`);
  }
  return real;
}

async function resolveVaultWritePath(filePath: string): Promise<string> {
  const resolved = path.resolve(VAULT_DIR, filePath);
  if (!resolved.startsWith(VAULT_DIR)) {
    throw new Error(`Path escapes vault: ${filePath}`);
  }
  const real = await resolveRealPath(resolved);
  if (!real.startsWith(VAULT_DIR)) {
    throw new Error(`Path escapes vault via symlink: ${filePath}`);
  }
  const isWritable = VAULT_WRITABLE_PREFIXES.some((prefix) => real.startsWith(prefix));
  if (!isWritable) {
    throw new Error(`Write not permitted outside safe vault directories: ${filePath}`);
  }
  return real;
}

// ── Lazy TaskQueue reference (set after init) ──────────────────────
let _taskQueue: TaskQueue | null = null;

export function setTaskQueue(queue: TaskQueue): void {
  _taskQueue = queue;
}

function getTaskQueue(): TaskQueue {
  if (!_taskQueue) throw new Error('TaskQueue not initialized — call setTaskQueue() first');
  return _taskQueue;
}

// ── Lazy ClaudeCodeExecutor reference (set after init) ──────────────
import type { ClaudeCodeExecutor } from '../claude-code/executor.js';

let _claudeCodeExecutor: ClaudeCodeExecutor | null = null;

export function setClaudeCodeExecutor(executor: ClaudeCodeExecutor): void {
  _claudeCodeExecutor = executor;
}

function getClaudeCodeExecutor(): ClaudeCodeExecutor {
  if (!_claudeCodeExecutor) throw new Error('ClaudeCodeExecutor not initialized — call setClaudeCodeExecutor() first');
  return _claudeCodeExecutor;
}

// ── Lazy RemoteControlManager reference (set after init) ─────────────
import type { RemoteControlManager } from '../claude-code/remote.js';

let _remoteControlManager: RemoteControlManager | null = null;

export function setRemoteControlManager(manager: RemoteControlManager): void {
  _remoteControlManager = manager;
}

function getRemoteControlManager(): RemoteControlManager {
  if (!_remoteControlManager) throw new Error('RemoteControlManager not initialized — call setRemoteControlManager() first');
  return _remoteControlManager;
}

export const toolRegistry = new Map<string, Tool>();

export function register(tool: Tool): void {
  toolRegistry.set(tool.name, tool);
}

register({
  name: 'get_current_time',
  description: 'Returns the current date and time in ISO 8601 format.',
  input_schema: { type: 'object', properties: {}, required: [] },
  handler: async () => new Date().toISOString(),
});

// ── Web search helpers ───────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;
const MAX_OUTPUT_CHARS = 2000;

function formatSearchResults(results: SearchResult[]): string {
  const lines: string[] = [];
  for (const r of results.slice(0, MAX_RESULTS)) {
    lines.push(`${r.title}\n${r.url}\n${r.snippet}\n`);
  }
  const output = lines.join('\n');
  if (output.length > MAX_OUTPUT_CHARS) {
    return output.slice(0, MAX_OUTPUT_CHARS) + '\n[truncated]';
  }
  return output;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchBrave(query: string, apiKey: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
  });
  if (!res.ok) throw new Error(`Brave API returned ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
  const results = data.web?.results ?? [];
  return results.map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
}

async function searchSearXNG(query: string, baseUrl: string): Promise<SearchResult[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`SearXNG returned ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
  const results = data.results ?? [];
  return results.slice(0, MAX_RESULTS).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentAgent/1.0)' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}: ${res.statusText}`);
  const html = await res.text();

  const results: SearchResult[] = [];
  // Parse result blocks: each result lives in a <div class="result ...">
  const resultBlocks = html.split(/class="result\s/);
  for (let i = 1; i < resultBlocks.length && results.length < MAX_RESULTS; i++) {
    const block = resultBlocks[i];
    // Extract title from <a class="result__a" ...>TITLE</a>
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    // Extract URL from <a class="result__url" href="...">
    const urlMatch = block.match(/class="result__url"[^>]*href="([^"]+)"/);
    // Extract snippet from <a class="result__snippet" ...>SNIPPET</a>
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    if (titleMatch) {
      const title = titleMatch[1].trim();
      let resultUrl = '';
      if (urlMatch) {
        resultUrl = urlMatch[1].trim();
        // DDG wraps URLs in a redirect; extract the actual URL from uddg param
        const uddgMatch = resultUrl.match(/[?&]uddg=([^&]+)/);
        if (uddgMatch) resultUrl = decodeURIComponent(uddgMatch[1]);
      }
      let snippet = '';
      if (snippetMatch) {
        // Strip remaining HTML tags from snippet
        snippet = snippetMatch[1].replace(/<[^>]+>/g, '').trim();
      }
      results.push({ title, url: resultUrl, snippet });
    }
  }
  return results;
}

register({
  name: 'web_search',
  description:
    'Search the web for information. Uses Brave Search API (if BRAVE_SEARCH_API_KEY is set), ' +
    'SearXNG (if SEARXNG_URL is set), or DuckDuckGo as a fallback. Returns top 5 results with title, URL, and snippet.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query' } },
    required: ['query'],
  },
  handler: async (input) => {
    const query = input.query as string;
    if (!query.trim()) return 'Error: empty search query';

    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    const searxngUrl = process.env.SEARXNG_URL;

    // Try providers in order of preference
    const providers: Array<{ name: string; search: () => Promise<SearchResult[]> }> = [];
    if (braveKey) providers.push({ name: 'Brave', search: () => searchBrave(query, braveKey) });
    if (searxngUrl) providers.push({ name: 'SearXNG', search: () => searchSearXNG(query, searxngUrl) });
    providers.push({ name: 'DuckDuckGo', search: () => searchDuckDuckGo(query) });

    for (const provider of providers) {
      try {
        const results = await provider.search();
        if (results.length === 0) return `No results found for "${query}" (via ${provider.name}).`;
        return `[${provider.name}] Results for "${query}":\n\n${formatSearchResults(results)}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // If this isn't the last provider, try the next one
        if (provider !== providers[providers.length - 1]) continue;
        return `Error: all search providers failed. Last error (${provider.name}): ${msg}`;
      }
    }

    return 'Error: no search providers available.';
  },
});

register({
  name: 'read_file',
  description: 'Read a file from the workspace directory. Path is relative to data/workspace/.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
    },
    required: ['path'],
  },
  handler: async (input) => {
    const filePath = await resolveWorkspacePath(input.path as string);
    try {
      return await fsp.readFile(filePath, 'utf-8');
    } catch {
      return `Error: file not found — ${input.path}`;
    }
  },
});

register({
  name: 'write_file',
  description: 'Write content to a file in the workspace directory. Creates parent dirs as needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  handler: async (input) => {
    const filePath = await resolveWorkspacePath(input.path as string);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, input.content as string, 'utf-8');
    return `Wrote ${(input.content as string).length} bytes to ${input.path}`;
  },
});

// ── Vault tools ──────────────────────────────────────────────────────

register({
  name: 'vault_read',
  description:
    `Read a file from the vault (${VAULT_BASE_PATH}). Path is relative to vault root. ` +
    'Use this to access projects, daily notes, research, contacts, and all shared context. ' +
    'If you don\'t know the exact path, call vault_search first to find it. ' +
    'Examples: "02-Projects/aouda/_index.md", "06-Daily/2026-03-01.md", "09-Profile/voice-guide.md"',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: `File path relative to vault root (${VAULT_BASE_PATH})` },
    },
    required: ['path'],
  },
  handler: async (input) => {
    const filePath = await resolveVaultReadPath(input.path as string);
    try {
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        const entries = await fsp.readdir(filePath);
        return `Directory listing (${entries.length} items):\n${entries.join('\n')}`;
      }
      const content = await fsp.readFile(filePath, 'utf-8');
      if (content.length > 50000) {
        return content.slice(0, 50000) + '\n\n[truncated at 50KB]';
      }
      return content;
    } catch {
      return `Error: file not found — ${input.path}`;
    }
  },
});

register({
  name: 'vault_write',
  description:
    'Write or update a file in safe vault directories (01-Inbox, 02-Projects, 03-Areas, 05-Archive, 06-Daily, 07-Meetings, 08-People). ' +
    'Path is relative to vault root. Creates parent directories as needed. ' +
    'Cannot write to 00-Dashboard, 04-Resources, 09-Profile, or Meta for safety.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to vault root' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  handler: async (input) => {
    const filePath = await resolveVaultWritePath(input.path as string);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, input.content as string, 'utf-8');
    return `Wrote ${(input.content as string).length} bytes to vault: ${input.path}`;
  },
});

register({
  name: 'vault_search',
  description:
    'Search the vault for files matching a query. Returns file paths containing the search term. ' +
    'Searches file names and content. Use this FIRST when the user refers to something by name ' +
    'without a full path (e.g. "the clay project", "my meeting notes", "that article about AI").',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search term' },
      directory: { type: 'string', description: 'Subdirectory to search in (optional, e.g. "02-Projects")' },
    },
    required: ['query'],
  },
  handler: async (input) => {
    const query = (input.query as string).toLowerCase();
    const searchDir = input.directory
      ? await resolveVaultReadPath(input.directory as string)
      : VAULT_DIR;

    const results: string[] = [];
    const maxResults = 20;

    async function searchRecursive(dir: string): Promise<void> {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        // Skip hidden dirs, node_modules, .git, Repos.nosync
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'Repos.nosync') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await searchRecursive(fullPath);
        } else if (entry.name.endsWith('.md')) {
          const relativePath = path.relative(VAULT_DIR, fullPath);
          // Match on filename
          if (entry.name.toLowerCase().includes(query)) {
            results.push(relativePath);
            continue;
          }
          // Match on content (first 5KB only for speed)
          try {
            const content = await fsp.readFile(fullPath, 'utf-8');
            if (content.slice(0, 5000).toLowerCase().includes(query)) {
              results.push(relativePath);
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }

    await searchRecursive(searchDir);

    if (results.length === 0) return `No vault files found matching "${input.query}"`;
    return `Found ${results.length} file(s):\n${results.join('\n')}`;
  },
});

// ── Sandbox tools ────────────────────────────────────────────────────

register({
  name: 'run_command',
  description:
    'Execute a shell command in the sandbox environment. Commands run in data/workspace/. ' +
    'Simple trusted commands (ls, cat, git, node, etc.) run directly. ' +
    'Untrusted or complex commands run in a Docker container if available. ' +
    'Optional tier parameter: "lightweight" or "docker" to force a specific sandbox tier.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      tier: {
        type: 'string',
        enum: ['lightweight', 'docker'],
        description: 'Force a specific sandbox tier (optional — auto-selects by default)',
      },
      timeout_seconds: {
        type: 'number',
        description: 'Timeout in seconds (default: 30 for lightweight, 60 for docker)',
      },
    },
    required: ['command'],
  },
  handler: async (input) => {
    const command = input.command as string;
    const tier = input.tier as 'lightweight' | 'docker' | undefined;
    const timeoutSeconds = input.timeout_seconds as number | undefined;

    const options: Record<string, unknown> = {};
    if (tier) options.tier = tier;
    if (timeoutSeconds) options.timeoutMs = timeoutSeconds * 1000;

    const result = await executeCommand(command, options);

    const parts: string[] = [];
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    if (result.timedOut) parts.push('[TIMED OUT]');
    if (result.truncated) parts.push('[OUTPUT TRUNCATED]');
    parts.push(`exit code: ${result.exitCode}`);

    return parts.join('\n\n');
  },
});

// Check Docker availability at module load (non-blocking).
// This caches the result so the first run_command doesn't have to wait.
checkDockerAvailability().catch(() => {
  // Docker not available — that's fine, lightweight-only mode.
});

// ── Task management tools ───────────────────────────────────────────

register({
  name: 'create_task',
  description:
    'Create a background task for async execution. Tasks are queued and processed by the task runner. ' +
    'Use this to schedule work that should happen asynchronously.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title for the task' },
      description: { type: 'string', description: 'Detailed description of what to do' },
      priority: { type: 'number', description: 'Priority (higher = more urgent, default 0)' },
      tier: {
        type: 'string',
        enum: ['local', 'cheap', 'capable', 'max'],
        description: 'Processing tier (default "cheap")',
      },
    },
    required: ['title'],
  },
  handler: async (input, context) => {
    const queue = getTaskQueue();
    const task = queue.createTask({
      title: input.title as string,
      description: (input.description as string) ?? undefined,
      priority: (input.priority as number) ?? 0,
      tier: ((input.tier as string) ?? 'cheap') as TaskTier,
      source: 'chat',
      sessionId: context.sessionId,
    });
    return `Task created — id: ${task.id}, title: "${task.title}", status: ${task.status}`;
  },
});

register({
  name: 'list_tasks',
  description:
    'List tasks by status. Returns a formatted list of tasks with ID, title, status, and created time.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
        description: 'Filter by status (optional — returns all if omitted)',
      },
      limit: { type: 'number', description: 'Max number of tasks to return (default 10)' },
    },
    required: [],
  },
  handler: async (input) => {
    const queue = getTaskQueue();
    const status = input.status as TaskStatus | undefined;
    const limit = (input.limit as number) ?? 10;
    const tasks = queue.listTasks(status, limit);

    if (tasks.length === 0) {
      return status ? `No tasks with status "${status}".` : 'No tasks found.';
    }

    const lines = tasks.map(
      (t) => `[${t.id}] ${t.status.toUpperCase().padEnd(9)} pri:${t.priority} "${t.title}" (${t.createdAt})`,
    );
    return `${tasks.length} task(s):\n${lines.join('\n')}`;
  },
});

register({
  name: 'get_task',
  description: 'Get full details of a specific task by ID, including result or error output.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Task ID' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const queue = getTaskQueue();
    const task = queue.getTask(input.id as number);
    if (!task) return `No task found with id ${input.id}`;

    const parts = [
      `ID:          ${task.id}`,
      `Title:       ${task.title}`,
      `Status:      ${task.status}`,
      `Priority:    ${task.priority}`,
      `Tier:        ${task.tier}`,
      `Source:      ${task.source}`,
      `Created:     ${task.createdAt}`,
    ];
    if (task.description) parts.push(`Description: ${task.description}`);
    if (task.startedAt) parts.push(`Started:     ${task.startedAt}`);
    if (task.completedAt) parts.push(`Completed:   ${task.completedAt}`);
    if (task.result) parts.push(`Result:\n${task.result}`);
    if (task.error) parts.push(`Error:\n${task.error}`);
    if (task.sessionId) parts.push(`Session:     ${task.sessionId}`);
    if (task.metadata) parts.push(`Metadata:    ${JSON.stringify(task.metadata)}`);

    return parts.join('\n');
  },
});

register({
  name: 'cancel_task',
  description: 'Cancel a pending task. Only works if the task status is "pending".',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Task ID to cancel' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const queue = getTaskQueue();
    const task = queue.getTask(input.id as number);
    if (!task) return `No task found with id ${input.id}`;
    if (task.status !== 'pending') {
      return `Cannot cancel task ${task.id} — status is "${task.status}" (must be "pending")`;
    }
    queue.cancelTask(task.id);
    return `Task ${task.id} cancelled.`;
  },
});

// ── Gmail tools (conditional on config) ─────────────────────────────
import { getGmailTools } from '../gmail/tools.js';
for (const tool of getGmailTools()) {
  register(tool);
}

// ── Calendar tools (conditional on config) ──────────────────────────
import { getCalendarTools } from '../calendar/tools.js';
for (const tool of getCalendarTools()) {
  register(tool);
}

// ── Browser tools (conditional on config) ────────────────────────────
import { getBrowserTools } from '../browser/tools.js';
for (const tool of getBrowserTools()) {
  register(tool);
}

// ── Miniflux RSS tools (conditional on config) ──────────────────────
import { getMinifluxTools } from '../miniflux/tools.js';
for (const tool of getMinifluxTools()) {
  register(tool);
}

// ── n8n workflow tools (conditional on config) ──────────────────────
import { getN8nTools } from '../n8n/tools.js';
for (const tool of getN8nTools()) {
  register(tool);
}

// ── Claude Code handoff tool (Phase 7) ──────────────────────────────

register({
  name: 'handoff_to_claude_code',
  description:
    'Delegate ANY coding or file task to a local Claude Code agent. ' +
    'The agent has full filesystem access within allowed paths. ' +
    `Approval requests route to ${OPERATOR_NAME} via Telegram. ` +
    'Use the "repo" parameter with a short alias (e.g. "clay", "aouda") instead of a full path. ' +
    'Known aliases: ' + Object.keys(REPO_ALIASES).join(', ') + '. ' +
    'Call this when the user asks to fix, build, refactor, or deploy code — ' +
    'you do NOT need to wait for the exact phrase "hand off to Claude Code".',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title for the task' },
      description: {
        type: 'string',
        description: 'What to do and why. Include acceptance criteria and constraints.',
      },
      repo: {
        type: 'string',
        description: `Short repo alias: ${Object.keys(REPO_ALIASES).join(', ')}`,
      },
      repo_path: {
        type: 'string',
        description: 'Absolute path to the repository (optional — prefer "repo" alias instead)',
      },
    },
    required: ['title', 'description'],
  },
  handler: async (input) => {
    const title = input.title as string;
    const description = input.description as string;

    // Resolve repo path: explicit repo_path > alias > default
    let repoPath: string;
    if (input.repo_path) {
      repoPath = input.repo_path as string;
    } else if (input.repo) {
      const alias = (input.repo as string).toLowerCase();
      const resolved = REPO_ALIASES[alias];
      if (!resolved) {
        const known = Object.entries(REPO_ALIASES)
          .map(([k, v]) => `  ${k} → ${v}`)
          .join('\n');
        return `Unknown repo alias "${input.repo}". Known aliases:\n${known}`;
      }
      repoPath = resolved;
    } else {
      repoPath = DEFAULT_REPO_PATH;
    }

    let executor: ClaudeCodeExecutor;
    try {
      executor = getClaudeCodeExecutor();
    } catch {
      return 'Error: Claude Code executor not available. Check that ANTHROPIC_API_KEY is set.';
    }

    try {
      executor.dispatch({ title, description, repoPath });
      return `Dispatched Claude Code task: "${title}" in ${repoPath}. I'll send updates and results to Telegram.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error dispatching Claude Code task: ${msg}`;
    }
  },
});

// ── Remote Control tools ─────────────────────────────────────────────

register({
  name: 'start_remote_session',
  description:
    'Start an interactive Claude Code Remote Control session and return a URL. ' +
    'Open the URL on your phone or any browser to control a Claude Code session running locally. ' +
    'Use the "repo" parameter with a short alias (e.g. "clay", "aouda") to set the working directory. ' +
    'Known aliases: ' + Object.keys(REPO_ALIASES).join(', ') + '. ' +
    'Only one remote session can be active at a time.',
  input_schema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: `Short repo alias: ${Object.keys(REPO_ALIASES).join(', ')}`,
      },
      repo_path: {
        type: 'string',
        description: 'Absolute path to working directory (optional — prefer "repo" alias)',
      },
    },
    required: [],
  },
  handler: async (input) => {
    let manager: RemoteControlManager;
    try {
      manager = getRemoteControlManager();
    } catch {
      return 'Error: Remote Control not available. Requires Telegram + claude CLI authentication.';
    }

    // Resolve repo path: explicit repo_path > alias > default
    let repoPath: string;
    if (input.repo_path) {
      repoPath = input.repo_path as string;
    } else if (input.repo) {
      const alias = (input.repo as string).toLowerCase();
      const resolved = REPO_ALIASES[alias];
      if (!resolved) {
        const known = Object.entries(REPO_ALIASES)
          .map(([k, v]) => `  ${k} → ${v}`)
          .join('\n');
        return `Unknown repo alias "${input.repo}". Known aliases:\n${known}`;
      }
      repoPath = resolved;
    } else {
      repoPath = DEFAULT_REPO_PATH;
    }

    try {
      const url = await manager.start(repoPath);
      return `Remote Control session started!\n\nURL: ${url}\n\nOpen this on your phone or any browser. Working directory: ${repoPath}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error starting remote session: ${msg}`;
    }
  },
});

register({
  name: 'stop_remote_session',
  description:
    'Stop the active Claude Code Remote Control session. The session URL becomes invalid.',
  input_schema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    let manager: RemoteControlManager;
    try {
      manager = getRemoteControlManager();
    } catch {
      return 'Error: Remote Control not available.';
    }

    if (!manager.isActive()) {
      return 'No active remote session to stop.';
    }

    const info = manager.getInfo();
    manager.stop();
    return `Remote Control session stopped. (was: ${info?.url})`;
  },
});

/** Return tool definitions in provider-agnostic format (without handlers). */
export function getToolDefinitions(): LLMToolDefinition[] {
  return Array.from(toolRegistry.values()).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/** Look up a tool by name and execute its handler. */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext = {},
): Promise<string> {
  const tool = toolRegistry.get(name);
  if (!tool) return `Error: unknown tool "${name}"`;
  try {
    return await tool.handler(input, context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error executing ${name}: ${msg}`;
  }
}
