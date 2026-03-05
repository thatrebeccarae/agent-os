import fs from "node:fs";
import path from "node:path";
import { toolRegistry } from "./tools.js";
import { AGENT_NAME, VAULT_BASE_PATH, REPO_ALIASES } from '../config/identity.js';

const SOUL_PATH = path.resolve(process.cwd(), "config", "soul.md");

/**
 * Build the system prompt from soul.md + runtime context.
 */
export interface PromptOptions {
  memoryContext?: string;
}

export function buildSystemPrompt(options?: PromptOptions): string {

  let soul: string;
  try {
    soul = fs.readFileSync(SOUL_PATH, "utf-8");
  } catch {
    soul = `You are ${AGENT_NAME}, a personal AI assistant. Be concise and helpful.`;
  }

  const now = new Date();
  const isoNow = now.toISOString();

  // Date awareness for natural language resolution
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  const dayOfWeek = days[now.getDay()];

  // Repo alias table for the LLM
  const aliasLines = Object.entries(REPO_ALIASES)
    .map(([alias, repoPath]) => `  - "${alias}" → ${repoPath}`)
    .join('\n');

  const toolList = Array.from(toolRegistry.values())
    .map((t) => `- **${t.name}**: ${t.description}`)
    .join("\n");

  const sections: string[] = [
    soul.trim(),
    "",
    "## Runtime Context",
    "",
    `Current date/time: ${isoNow}`,
    `Today: ${todayStr} (${dayOfWeek}), Yesterday: ${yesterdayStr}, Tomorrow: ${tomorrowStr}`,
    `Only respond to the user's latest message. Conversation history is for context — do not re-summarize previous answers.`,
    "",
    "## Domain Knowledge",
    "",
    "### Vault Structure",
    `Vault root: ${VAULT_BASE_PATH}`,
    "Key paths:",
    `- Daily notes: 06-Daily/YYYY-MM-DD.md (today = 06-Daily/${todayStr}.md)`,
    "- Projects: 02-Projects/<project-name>/_index.md",
    "- People: 08-People/<name>.md",
    "- Inbox: 01-Inbox/",
    "- Meetings: 07-Meetings/",
    "- Profile/goals: 09-Profile/",
    "",
    "### Path Resolution",
    '- If user says "my daily note" or "today\'s note", resolve to 06-Daily/' + todayStr + '.md',
    '- If user says "yesterday\'s note", resolve to 06-Daily/' + yesterdayStr + '.md',
    "- If you don't know the exact path, call vault_search FIRST, then vault_read with the result",
    '- "the clay project" → search for "clay" and read the _index.md',
    "",
    "### Email Accounts",
    "You have access to two Gmail inboxes. All gmail_* tools accept an optional account parameter:",
    '- primary (default): operator@example.com — personal and business email, calendar lives here',
    '- secondary: hello@example.com — inbound/assistant inbox, public-facing email on all web properties',
    '- If user says "check my email" or "inbox" without specifying, check primary',
    '- If user says "check both inboxes", check primary then secondary',
    '- Proactive monitoring polls both accounts automatically',
    "",
    "### Email Best Practices",
    "- Before organizing, categorizing, or triaging: call gmail_list_labels FIRST to learn the existing folder/label structure",
    "- Never bulk-archive without categorizing first. Understand the structure, then sort.",
    "- When reporting email actions, always reference subject and sender — never raw message IDs",
    "- When asked to organize: list labels → search inbox → read enough to categorize → apply appropriate labels → report what you did by subject/sender",
    "- If a label the email belongs in doesn't exist yet, say so and ask before creating it",
    "- Treat email organization like vault organization: look at what exists before changing anything",
    "- Labeling, archiving, and organizing are REVERSIBLE — just do it. Don't ask permission for each email. Report what you did after.",
    '- When the operator says "organize my inbox" or "triage my email", that is authorization to read, label, and archive. Do the full job, then report.',
    "",
    "### Repo Aliases (for handoff_to_claude_code)",
    aliasLines,
    '- When user says "fix X in clay", call handoff_to_claude_code with repo="clay"',
    "",
  ];

  if (options?.memoryContext) {
    sections.push("", "## Relevant Memory", "", options.memoryContext);
  }

  sections.push("", "## Available Tools", "", toolList);

  return sections.join("\n");
}
