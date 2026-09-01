#!/usr/bin/env bun
import { runAgentAudit } from './cmd/agent/audit';
import { runAgentInit } from './cmd/agent/init';
import { runAgentInspect } from './cmd/agent/inspect';
import { runAgentMigrate } from './cmd/agent/migrate';
/** di-framework CLI — app tooling by default; monorepo maintainers use `mx`. */
import { build } from './cmd/build';
import { check } from './cmd/check';
import { generateCommand } from './cmd/generate';
import { runHttpOpenAPIGenerate } from './cmd/http/openapi-generate';
import { init } from './cmd/init';
import { runMxBuild } from './cmd/mx/build';
import { runMxPublish } from './cmd/mx/publish';
import { runMxTest } from './cmd/mx/test';
import { runMxTypecheck } from './cmd/mx/typecheck';
import {
  runSkillsIndexBuild,
  runSkillsIndexInspect,
  runSkillsIndexMigrate,
  runSkillsIndexQuery,
  runSkillsIndexValidate,
} from './cmd/skills/index';
import { runSkillsValidate } from './cmd/skills/validate';
import {
  type CliIo,
  type CliStream,
  type CommandNode,
  type CommandResult,
  executeCommand,
  formatCommandHelp,
} from './command';

export type CliHandlers = {
  init(args: string[], io: CliIo): Promise<CommandResult>;
  generate(args: string[], io: CliIo): Promise<CommandResult>;
  build(args: string[], io: CliIo): Promise<CommandResult>;
  check(args: string[], io: CliIo): Promise<CommandResult>;
  agentAudit(args: string[]): Promise<CommandResult>;
  agentInit(args: string[]): Promise<CommandResult>;
  agentInspect(args: string[]): Promise<CommandResult>;
  agentMigrate(args: string[]): Promise<CommandResult>;
  httpOpenAPIGenerate(args: string[]): Promise<CommandResult>;
  skillsIndexBuild(args: string[]): Promise<CommandResult>;
  skillsIndexInspect(args: string[]): Promise<CommandResult>;
  skillsIndexValidate(args: string[]): Promise<CommandResult>;
  skillsIndexQuery(args: string[]): Promise<CommandResult>;
  skillsIndexMigrate(args: string[]): Promise<CommandResult>;
  skillsValidate(args: string[]): Promise<CommandResult>;
  mxBuild(args: string[], io: CliIo): Promise<CommandResult>;
  mxTest(args: string[], io: CliIo): Promise<CommandResult>;
  mxTypecheck(argv: string[], io: CliIo): Promise<CommandResult>;
  mxPublish(args: string[], io: CliIo): Promise<CommandResult>;
};

const DEFAULT_HANDLERS: CliHandlers = {
  init,
  generate: generateCommand,
  build: (args, io) => build(args, process.cwd(), io),
  check,
  agentAudit: runAgentAudit,
  agentInit: runAgentInit,
  agentInspect: runAgentInspect,
  agentMigrate: runAgentMigrate,
  httpOpenAPIGenerate: runHttpOpenAPIGenerate,
  skillsIndexBuild: runSkillsIndexBuild,
  skillsIndexInspect: runSkillsIndexInspect,
  skillsIndexValidate: runSkillsIndexValidate,
  skillsIndexQuery: runSkillsIndexQuery,
  skillsIndexMigrate: runSkillsIndexMigrate,
  skillsValidate: runSkillsValidate,
  mxBuild: runMxBuild,
  mxTest: runMxTest,
  mxTypecheck: runMxTypecheck,
  mxPublish: runMxPublish,
};

