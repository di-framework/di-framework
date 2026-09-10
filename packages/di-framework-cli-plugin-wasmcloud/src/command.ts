import type { CommandNode } from '@di-framework/cli-extension';
import { runWasmcloudBuild } from './build.js';
import { runWasmcloudDeploy } from './deploy.js';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps.js';
import { runWasmcloudDestroy } from './destroy.js';
import { runWasmcloudDev } from './dev.js';
import { runWasmcloudDoctor } from './doctor.js';
import { runWasmcloudPlatformDeploy, runWasmcloudPlatformDestroy } from './platform.js';
import { runWasmcloudPlatformInit } from './platform-init.js';

export function createWasmcloudCommand(deps: WasmcloudDeps = DEFAULT_DEPS): CommandNode {
  return {
    description: 'Build, serve, and deploy DI Framework apps as wasmCloud components',
    children: {
      build: {
        description: 'Bundle the app entry and componentize it for WASI HTTP',
        usage: 'di-framework wasmcloud build',
        run: ({ args, io }) => runWasmcloudBuild(args, io, deps),
      },
      dev: {
        description: 'Build, then serve the component locally (wasmtime, wash, or jco)',
        usage: 'di-framework wasmcloud dev [--host <address>] [--port <port>]',
        options: [
          '--host <address>  Bind address (default: 127.0.0.1)',
          '--port <port>  Listen port (default: 8000)',
        ],
        run: ({ args, io }) => runWasmcloudDev(args, io, deps),
      },
      deploy: {
        description:
          'Build, publish, and apply a wasmCloud WorkloadDeployment for a project in di-framework.deploy.toml',
        usage: 'di-framework wasmcloud deploy [name] [--target <name>] [--yes]',
        options: [
          '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
          '--yes  Accepted for compatibility; application deploy does not prompt',
        ],
        run: ({ args, io }) => runWasmcloudDeploy(args, io, deps),
      },
      destroy: {
        description:
          'Remove the generated WorkloadDeployment and Service for a project; does not destroy the platform',
        usage: 'di-framework wasmcloud destroy [name] [--target <name>] [--yes]',
        options: [
          '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
          '--yes  Accepted for compatibility; application destroy does not prompt',
        ],
        run: ({ args, io }) => runWasmcloudDestroy(args, io, deps),
      },
      platform: {
        description: 'Initialize, provision, or tear down a managed wasmCloud platform target',
        children: {
          init: {
            description:
              'Generate deploy/platform from wasmCloud templates and register it as the default local target',
            usage: 'di-framework wasmcloud platform init [--force]',
            options: [
              '--force, -f  Overwrite existing platform files and the local target in di-framework.deploy.toml',
            ],
            run: ({ args, io }) => runWasmcloudPlatformInit(args, io, deps),
          },
          deploy: {
            description:
              'Run pulumi up for a managed target in di-framework.deploy.toml (k0s, registry, operator)',
            usage: 'di-framework wasmcloud platform deploy <target> [--yes]',
            options: ['--yes  Skip the Pulumi confirmation prompt'],
            run: ({ args, io }) => runWasmcloudPlatformDeploy(args, io, deps),
          },
          destroy: {
            description: 'Run pulumi destroy for a managed platform target only',
            usage: 'di-framework wasmcloud platform destroy <target> [--yes]',
            options: ['--yes  Skip the Pulumi confirmation prompt'],
            run: ({ args, io }) => runWasmcloudPlatformDestroy(args, io, deps),
          },
        },
      },
      doctor: {
        description: 'Check the project and local toolchain for wasmCloud readiness',
        usage: 'di-framework wasmcloud doctor',
        run: ({ args, io }) => runWasmcloudDoctor(args, io, deps),
      },
    },
  };
}
