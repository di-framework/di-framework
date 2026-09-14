import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { CliIo, CommandResult } from '@di-framework/cli-extension';
import { type BindingRecord, discoverBindings } from './bindings';
import { getControllerHealth } from './controller-client';
import { DEPLOY_TOKEN_ENV, readCredentialsFile } from './credentials';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { requiresWasmCloudHost, resolveDevRunner } from './dev-runner';
import { findDeployManifest, loadDeployManifest } from './manifest';
import { loadProject } from './project';
import { invalidUsage } from './support';
import { resolveConnection, resolveTarget } from './target';

export type DoctorCheck = { name: string; ok: boolean; detail?: string };

export async function runWasmcloudDoctor(
  args: readonly string[],
  _io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  if (args.length > 0) {
    invalidUsage(`wasmcloud doctor does not accept arguments: ${args[0]}`, args[0] ?? '');
  }
  const project = loadProject(deps.cwd());
  const check = (name: string, detail: string | undefined): DoctorCheck =>
    detail === undefined ? { name, ok: false } : { name, ok: true, detail };
  const checks: DoctorCheck[] = [
    check('Bun', Bun.version),
    check('Node.js', deps.nodeBinaryPath() && deps.capture('node', ['--version'])),
    check('@di-framework/core', deps.resolveFromProject(project.projectRoot, '@di-framework/core')),
    check('@di-framework/http', deps.resolveFromProject(project.projectRoot, '@di-framework/http')),
    ...(existsSync(project.bindingsPath ?? '')
      ? [
          check(
            '@di-framework/wasmcloud',
            deps.resolveFromProject(project.projectRoot, '@di-framework/wasmcloud'),
          ),
        ]
      : []),
    check('Pulumi', deps.capture('pulumi', ['version'])),
    check('Docker', deps.capture('docker', ['version', '--format', '{{.Server.Version}}'])),
    check('kubectl', deps.capture('kubectl', ['version', '--client', '--output=yaml'])),
    check('oras', deps.capture('oras', ['version'])),
  ];
  let discoveredBindings: BindingRecord[] | undefined;
  let bindingsError: string | undefined;
  if (existsSync(project.bindingsPath ?? '')) {
    try {
      discoveredBindings = discoverBindings(project, deps);
    } catch (error) {
      bindingsError = error instanceof Error ? error.message : String(error);
    }
  }
  let runnerDetail: string | undefined;
  try {
    runnerDetail = resolveDevRunner(deps, {
      wasmCloudHost: requiresWasmCloudHost(
        (discoveredBindings ?? []).map((binding) => binding.requirement),
      ),
    }).kind;
  } catch {
    runnerDetail = undefined;
  }
  checks.push(check('dev runner', runnerDetail));
  const ciToken = deps.env[DEPLOY_TOKEN_ENV]?.trim();
  const stored = readCredentialsFile(deps.credentialsPath());
  const hasLogin = (ciToken !== undefined && ciToken !== '') || Object.keys(stored.targets).length > 0;
  const hasManifest = findDeployManifest(project.projectRoot) !== undefined;
  if (hasManifest) {
    checks.push(
      hasLogin
        ? { name: 'login', ok: true, detail: ciToken ? DEPLOY_TOKEN_ENV : Object.keys(stored.targets).join(', ') }
        : { name: 'login', ok: false, detail: 'di-framework wasmcloud login' },
    );
  }
  if (hasManifest) {
    try {
      const manifest = loadDeployManifest(deps.cwd(), deps.env);
      const target = resolveTarget(manifest);
      const connection = await resolveConnection(target, manifest.workspaceRoot, manifest.path, deps);
      const health = await getControllerHealth(connection, deps);
      checks.push(
        health.ok
          ? { name: 'controller', ok: true, detail: `${connection.controller?.url} ${health.status}` }
          : { name: 'controller', ok: false, detail: `GET /health failed (${health.status})` },
      );
    } catch (error) {
      checks.push({
        name: 'controller',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (discoveredBindings !== undefined) {
    for (const binding of discoveredBindings) {
      const secret =
        binding.secretFrom === undefined ? 'no secret ref' : `secretFrom ${binding.secretFrom}`;
      checks.push({
        name: `binding ${binding.name}`,
        ok: true,
        detail: `${binding.className} ${binding.requirement.package}@${binding.requirement.version} (${secret})`,
      });
    }
  } else if (bindingsError !== undefined) {
    checks.push({
      name: 'bindings',
      ok: false,
      detail: bindingsError,
    });
  }
  const failed = checks.some((entry) => !entry.ok);
  const lines = [
    `${project.applicationName}`,
    '',
    ...checks.map((entry) =>
      entry.ok ? `✓ ${entry.name}: ${entry.detail}` : `✗ ${entry.name} is unavailable`,
    ),
    '',
    `Contract: incoming HTTP → default export in ${relative(project.projectRoot, project.entryPath)}${
      hasManifest && !hasLogin ? ' · wasmcloud login' : ''
    }`,
  ];
  return {
    data: {
      application: project.applicationName,
      checks: checks.map((entry) => ({ ...entry })),
    },
    text: lines.join('\n'),
    exitCode: failed ? 1 : 0,
  };
}
