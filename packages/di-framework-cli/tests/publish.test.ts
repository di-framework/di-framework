import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGES } from '../cmd/mx/publish';
import type { CliIo } from '../command';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const REAL_BUN = process.execPath;

function captureIo(): { io: CliIo; stderr: string[]; stdout: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
    stderr,
    stdout,
  };
}

async function makePublishWorkspace(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'publish-cmd-'));
  await Bun.write(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'root', version: '1.0.0' })}\n`,
  );

  for (const pkgDir of PACKAGES) {
    const full = join(root, pkgDir);
    mkdirSync(full, { recursive: true });
    await Bun.write(
      join(full, 'package.json'),
      `${JSON.stringify({
        name: `@test/${pkgDir.split('/').pop()}`,
        version: '1.0.0',
        peerDependencies: { '@di-framework/core': 'workspace:*' },
        dependencies: { '@di-framework/core': 'workspace:^', other: '1.0.0' },
      })}\n`,
    );
    // So `bun test ${pkgDir}` finds a passing file.
    await Bun.write(
      join(full, 'smoke.test.ts'),
      'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
    );
  }

  // Stub the build entrypoint invoked by publish().
  mkdirSync(join(root, 'packages/di-framework-cli/cmd/mx'), { recursive: true });
  await Bun.write(
    join(root, 'packages/di-framework-cli/cmd/mx/build.ts'),
    'console.log("fake build");\n',
  );

  return root;
}

/** PATH shim: real bun for test/run, immediate non-interactive exit for publish. */
async function installFakeBun(root: string, opts: { failPublish?: boolean } = {}): Promise<string> {
  const bin = join(root, '.bin');
  mkdirSync(bin, { recursive: true });
  const exitCode = opts.failPublish === false ? 0 : 1;
  const script = `#!/usr/bin/env bash
cmd="$1"
shift || true
case "$cmd" in
  publish)
    echo "fake publish $*" >&2
    exit ${exitCode}
    ;;
  *)
    exec ${JSON.stringify(REAL_BUN)} "$cmd" "$@"
    ;;
esac
`;
  const path = join(bin, 'bun');
  await Bun.write(path, script);
  chmodSync(path, 0o755);
  return bin;
}

async function runPublishInChild(
  cwd: string,
  bin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const runner = join(cwd, '_run_publish.ts');
  await Bun.write(
    runner,
    `import { publish } from ${JSON.stringify(join(import.meta.dir, '..', 'cmd', 'mx', 'publish.ts'))};
