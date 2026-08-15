import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatModel } from '@di-framework/ai';
import { OpenAiChatModel, Prompt, systemMessage, userMessage } from '@di-framework/ai';
import type { AgentSkill } from '@di-framework/ai-utils';
import { SkillsTool } from '@di-framework/ai-utils';
import {
  defaultSkillsDirectory,
  exampleRoot,
  loadSkillCorpus,
  measureCatalog,
  type SkillCorpus,
  selectCorpus,
} from './corpus.ts';

export interface SelectionCase {
  readonly id: string;
  readonly prompt: string;
  readonly expectedSkill: string;
}

export const selectionCases = [
  {
    id: 'pdf',
    prompt:
      'Please read quarterly-report.pdf, summarize its conclusions, and extract the revenue table.',
    expectedSkill: 'convert-pdf-to-md',
  },
  {
    id: 'postgres',
    prompt:
      'Review this PostgreSQL schema for JSONB anti-patterns, weak row-level security, and slow functions.',
    expectedSkill: 'postgresql-code-review',
  },
  {
    id: 'threat-model',
    prompt:
      'Create a full STRIDE threat model for this service, including trust boundaries and prioritized findings.',
    expectedSkill: 'threat-model-analyst',
  },
] as const satisfies readonly SelectionCase[];

const SELECTION_SYSTEM = `This is a skill-selection evaluation.
Choose based only on the user's intent and the available skill descriptions.
If one skill applies, call Skill exactly once with its exact name.
Do not explain the choice and do not call unrelated skills.
If no skill applies, reply "no matching skill" without calling Skill.`;

export interface SelectionTrialResult {
  readonly expectedSkill: string;
  readonly selectedSkills: readonly string[];
  readonly firstChoicePassed: boolean;
  readonly singleSelection: boolean;
  readonly content: string;
  readonly providerPromptTokens?: number;
  readonly error?: string;
}