export function createCommandTree(handlers: CliHandlers = DEFAULT_HANDLERS): CommandNode {
  return {
    description: 'CLI for apps built with @di-framework/*',
    usage: 'di-framework <command> [args...]',
    children: {
      init: {
        description: 'Scaffold a new di-framework application',
        usage: 'di-framework init [name] [options]',
        run: ({ args, io }) => handlers.init(args, io),
      },
      generate: {
        description: 'Generate application surfaces from schema manifests',
        usage: 'di-framework generate [options]',
        run: ({ args, io }) => handlers.generate(args, io),
      },
      build: {
        description: 'Build the current application (ttsc or tsc)',
        usage: 'di-framework build [args...]',
        run: ({ args, io }) => handlers.build(args, io),
      },
      check: {
        description: 'Typecheck the current application',
        usage: 'di-framework check [tsconfig.json] [options]',
        run: ({ args, io }) => handlers.check(args, io),
      },
      agent: {
        description: 'Inspect and manage agent configuration',
        children: {
          audit: {
            description: 'Audit agent configuration without changing files',
            usage: 'di-framework agent audit [options]',
            options: [
              '--workspace <path>  Workspace boundary (default: current directory)',
              '--working-directory <path>  Instruction discovery location',
              '--user-directory <path>  User-level neutral source root',
              '--skills-dir <path>  Explicit skill root (repeatable)',
              '--skills-package <name>  Package-provided skill root (repeatable)',
              '--source-mode merge|replace  Merge with or replace neutral skill roots',
              '--instructions-fallback <name>  Instruction fallback filename (repeatable)',
              '--max-instruction-bytes <count>  Combined instruction byte limit',
              '--allowed-directory <path>  Allowed-directory intersection (repeatable)',
            ],
            run: ({ args }) => handlers.agentAudit(args),
          },
          init: {
            description: 'Plan or create neutral agent configuration assets',
            usage: 'di-framework agent init [options]',
            options: [
              '--workspace <path>  Workspace boundary (default: current directory)',
              '--asset <path>  Neutral asset to initialize (repeatable; defaults to all)',
              '--dry-run  Plan without writing (default)',
              '--apply  Apply the exact generated plan',
            ],
            run: ({ args }) => handlers.agentInit(args),
          },
          inspect: {
            description: 'Inspect resolved agent configuration without changing files',
            usage: 'di-framework agent inspect [options]',
            options: [
              '--workspace <path>  Workspace boundary (default: current directory)',
              '--working-directory <path>  Instruction discovery location',
              '--user-directory <path>  User-level neutral source root',
              '--skills-dir <path>  Explicit skill root (repeatable)',
              '--skills-package <name>  Package-provided skill root (repeatable)',
              '--source-mode merge|replace  Merge with or replace neutral skill roots',
              '--instructions-fallback <name>  Instruction fallback filename (repeatable)',
              '--max-instruction-bytes <count>  Combined instruction byte limit',
            ],
            run: ({ args }) => handlers.agentInspect(args),
          },
          migrate: {
            description: 'Plan or apply neutral agent-configuration migrations',
            usage: 'di-framework agent migrate [--plan | --apply] [options]',
            options: [
              '--plan  Display a migration plan without changing files (default)',
              '--apply  Apply exactly the generated migration plan',
              '--workspace <path>  Workspace boundary (default: current directory)',
              '--working-directory <path>  Instruction audit location',
              '--user-directory <path>  User-level neutral source root',
              '--skills-dir <path>  Explicit skill root to audit (repeatable)',
              '--skills-package <name>  Package-provided skill root (repeatable)',
              '--source-mode merge|replace  Merge with or replace neutral skill roots',
              '--instructions-fallback <name>  Instruction fallback filename (repeatable)',
              '--max-instruction-bytes <count>  Combined instruction byte limit',
              '--source <path>  Select an audited migration source (repeatable)',
              '--replace-existing  Plan explicit recoverable file replacement',
            ],
            run: ({ args }) => handlers.agentMigrate(args),
          },
        },
      },
      http: {
        description: 'HTTP application operations',
        children: {
          openapi: {
            description: 'OpenAPI document operations',
            children: {
              generate: {
                description: 'Generate an OpenAPI document from controller modules',
                usage:
                  'di-framework http openapi generate --controllers <module> [--controllers <module> ...] [--output <path>]',
                options: [
                  '--controllers <module>  Controller module to load (repeatable)',
                  '--output <path>  Output file (default: openapi.json)',
                ],
                run: ({ args }) => handlers.httpOpenAPIGenerate(args),
              },
            },
          },
        },
      },
      skills: {
        description: 'Agent Skills operations',
        children: {
          index: {
            description: 'Semantic skills-index operations',
            children: {
              build: {
                description: 'Build a skills index from explicit skill sources',
                usage: 'di-framework skills index build [options]',
                options: [
                  '--skills-dir <path>  SKILL.md tree (repeatable)',
                  '--skill-file <path>  Individual SKILL.md (repeatable)',
                  '--output <path>  Index output file',
                  '--threshold <count>  Minimum catalog size for embeddings',
                  '--limit <count>  Retrieval candidate limit',
                  '--batch-size <count>  Embedding batch size',
                  '--chunk-tokens <count>  Tokens per source chunk',
                  '--chunk-overlap <count>  Overlap between chunks',
                  '--force  Rebuild an unchanged index',
                ],
                run: ({ args }) => handlers.skillsIndexBuild(args),
              },
              inspect: {
                description: 'Inspect safe skills-index metadata',
                usage: 'di-framework skills index inspect [--input <path>]',
                options: ['--input <path>  Index file to inspect'],
                run: ({ args }) => handlers.skillsIndexInspect(args),
              },
              validate: {
                description: 'Validate index integrity and optional source drift',
                usage: 'di-framework skills index validate [options]',
                options: [
                  '--input <path>  Index file to validate',
                  '--skills-dir <path>  SKILL.md tree to compare (repeatable)',
                  '--skill-file <path>  SKILL.md file to compare (repeatable)',
                  '--allow-extra-skills  Allow indexed skills absent from sources',
                ],
                run: ({ args }) => handlers.skillsIndexValidate(args),
              },
              query: {
                description: 'Query an existing skills index',
                usage: 'di-framework skills index query --query <text> [options]',
                options: [
                  '--input <path>  Index file to query',
                  '--query <text>  Search query (required)',
                  '--limit <count>  Maximum matches',
                  '--min-score <number>  Minimum match score',
                  '--abstention-threshold <number>  Minimum selection confidence',
                ],
                run: ({ args }) => handlers.skillsIndexQuery(args),
              },
              migrate: {
                description: 'Rewrite a skills index in the current format',
                usage: 'di-framework skills index migrate [options]',
                options: [
                  '--input <path>  Source index file',
                  '--output <path>  Migrated index output file',
                ],
                run: ({ args }) => handlers.skillsIndexMigrate(args),
              },
            },
          },
          validate: {
            description: 'Validate discovered Agent Skills catalogs',
            usage: 'di-framework skills validate [options]',
            options: [
              '--workspace <path>  Workspace root (default: current directory)',
              '--user-directory <path>  User root for neutral default discovery',
              '--skills-dir <path>  Explicit SKILL.md tree (repeatable)',
              '--skills-package <name-or-path>  Package skill source (repeatable)',
              '--source-mode <merge|replace>  Merge with or replace neutral defaults',
            ],
            run: ({ args }) => handlers.skillsValidate(args),
          },
        },
      },
      mx: {
        description: 'Maintainer tools for the di-framework monorepo',
        children: {
          build: {
            description: 'Build all monorepo packages',
            run: ({ args, io }) => handlers.mxBuild(args, io),
          },
          test: {
            description: 'Run the monorepo E2E test suite',
            run: ({ args, io }) => handlers.mxTest(args, io),
          },
          typecheck: {
            description: 'Typecheck the monorepo with the language service',
            run: ({ args, io }) => handlers.mxTypecheck(args, io),
          },
          publish: {
            description: 'Test, build, and publish all packages to npm',
            run: ({ args, io }) => handlers.mxPublish(args, io),
          },
        },
      },
    },
  };
}

export const COMMAND_TREE = createCommandTree();

export function printHelp(stream: CliStream = process.stdout): void {
  stream.write(formatCommandHelp(COMMAND_TREE));
}

export function main(argv: string[] = process.argv.slice(2), io?: CliIo): Promise<0 | 1 | 2 | 3> {
  return executeCommand(COMMAND_TREE, argv, io);
}

export function runMain(
  isMain = import.meta.main,
  start: () => Promise<0 | 1 | 2 | 3> = () => main(),
  setExitCode: (exitCode: 0 | 1 | 2 | 3) => void = (exitCode) => {
    process.exitCode = exitCode;
  },
): void {
  if (isMain) void start().then(setExitCode);
}

runMain();