await publish();
`,
  );
  const proc = Bun.spawn([REAL_BUN, runner], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI: 'true' },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe('publish command', () => {
  const temps: string[] = [];
  afterEach(() => {
    try {
      process.chdir(REPO_ROOT);
    } catch {
      /* ignore */
    }
    for (const t of temps.splice(0)) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  describe('PACKAGES', () => {
    it('includes all expected packages', () => {
      expect(PACKAGES).toContain('packages/di-framework-core');
      expect(PACKAGES).toContain('packages/di-framework-repo');
      expect(PACKAGES).toContain('packages/di-framework-http');
      expect(PACKAGES).toContain('packages/di-framework-graphql');
      expect(PACKAGES).toContain('packages/di-framework-events');
      expect(PACKAGES).toContain('packages/di-framework-config');
      expect(PACKAGES).toContain('packages/di-framework-auth');
      expect(PACKAGES).toContain('packages/di-framework-authz');
      expect(PACKAGES).toContain('packages/di-framework-socket');
      expect(PACKAGES).toContain('packages/di-framework-rpc');
      expect(PACKAGES).toContain('packages/di-framework-ai');
      expect(PACKAGES).toContain('packages/di-framework-ai-utils');
      expect(PACKAGES).toContain('packages/di-framework-codegen');
      expect(PACKAGES).toContain('packages/di-framework-cloudfoundry');
      expect(PACKAGES).toContain('packages/di-framework-wasmcloud');
      expect(PACKAGES).toContain('packages/di-framework-cli-extension');
      expect(PACKAGES).toContain('packages/di-framework-cli-plugin-wasmcloud');
      expect(PACKAGES).toContain('packages/di-framework-cli');
      expect(PACKAGES).toContain('packages/di-framework-tsc');
    });

    it('matches the build command PACKAGES list', async () => {
      const { PACKAGES: BUILD_PACKAGES } = await import('../cmd/mx/build');
      expect(PACKAGES).toEqual(BUILD_PACKAGES);
    });

    it('Release workflow syncs versions, aligns peers, and audits packs before publish', async () => {
      const workflow = await Bun.file(join(REPO_ROOT, '.github/workflows/release.yml')).text();
      expect(workflow).toContain('mx build --sync-versions');
      expect(workflow).toContain('bun scripts/release-prepublish.ts');
      const prepareIndex = workflow.indexOf('bun scripts/release-prepublish.ts');
      const publishIndex = workflow.indexOf('npm publish --access public --provenance');
      expect(prepareIndex).toBeGreaterThan(-1);
      expect(publishIndex).toBeGreaterThan(prepareIndex);
      expect(workflow).toContain("if: github.event_name != 'pull_request'");
    });

    it('Test workflow dry-runs release prepublish on release/v* PRs', async () => {
      const workflow = await Bun.file(join(REPO_ROOT, '.github/workflows/ci.yml')).text();
      expect(workflow).toContain('node-version: "24.x"');
      expect(workflow).toContain('npm install -g npm@latest');
      expect(workflow).toContain("startsWith(github.head_ref, 'release/v')");
      expect(workflow).toContain('mx build --sync-versions');
      expect(workflow).toContain('bun scripts/release-prepublish.ts --publish-dry-run');
      const npmLatest = workflow.indexOf('npm install -g npm@latest');
      const packAudit = workflow.indexOf('bun run check-packaging');
      const dryRun = workflow.indexOf('bun scripts/release-prepublish.ts --publish-dry-run');
      expect(npmLatest).toBeGreaterThan(-1);
      expect(packAudit).toBeGreaterThan(npmLatest);
      expect(dryRun).toBeGreaterThan(packAudit);
    });

    it('matches the Release workflow publish list', async () => {
      const workflow = await Bun.file(join(REPO_ROOT, '.github/workflows/release.yml')).text();
      const loop = workflow.match(/for pkg in([\s\S]*?); do/);
      expect(loop).toBeTruthy();
      const listed = [...(loop?.[1] ?? '').matchAll(/packages\/di-framework-[a-z0-9-]+/g)].map(
        (match) => match[0],
      );
      expect(listed).toEqual([...PACKAGES]);
    });

    it('every package directory exists', async () => {
      for (const pkg of PACKAGES) {
        expect(await Bun.file(join(REPO_ROOT, pkg, 'package.json')).exists()).toBe(true);
      }
    });
  });

  describe('package metadata', () => {
    it('every package has a name, version, and repository.url', async () => {
      for (const pkg of PACKAGES) {
        const pkgJson = JSON.parse(await Bun.file(join(REPO_ROOT, pkg, 'package.json')).text());
        expect(pkgJson.name).toBeTruthy();
        expect(pkgJson.version).toBeTruthy();
        expect(pkgJson.private).not.toBe(true);
        expect(pkgJson.repository.url).toBe('https://github.com/di-framework/di-framework');
        if (pkgJson.name.startsWith('@')) {
          expect(pkgJson.name).toMatch(/^@di-framework\//);
        }
      }
    });

    it('publishes only the canonical di-framework binary', async () => {
      const publishedBins: Record<string, string> = {};
      for (const pkg of PACKAGES) {
        const pkgJson = JSON.parse(await Bun.file(join(REPO_ROOT, pkg, 'package.json')).text());
        Object.assign(publishedBins, pkgJson.bin ?? {});
      }
      expect(publishedBins).toEqual({ 'di-framework': './main.ts' });
    });
  });

  describe('publish pipeline order', () => {
    it('runs tests before build in the source', async () => {
      const source = await Bun.file(join(import.meta.dir, '..', 'cmd', 'mx', 'publish.ts')).text();
      const testIndex = source.indexOf('bun test');
      const buildIndex = source.indexOf(
        'bun run packages/di-framework-cli/cmd/mx/build.ts --sync-versions',
      );
      const publishIndex = source.indexOf('bun publish');

      expect(testIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeGreaterThan(-1);
      expect(publishIndex).toBeGreaterThan(-1);
      expect(testIndex).toBeLessThan(buildIndex);
      expect(buildIndex).toBeLessThan(publishIndex);
    });
  });

  describe('publish()', () => {
    it('runs tests and build, then continues when publish fails', async () => {
      const root = await makePublishWorkspace();
      temps.push(root);
      const bin = await installFakeBun(root, { failPublish: true });
      const { code, stdout, stderr } = await runPublishInChild(root, bin);
      expect(code).toBe(0);
      expect(stderr).toContain('Failed to publish');
      expect(stdout).toContain('Publish process finished');
    }, 60_000);

    it('publishes successfully when bun publish succeeds', async () => {
      const root = await makePublishWorkspace();
      temps.push(root);
      const bin = await installFakeBun(root, { failPublish: false });
      const { code, stdout, stderr } = await runPublishInChild(root, bin);
      expect(code).toBe(0);
      expect(stdout).toContain('Published');
      expect(stderr).not.toContain('Failed to publish');
    }, 60_000);

    it('covers publish() catch and success branches via injected shell', async () => {
      const root = await makePublishWorkspace();
      temps.push(root);
      const prevCwd = process.cwd();

      let publishCalls = 0;
      const fakeShell = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
        const cmd = strings.reduce((acc, s, i) => acc + s + (exprs[i] ?? ''), '');
        const result = {
          // biome-ignore lint/suspicious/noThenProperty: the injected shell deliberately returns a thenable.
          then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
            if (cmd.includes('bun publish')) {
              publishCalls++;
              if (publishCalls === 1) {
                reject?.(new Error('publish denied'));
                return;
              }
            }
            resolve({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
          },
          quiet() {
            return result;
          },
        };
        return result;
      }) as import('../cmd/mx/publish').PublishShell;

      try {
        process.chdir(root);
        const output = captureIo();
        const { publish, runMxPublish } = await import('../cmd/mx/publish');
        const result = await publish(fakeShell, output.io);
        expect(result.failed).toHaveLength(1);
        expect(result.published).toHaveLength(PACKAGES.length - 1);
        expect(output.stderr.join('')).toContain('Failed to publish');
        expect(output.stdout.join('')).toContain('Published');
        expect(output.stdout.join('')).toContain('Publish process finished');
        const commandResult = await runMxPublish([], output.io, fakeShell);
        expect(commandResult.exitCode).toBe(0);
        expect(commandResult.data).toMatchObject({ failed: [], published: expect.any(Array) });
      } finally {
        process.chdir(prevCwd);
      }
    });
  });

  describe('CLI entrypoint', () => {
    it('runMxPublish rejects arguments before starting the pipeline', async () => {
      const { runMxPublish } = await import('../cmd/mx/publish');
      await expect(runMxPublish(['--tag=next'], captureIo().io)).rejects.toMatchObject({
        code: 'INVALID_USAGE',
        exitCode: 2,
      });
    });

    it('runPublishMain uses an injected exit-code setter', async () => {
      const { runPublishMain } = await import('../cmd/mx/publish');
      let code: number | undefined;
      await runPublishMain(
        true,
        async () => {
          throw new Error('boom');
        },
        (value) => {
          code = value;
        },
      );
      expect(code).toBe(1);
      const previousExitCode = process.exitCode;
      await runPublishMain(true, async () => {
        throw new Error('default setter');
      });
      expect(process.exitCode).toBe(1);
      process.exitCode = previousExitCode;
    });

    it('runPublishMain invokes start only when isMain is true', async () => {
      const { runPublishMain } = await import('../cmd/mx/publish');
      let calls = 0;
      const start = async () => {
        calls++;
        return {};
      };
      await runPublishMain(false, start);
      expect(calls).toBe(0);
      await runPublishMain(true, start);
      expect(calls).toBe(1);
    });

    it('exits with code 1 when publish fails under import.meta.main', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'publish-main-fail-'));
      temps.push(empty);
      const proc = Bun.spawn([REAL_BUN, join(import.meta.dir, '..', 'cmd', 'mx', 'publish.ts')], {
        cwd: empty,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      expect(await proc.exited).toBe(1);
      expect(await new Response(proc.stderr).text()).toContain('Publish script failed');
    });
  });
});
