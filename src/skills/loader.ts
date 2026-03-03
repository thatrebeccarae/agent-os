import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSkillsDir } from './config.js';

// ── Types ───────────────────────────────────────────────────────────

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  tools: string[]; // names of tools this skill registers
}

export interface SkillModule {
  manifest: SkillManifest;
  register: () => void; // called to register tools
}

function validateManifest(manifest: unknown, file: string): manifest is SkillManifest {
  if (!manifest || typeof manifest !== 'object') {
    console.error(`[skills] ${file}: manifest must be an object`);
    return false;
  }
  const m = manifest as Record<string, unknown>;
  if (typeof m.name !== 'string' || !m.name.trim()) {
    console.error(`[skills] ${file}: manifest.name is required and must be a non-empty string`);
    return false;
  }
  if (typeof m.description !== 'string' || !m.description.trim()) {
    console.error(`[skills] ${file}: manifest.description is required and must be a non-empty string`);
    return false;
  }
  if (typeof m.version !== 'string') {
    console.error(`[skills] ${file}: manifest.version must be a string`);
    return false;
  }
  if (!Array.isArray(m.tools)) {
    console.error(`[skills] ${file}: manifest.tools must be an array`);
    return false;
  }
  return true;
}

export async function loadSkills(): Promise<SkillManifest[]> {
  const skillsDir = getSkillsDir();
  const loaded: SkillManifest[] = [];

  if (!fs.existsSync(skillsDir)) {
    console.log(`[skills] Skills directory not found: ${skillsDir} — skipping`);
    return loaded;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[skills] Failed to read skills directory: ${msg}`);
    return loaded;
  }

  // Load .ts files in dev (tsx), .js files when built
  const skillFiles = entries
    .filter((e) => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js')))
    .map((e) => e.name)
    .sort();

  if (skillFiles.length === 0) {
    console.log('[skills] No skill files found');
    return loaded;
  }

  for (const file of skillFiles) {
    const filePath = path.join(skillsDir, file);
    const fileUrl = pathToFileURL(filePath).href;

    let mod: unknown;
    try {
      mod = await import(fileUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[skills] Failed to import ${file}: ${msg}`);
      continue; // one bad skill must not crash the agent
    }

    const skillMod = mod as Partial<SkillModule>;

    if (!validateManifest(skillMod.manifest, file)) {
      continue;
    }

    if (typeof skillMod.register !== 'function') {
      console.error(`[skills] ${file}: must export a register() function`);
      continue;
    }

    try {
      skillMod.register();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[skills] ${file}: register() threw an error: ${msg}`);
      continue;
    }

    const manifest = skillMod.manifest as SkillManifest;
    loaded.push(manifest);
    console.log(
      `[skills] Loaded "${manifest.name}" v${manifest.version} (${manifest.tools.length} tool(s): ${manifest.tools.join(', ')})`,
    );
  }

  return loaded;
}
