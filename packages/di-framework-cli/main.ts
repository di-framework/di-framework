#!/usr/bin/env bun
import { runActorClean } from "./cmd/actor/clean";
import { runActorInspect } from "./cmd/actor/inspect";
import { runActorList } from "./cmd/actor/list";
import { runActorReset } from "./cmd/actor/reset";
import { runAgentAudit } from "./cmd/agent/audit";
import { runAgentInit } from './cmd/agent/init';
import { runAgentInspect } from './cmd/agent/inspect';
import { runAgentMigrate } from './cmd/agent/migrate';
/** di-framework CLI — app tooling by default; monorepo maintainers use `mx`. */
import { build } from './cmd/build';
import { check } from './cmd/check';
import { runExtensionsInstall } from './cmd/extensions/install';
import { runExtensionsList } from './cmd/extensions/list';
import { runExtensionsUninstall } from './cmd/extensions/uninstall';
import { generateCommand } from './cmd/generate';
import { runHttpOpenAPIGenerate } from './cmd/http/openapi-generate';
import { init } from './cmd/init';
import { runMigrationsExecute } from './cmd/migrations/execute';
import { runMigrationsStatus } from './cmd/migrations/status';
import { runMxBuild } from './cmd/mx/build';
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
import { DEFAULT_EXTENSION_DISPATCH, type ExtensionDispatch } from './extensions/dispatch';

export type CliHandlers = {
  init(args: string[], io: CliIo): Promise<CommandResult>;
  generate(args: string[], io: CliIo): Promise<CommandResult>;
  build(args: string[], io: CliIo): Promise<CommandResult>;
  check(args: string[], io: CliIo): Promise<CommandResult>;
  agentAudit(args: string[]): Promise<CommandResult>;
  agentInit(args: string[]): Promise<CommandResult>;
  agentInspect(args: string[]): Promise<CommandResult>;
  agentMigrate(args: string[]): Promise<CommandResult>;
  actorList(args: string[]): Promise<CommandResult>;
  actorInspect(args: string[]): Promise<CommandResult>;
  actorReset(args: string[]): Promise<CommandResult>;
  actorClean(args: string[]): Promise<CommandResult>;
  migrationsStatus(args: string[]): Promise<CommandResult>;
  migrationsExecute(args: string[]): Promise<CommandResult>;
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
  extensionsInstall(args: string[]): Promise<CommandResult>;
  extensionsUninstall(args: string[]): Promise<CommandResult>;
  extensionsList(args: string[]): Promise<CommandResult>;
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
  actorList: runActorList,
  actorInspect: runActorInspect,
  actorReset: runActorReset,
  actorClean: runActorClean,
  migrationsStatus: runMigrationsStatus,
  migrationsExecute: runMigrationsExecute,
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
  mxPublish: async (args, io) => {
    const { runMxPublish } = await import('./cmd/mx/publish');
    return runMxPublish(args, io);
  },
  extensionsInstall: runExtensionsInstall,
  extensionsUninstall: runExtensionsUninstall,
  extensionsList: runExtensionsList,
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
      actor: {
        description: "Manage and inspect local virtual actors",
        children: {
          list: {
            description: "List known actor types and active instances",
            usage: "di-framework actor list [options]",
            options: [
              "--namespace <name>  Application namespace",
              "--dir <path>  Actor storage directory (default: .actors)",
              "--active  Only list currently active actors",
            ],
            run: ({ args }) => handlers.actorList(args),
          },
          inspect: {
            description: "Inspect an actor identity, activation status, and mailbox calls",
            usage: "di-framework actor inspect <actorType|identity> [options]",
            options: [
              "--key <key>  Actor key",
              "--namespace <name>  Application namespace",
              "--dir <path>  Actor storage directory (default: .actors)",
              "--show-state  Include private committed state in output",
            ],
            run: ({ args }) => handlers.actorInspect(args),
          },
          reset: {
            description: "Reset persisted actor state and deactivate instances for development",
            usage: "di-framework actor reset [options]",
            options: [
              "--actor <name>  Reset only this actor type",
              "--key <key>  Reset only this actor key (requires --actor)",
              "--namespace <name>  Reset only this namespace",
              "--dir <path>  Actor storage directory (default: .actors)",
              "--all  Reset all actors across all namespaces",
            ],
            run: ({ args }) => handlers.actorReset(args),
          },
          clean: {
            description: "Clean persisted actor state (alias for reset)",
            usage: "di-framework actor clean [options]",
            options: [
              "--actor <name>  Clean only this actor type",
              "--key <key>  Clean only this actor key (requires --actor)",
              "--namespace <name>  Clean only this namespace",
              "--dir <path>  Actor storage directory (default: .actors)",
              "--all  Clean all actors across all namespaces",
            ],
            run: ({ args }) => handlers.actorClean(args),
          },
        },
      },
      migrations: {
        description: 'Manage database migrations',
        children: {
          status: {
            description: 'Show migration status and pending migrations',
            usage: 'di-framework migrations status [options]',
            options: [
              '--db <path>  Database path or connection string (default: ./dev.db)',
              '--dir <path>  Migrations directory (default: ./migrations)',
              '--manifest <path>  Path to migration manifest JSON',
              '--binding <name>  Database binding name (default: default)',
              '--module <path>  Module containing @Migration decorated classes (repeatable)',
            ],
            run: ({ args }) => handlers.migrationsStatus(args),
          },
          execute: {
            description: 'Execute pending database migrations',
            usage: 'di-framework migrations execute [options]',
            options: [
              '--db <path>  Database path or connection string (default: ./dev.db)',
              '--dir <path>  Migrations directory (default: ./migrations)',
              '--manifest <path>  Path to migration manifest JSON',
              '--binding <name>  Database binding name (default: default)',
              '--module <path>  Module containing @Migration decorated classes (repeatable)',
              '--step <count>  Maximum number of migrations to apply',
              '--dry-run  Plan without applying changes',
            ],
            run: ({ args }) => handlers.migrationsExecute(args),
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
      extensions: {
        description: 'Manage installed CLI extensions',
        children: {
          install: {
            description: 'Install a CLI extension into the user-global store',
            usage: 'di-framework extensions install <name-or-package>[@range]',
            options: [
              '<name-or-package>  Extension name (resolved to @di-framework/cli-plugin-<name>) or full package name',
            ],
            run: ({ args }) => handlers.extensionsInstall(args),
          },
          uninstall: {
            description: 'Remove an installed CLI extension',
            usage: 'di-framework extensions uninstall <name-or-package>',
            run: ({ args }) => handlers.extensionsUninstall(args),
          },
          list: {
            description: 'List installed CLI extensions',
            usage: 'di-framework extensions list',
            run: ({ args }) => handlers.extensionsList(args),
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

const HELP_TOKENS = new Set(['help', '--help', '-h']);

export async function main(
  argv: string[] = process.argv.slice(2),
  io?: CliIo,
  extensions: ExtensionDispatch = DEFAULT_EXTENSION_DISPATCH,
): Promise<0 | 1 | 2 | 3> {
  const tree = createCommandTree();
  const children = tree.children ?? {};
  const first = argv.find((token) => token !== '--json');
  if (first !== undefined && !HELP_TOKENS.has(first) && children[first] === undefined) {
    const mounted = await extensions.resolveCommand(first, process.cwd());
    if (mounted) children[first] = mounted;
  } else if (first === undefined || HELP_TOKENS.has(first)) {
    for (const [name, stub] of Object.entries(extensions.installedStubs(process.cwd()))) {
      children[name] ??= stub;
    }
  }
  return executeCommand(tree, argv, io);
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
