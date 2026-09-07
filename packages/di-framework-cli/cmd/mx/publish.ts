import { join } from 'node:path';
import { $ as defaultShell } from 'bun';
import type { CliIo, CommandResult } from '../../command';
import { CommandFailure } from '../../command';
import { preparePublishManifest } from '../../scripts/internal-framework-deps';

export const PACKAGES = [
  'packages/di-framework-core',
  'packages/di-framework-repo',
  'packages/di-framework-http',
  'packages/di-framework-graphql',
  'packages/di-framework-events',
  'packages/di-framework-config',
  'packages/di-framework-auth',
  'packages/di-framework-authz',
  'packages/di-framework-socket',
  'packages/di-framework-rpc',
  'packages/di-framework-ai',
  'packages/di-framework-ai-utils',
  'packages/di-framework-codegen',
  'packages/di-framework-cloudfoundry',
  'packages/di-framework-wasmcloud',
  'packages/di-framework-cli-extension',
  'packages/di-framework-cli-plugin-wasmcloud',
  'packages/di-framework-cli',
  // plugin.cjs + Go sidecar; package.json "build" is a no-op (not tsc/bun compile)
  'packages/di-framework-tsc',
];

/** Bun `$` tagged-template runner; injectable for in-process coverage tests. */
export type PublishShell = typeof defaultShell;

export async function publish(
  shell: PublishShell = defaultShell,
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<{ failed: string[]; published: string[] }> {
  const failed: string[] = [];
  const published: string[] = [];
  // 1. Run tests
  io.stdout.write('🧪 Running tests...\n');
  for (const pkgDir of PACKAGES) {
    await shell`bun test ${pkgDir}`.quiet();
  }

  // 2. Build
  io.stdout.write('🏗️  Building packages...\n');
  await shell`bun run packages/di-framework-cli/cmd/mx/build.ts --sync-versions`.quiet();

  // 3. Publish
  for (const pkgDir of PACKAGES) {
    const fullPath = join(process.cwd(), pkgDir);
    const pkgJsonPath = join(fullPath, 'package.json');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const rawPkgJson = readFileSync(pkgJsonPath, 'utf-8');
    const pkgJson = JSON.parse(rawPkgJson);

    io.stdout.write(`\n🚢 Publishing ${pkgJson.name}@${pkgJson.version}...\n`);

    // Align workspace protocols and stale internal @di-framework/* ranges to ^<major>.
    // Release also runs prepare-publish-manifests + check-packaging before any publish.
    const publishPkgJson = preparePublishManifest(JSON.parse(rawPkgJson), pkgJson.version);

    try {
      writeFileSync(pkgJsonPath, `${JSON.stringify(publishPkgJson, null, 2)}\n`);
      await shell`cd ${fullPath} && bun publish --access public`.quiet();
      published.push(pkgJson.name);
      io.stdout.write(`  ✅ Published ${pkgJson.name}\n`);
    } catch (err) {
      failed.push(pkgJson.name);
      io.stderr.write(
        `  ❌ Failed to publish ${pkgJson.name}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      writeFileSync(pkgJsonPath, rawPkgJson);
    }
  }

  io.stdout.write('\n🏁 Publish process finished!\n');
  return { failed, published };
}

export async function runMxPublish(
  args: readonly string[],
  io: CliIo,
  shell: PublishShell = defaultShell,
): Promise<CommandResult> {
  if (args.length > 0) {
    throw new CommandFailure(
      'INVALID_USAGE',
      `mx publish does not accept arguments: ${args[0]}`,
      2,
      {
        argument: args[0],
      },
    );
  }
  const result = await publish(shell, io);
  return {
    data: { failed: result.failed, packages: [...PACKAGES], published: result.published },
    text: `Publish finished: ${result.published.length} published, ${result.failed.length} failed.`,
    exitCode: result.failed.length > 0 ? 1 : 0,
  };
}

/** Standalone boundary; reports failures without terminating an embedding process. */
export async function runPublishMain(
  isMain = import.meta.main,
  start: (args: readonly string[], io: CliIo) => Promise<CommandResult> = runMxPublish,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> {
  if (!isMain) return;
  try {
    const result = await start(process.argv.slice(2), {
      stdout: process.stdout,
      stderr: process.stderr,
    });
    setExitCode(result.exitCode ?? 0);
  } catch (error) {
    process.stderr.write(
      `❌ Publish script failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    setExitCode(error instanceof CommandFailure ? error.exitCode : 1);
  }
}

void runPublishMain();
