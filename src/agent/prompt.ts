import fs from "node:fs";
import path from "node:path";
import { toolRegistry } from "./tools.js";
import { AGENT_NAME } from '../config/identity.js';

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

  const now = new Date().toISOString();

  const toolList = Array.from(toolRegistry.values())
    .map((t) => `- **${t.name}**: ${t.description}`)
    .join("\n");

  const sections: string[] = [
    soul.trim(),
    "",
    "## Runtime Context",
    "",
    `Current date/time: ${now}`,
    `Only respond to the user's latest message. Conversation history is for context — do not re-summarize previous answers.`,
  ];

  if (options?.memoryContext) {
    sections.push("", "## Relevant Memory", "", options.memoryContext);
  }

  sections.push("", "## Available Tools", "", toolList);

  return sections.join("\n");
}
