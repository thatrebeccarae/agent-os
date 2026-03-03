import path from 'node:path';

export function isSkillsEnabled(): boolean {
  return process.env.SKILLS_ENABLED !== 'false';
}

export function getSkillsDir(): string {
  return process.env.SKILLS_DIR || path.resolve(process.cwd(), 'skills');
}
