import { join } from 'node:path';
import {
  type AgentSkill,
  loadSkillsDirectory,
  SkillsTool,
  validateSkill,
} from '@di-framework/ai-utils';

export const CORPUS_REPOSITORY = 'github/awesome-copilot';
export const exampleRoot = join(import.meta.dir, '..');
export const checkoutDirectory = join(exampleRoot, '.cache', 'awesome-copilot');
export const defaultSkillsDirectory = join(checkoutDirectory, 'skills');
export const defaultIndexFile = join(exampleRoot, '.cache', 'skills-index.jsonl');

export interface RejectedSkill {
  readonly name: string;
  readonly basePath: string;
  readonly reason: string;
}

export interface SkillCorpus {
  readonly directory: string;
  readonly discoveredCount: number;
  readonly skills: readonly AgentSkill[];
  readonly rejected: readonly RejectedSkill[];
  readonly loadMilliseconds: number;
}

export interface CatalogMeasurement {
  readonly skillCount: number;
  readonly catalogCharacters: number;
  readonly catalogBytes: number;
  /** A deliberately rough estimate; live trials report provider token usage. */
  readonly approximateCatalogTokens: number;
  readonly instructionCharacters: number;
}

/**
 * Load a third-party corpus without letting one incompatible skill abort the experiment.
 * Production {@code SkillsToolbox} remains fail-closed; this leniency is benchmark-only.
 */
export function loadSkillCorpus(directory = defaultSkillsDirectory): SkillCorpus {
  const started = performance.now();
  const discovered = loadSkillsDirectory(directory);
  const skills: AgentSkill[] = [];
  const rejected: RejectedSkill[] = [];

  for (const skill of discovered) {
    try {
      validateSkill(skill);
      skills.push(skill);
    } catch (error) {
      rejected.push({
        name: skill.name,
        basePath: skill.basePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return {
    directory,
    discoveredCount: discovered.length,
    skills,
    rejected,
    loadMilliseconds: performance.now() - started,
  };
}

/** Measure the exact catalog currently sent in the Skill tool description. */
export function measureCatalog(skills: readonly AgentSkill[]): CatalogMeasurement {
  const description = SkillsTool.of({ skills }).toolDefinition.description;
  return {
    skillCount: skills.length,
    catalogCharacters: description.length,
    catalogBytes: new TextEncoder().encode(description).length,
    approximateCatalogTokens: Math.ceil(description.length / 4),
    instructionCharacters: skills.reduce((total, skill) => total + skill.content.length, 0),
  };
}

/**
 * Pick a repeatable set of real distractors while guaranteeing that the expected skill is present.
 */
export function selectCorpus(
  skills: readonly AgentSkill[],
  expectedSkill: string,
  requestedSize: number,
  seed = 1,
): AgentSkill[] {
  const target = skills.find((skill) => skill.name === expectedSkill);
  if (!target) throw new Error(`Expected skill is not in the corpus: ${expectedSkill}`);
  if (!Number.isInteger(requestedSize) || requestedSize < 1) {
    throw new Error('Catalog size must be a positive integer');
  }

  const size = Math.min(requestedSize, skills.length);
  if (size === skills.length) return [...skills];

  const distractors = skills
    .filter((skill) => skill !== target)
    .sort((a, b) => {
      const score = stableHash(`${seed}:${a.name}`) - stableHash(`${seed}:${b.name}`);
      return score || a.name.localeCompare(b.name);
    });

  return [target, ...distractors.slice(0, size - 1)].sort((a, b) => a.name.localeCompare(b.name));
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