export async function runSelectionTrial(
  chatModel: ChatModel,
  skills: readonly AgentSkill[],
  selectionCase: SelectionCase,
): Promise<SelectionTrialResult> {
  const skill = SkillsTool.of({ skills });
  const prompt = new Prompt([systemMessage(SELECTION_SYSTEM), userMessage(selectionCase.prompt)], {
    toolCallbacks: [skill],
  });

  try {
    // Deliberately inspect the model's proposed call without executing untrusted skill content.
    const response = await chatModel.call(prompt);
    const selectedSkills: string[] = [];
    for (const generation of response.generations) {
      for (const call of generation.output.toolCalls) {
        if (call.name !== skill.toolDefinition.name) continue;
        try {
          const input = JSON.parse(call.arguments) as { command?: unknown };
          if (typeof input.command === 'string') selectedSkills.push(input.command);
        } catch {
          // Malformed arguments count as no usable selection.
        }
      }
    }

    return {
      expectedSkill: selectionCase.expectedSkill,
      selectedSkills,
      firstChoicePassed: selectedSkills[0] === selectionCase.expectedSkill,
      singleSelection: selectedSkills.length === 1,
      content: response.content,
      providerPromptTokens: response.metadata.usage?.promptTokens,
    };
  } catch (error) {
    return {
      expectedSkill: selectionCase.expectedSkill,
      selectedSkills: [],
      firstChoicePassed: false,
      singleSelection: false,
      content: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ScaleCliOptions {
  readonly skillsDirectory: string;
  readonly sizes: readonly (number | 'all')[];
  readonly cases: readonly SelectionCase[];
  readonly trials: number;
  readonly seed: number;
  readonly live: boolean;
  readonly model: string;
}

export function parseCliOptions(args: readonly string[]): ScaleCliOptions {
  let skillsDirectory = process.env.SKILLS_DIRECTORY || defaultSkillsDirectory;
  let sizes: readonly (number | 'all')[] = [10, 50, 100, 250, 'all'];
  let cases: readonly SelectionCase[] = [selectionCases[0]];
  let trials = 1;
  let seed = 1;
  let live = false;
  let model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case '--skills-dir':
        skillsDirectory = value();
        break;
      case '--sizes':
        sizes = parseSizes(value());
        break;
      case '--case': {
        const id = value();
        const selected = selectionCases.find((item) => item.id === id);
        if (!selected) throw new Error(`Unknown case: ${id}`);
        cases = [selected];
        break;
      }
      case '--all-cases':
        cases = selectionCases;
        break;
      case '--trials':
        trials = positiveInteger(value(), '--trials');
        break;
      case '--seed':
        seed = positiveInteger(value(), '--seed');
        break;
      case '--model':
        model = value();
        break;
      case '--live':
        live = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return { skillsDirectory, sizes, cases, trials, seed, live, model };
}

export async function runScaleExample(
  options: ScaleCliOptions,
  suppliedModel?: ChatModel,
): Promise<void> {
  const corpus = loadSkillCorpus(options.skillsDirectory);
  printCorpusSummary(corpus);

  const concreteSizes = options.sizes.map((size) =>
    size === 'all' ? corpus.skills.length : Math.min(size, corpus.skills.length),
  );
  console.log('\ncatalog size\tcharacters\tbytes\trough tokens\tbody characters');
  for (const size of [...new Set(concreteSizes)]) {
    const measurement = measureCatalog(corpus.skills.slice(0, size));
    console.log(
      [
        measurement.skillCount,
        measurement.catalogCharacters,
        measurement.catalogBytes,
        measurement.approximateCatalogTokens,
        measurement.instructionCharacters,
      ].join('\t'),
    );
  }

  if (!options.live) {
    console.log('\nStats only. Run `bun run live` for model selection trials.');
    return;
  }

  const model = suppliedModel ?? createOpenAiModel(options.model);
  console.log(
    '\ncase\tsize\ttrial\texpected\tfirst choice\tpass\tsingle selection\tall selections\tprovider prompt tokens\terror',
  );
  for (const selectionCase of options.cases) {
    for (const size of [...new Set(concreteSizes)]) {
      for (let trial = 1; trial <= options.trials; trial++) {
        const skills = selectCorpus(
          corpus.skills,
          selectionCase.expectedSkill,
          size,
          options.seed + trial - 1,
        );
        const result = await runSelectionTrial(model, skills, selectionCase);
        console.log(
          [
            selectionCase.id,
            size,
            trial,
            result.expectedSkill,
            result.selectedSkills[0] || '(none)',
            result.firstChoicePassed ? 'yes' : 'no',
            result.singleSelection ? 'yes' : 'no',
            result.selectedSkills.join(',') || '(none)',
            result.providerPromptTokens ?? '?',
            result.error?.replaceAll(/\s+/g, ' ').slice(0, 160) ?? '',
          ].join('\t'),
        );
      }
    }
  }
}

function printCorpusSummary(corpus: SkillCorpus): void {
  console.log(`skills directory: ${corpus.directory}`);
  console.log(`discovered: ${corpus.discoveredCount}`);
  console.log(`accepted: ${corpus.skills.length}`);
  console.log(`rejected: ${corpus.rejected.length}`);
  console.log(`load time: ${corpus.loadMilliseconds.toFixed(1)} ms`);
  for (const rejected of corpus.rejected.slice(0, 5)) {
    console.log(`rejected ${rejected.name}: ${rejected.reason}`);
  }
  if (corpus.rejected.length > 5) {
    console.log(`... ${corpus.rejected.length - 5} more rejected skills`);
  }
}

function parseSizes(value: string): readonly (number | 'all')[] {
  const sizes = value.split(',').map((part) => {
    const item = part.trim().toLowerCase();
    return item === 'all' ? 'all' : positiveInteger(item, '--sizes');
  });
  if (sizes.length === 0) throw new Error('--sizes requires at least one size');
  return sizes;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function createOpenAiModel(model: string): ChatModel {
  const apiKey = requireOpenAiApiKey();
  return new OpenAiChatModel({ model, apiKey, temperature: 0, maxTokens: 80 });
}

/** Resolve the live key without executing the gitignored env file as shell code. */
export function requireOpenAiApiKey(
  env: NodeJS.ProcessEnv = process.env,
  startDirectory = exampleRoot,
): string {
  const configured = env.OPENAI_API_KEY?.trim();
  if (configured) return configured;

  let directory = startDirectory;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(directory, '.env.secrets');
    if (existsSync(candidate)) {
      const parsed = readEnvValue(readFileSync(candidate, 'utf8'), 'OPENAI_API_KEY');
      if (parsed) return parsed;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('OPENAI_API_KEY is required for --live');
}

function readEnvValue(text: string, wantedKey: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0 || trimmed.slice(0, equals).trim() !== wantedKey) continue;
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() || undefined;
  }
  return undefined;
}

export async function runAiSkillsScaleMain(isMain = import.meta.main): Promise<void> {
  if (!isMain) return;
  await runScaleExample(parseCliOptions(process.argv.slice(2)));
}

await runAiSkillsScaleMain();
