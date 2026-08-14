import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type AgentSkill, parseSkillMarkdown } from './parse-skill-markdown.ts';

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * Recursively load every {@code SKILL.md} under {@code rootDirectory}.
 */
export function loadSkillsDirectory(rootDirectory: string): AgentSkill[] {
  const rootPath = resolve(rootDirectory);
  if (!existsSync(rootPath)) {
    throw new Error(`Root directory does not exist: ${rootDirectory}`);
  }
  if (!statSync(rootPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${rootDirectory}`);
  }

  const skills: AgentSkill[] = [];
  for (const file of walkSkillFiles(rootPath)) {
    skills.push(loadSkillFile(file));
  }
  return skills;
}

/**
 * Load {@code SKILL.md} files from each root directory.
 */
export function loadSkillsDirectories(rootDirectories: readonly string[]): AgentSkill[] {
  const skills: AgentSkill[] = [];
  for (const root of rootDirectories) {
    skills.push(...loadSkillsDirectory(root));
  }
  return skills;
}

/**
 * Parse a single {@code SKILL.md} file. {@link AgentSkill.basePath} is the
 * parent directory (the skill's execution environment).
 */
export function loadSkillFile(skillMdPath: string): AgentSkill {
  const absolute = resolve(skillMdPath);
  if (!existsSync(absolute)) {
    throw new Error(`SKILL.md does not exist: ${skillMdPath}`);
  }
  if (!statSync(absolute).isFile()) {
    throw new Error(`Path is not a file: ${skillMdPath}`);
  }
  const markdown = readFileSync(absolute, 'utf8');
  const basePath = dirname(absolute);
  return parseSkillMarkdown(markdown, {
    basePath,
    fallbackName: basename(basePath),
  });
}

function walkSkillFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir == null) break;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name === 'SKILL.md') {
          out.push(full);
        }
      }
    } catch {
      // Unreadable directories are skipped.
    }
  }
  return out;
}
