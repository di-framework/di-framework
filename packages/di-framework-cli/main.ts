#!/usr/bin/env bun
import { runAgentAudit } from './cmd/agent/audit';
import { runAgentInspect } from './cmd/agent/inspect';
/** di-framework CLI — app tooling by default; monorepo maintainers use `mx`. */
import { build } from './cmd/build';
import { check } from './cmd/check';
import { generateCommand } from './cmd/generate';
import { runHttpOpenAPIGenerate } from './cmd/http/openapi-generate';
import { init } from './cmd/init';
import type { MxBuildOptions } from './cmd/mx/build';
import { build as mxBuild, parseMxBuildArgs } from './cmd/mx/build';
import { publish } from './cmd/mx/publish';
import { test } from './cmd/mx/test';
import { typecheck } from './cmd/mx/typecheck';
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
  init(args: string[]): Promise<void>;
  generate(args: string[]): Promise<void>;
  build(args: string[]): Promise<void>;
  check(args: string[]): Promise<void>;
  agentAudit(args: string[]): Promise<CommandResult>;
  agentInspect(args: string[]): Promise<CommandResult>;
  httpOpenAPIGenerate(args: string[]): Promise<CommandResult>;
  skillsIndexBuild(args: string[]): Promise<CommandResult>;
  skillsIndexInspect(args: string[]): Promise<CommandResult>;
  skillsIndexValidate(args: string[]): Promise<CommandResult>;
  skillsIndexQuery(args: string[]): Promise<CommandResult>;
  skillsIndexMigrate(args: string[]): Promise<CommandResult>;
  skillsValidate(args: string[]): Promise<CommandResult>;
  mxBuild(options: MxBuildOptions): Promise<void>;
  mxTest(): Promise<void>;
  mxTypecheck(argv: string[]): Promise<void>;
  mxPublish(): Promise<void>;
};

const DEFAULT_HANDLERS: CliHandlers = {
  init,
  generate: generateCommand,
  build,
  check,
  agentAudit: runAgentAudit,
  agentInspect: runAgentInspect,
  httpOpenAPIGenerate: runHttpOpenAPIGenerate,
  skillsIndexBuild: runSkillsIndexBuild,
  skillsIndexInspect: runSkillsIndexInspect,
  skillsIndexValidate: runSkillsIndexValidate,
  skillsIndexQuery: runSkillsIndexQuery,
  skillsIndexMigrate: runSkillsIndexMigrate,
  skillsValidate: runSkillsValidate,
  mxBuild,
  mxTest: test,
  mxTypecheck: typecheck,
  mxPublish: publish,
};

export function createCommandTree(handlers: CliHandlers = DEFAULT_HANDLERS): CommandNode {
  return {
    description: 'CLI for apps built with @di-framework/*',
    usage: 'di-framework <command> [args...]',
    children: {
      init: {
        description: 'Scaffold a new di-framework application',
        usage: 'di-framework init [name] [options]',
        run: async ({ args }) => {
          await handlers.init(args);
          return undefined;
        },
      },
      generate: {
        description: 'Generate application surfaces from schema manifests',
        usage: 'di-framework generate [options]',
        run: async ({ args }) => {
          await handlers.generate(args);
          return undefined;
        },
      },
      build: {
        description: 'Build the current application (ttsc or tsc)',
        usage: 'di-framework build [args...]',
        run: async ({ args }) => {
          await handlers.build(args);
          return undefined;
        },
      },
      check: {
        description: 'Typecheck the current application',
        usage: 'di-framework check [tsconfig.json] [options]',
        run: async ({ args }) => {
          await handlers.check(args);
          return undefined;
        },
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
            run: async ({ args }) => {
              await handlers.mxBuild(parseMxBuildArgs(args));
              return undefined;
            },
          },
          test: {
            description: 'Run the monorepo E2E test suite',
            run: async () => {
              await handlers.mxTest();
              return undefined;
            },
          },
          typecheck: {
            description: 'Typecheck the monorepo with the language service',
            run: async ({ args }) => {
              await handlers.mxTypecheck(['bun', 'typecheck', ...args]);
              return undefined;
            },
          },
          publish: {
            description: 'Test, build, and publish all packages to npm',
            run: async () => {
              await handlers.mxPublish();
              return undefined;
            },
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
