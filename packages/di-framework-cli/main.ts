#!/usr/bin/env bun
/** di-framework CLI — app tooling by default; monorepo maintainers use `mx`. */
import { build } from './cmd/build';
import { check } from './cmd/check';
import { generateCommand } from './cmd/generate';
import { init } from './cmd/init';
import type { MxBuildOptions } from './cmd/mx/build';
import { build as mxBuild, parseMxBuildArgs } from './cmd/mx/build';
import { publish } from './cmd/mx/publish';
import { test } from './cmd/mx/test';
import { typecheck } from './cmd/mx/typecheck';
import {
  type CliIo,
  type CliStream,
  type CommandNode,
  executeCommand,
  formatCommandHelp,
} from './command';

export type CliHandlers = {
  init(args: string[]): Promise<void>;
  generate(args: string[]): Promise<void>;
  build(args: string[]): Promise<void>;
  check(args: string[]): Promise<void>;
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
