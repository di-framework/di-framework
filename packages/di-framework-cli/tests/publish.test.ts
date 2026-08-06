import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGES } from '../cmd/publish';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const REAL_BUN = process.execPath;

async function makePublishWorkspace(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'publish-cmd-'));
  await Bun.write(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', version: '1.0.0' }) + '\n',
  );

  for (const pkgDir of PACKAGES) {
    const full = join(root, pkgDir);
    mkdirSync(full, { recursive: true });
    await Bun.write(
      join(full, 'package.json'),
      JSON.stringify({
        name: `@test/${pkgDir.split('/').pop()}`,
        version: '1.0.0',
      }) + '\n',
    );
    // So `bun test ${pkgDir}` finds a passing file.
    await Bun.write(
      join(full, 'smoke.test.ts'),
      'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
    );
  }

  // Stub the build entrypoint invoked by publish().
  mkdirSync(join(root, 'packages/di-framework-cli/cmd'), { recursive: true });
  await Bun.write(
    join(root, 'packages/di-framework-cli/cmd/build.ts'),
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
    `import { publish } from ${JSON.stringify(join(import.meta.dir, '..', 'cmd', 'publish.ts'))};
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
      expect(PACKAGES).toContain('packages/di-framework-socket');
      expect(PACKAGES).toContain('packages/di-framework-rpc');
      expect(PACKAGES).toContain('packages/di-framework-ai');
      expect(PACKAGES).toContain('packages/di-framework-cli');
    });

    it('matches the build command PACKAGES list', async () => {
      const { PACKAGES: BUILD_PACKAGES } = await import('../cmd/build');
      expect(PACKAGES).toEqual(BUILD_PACKAGES);
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
        // @ts-expect-error - Property 'json' does not exist on type 'BunFile'.
        const pkgJson = await Bun.file(join(REPO_ROOT, pkg, 'package.json')).json();
        expect(pkgJson.name).toBeTruthy();
        expect(pkgJson.version).toBeTruthy();
        expect(pkgJson.private).not.toBe(true);
        expect(pkgJson.repository.url).toBe('https://github.com/di-framework/di-framework');
        if (pkgJson.name.startsWith('@')) {
          expect(pkgJson.name).toMatch(/^@di-framework\//);
        }
      }
    });
  });

  describe('publish pipeline order', () => {
    it('runs tests before build in the source', async () => {
      const source = await Bun.file(join(import.meta.dir, '..', 'cmd', 'publish.ts')).text();
      const testIndex = source.indexOf('bun test');
      const buildIndex = source.indexOf('bun run packages/di-framework-cli/cmd/build.ts');
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
        return {
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
        };
      }) as import('../cmd/publish').PublishShell;

      try {
        process.chdir(root);
        const log = spyOn(console, 'log').mockImplementation(() => {});
        const err = spyOn(console, 'error').mockImplementation(() => {});
        const { publish } = await import('../cmd/publish');
        await publish(fakeShell);
        expect(err.mock.calls.some((c) => String(c[0]).includes('Failed to publish'))).toBe(true);
        expect(log.mock.calls.some((c) => String(c[0]).includes('Published'))).toBe(true);
        expect(log.mock.calls.some((c) => String(c[0]).includes('Publish process finished'))).toBe(
          true,
        );
        log.mockRestore();
        err.mockRestore();
      } finally {
        process.chdir(prevCwd);
      }
    });
  });

  describe('CLI entrypoint', () => {
    it('handlePublishFailure logs and exits 1', () => {
      const { handlePublishFailure } = require('../cmd/publish');
      const err = spyOn(console, 'error').mockImplementation(() => {});
      const originalExit = process.exit;
      let code: number | undefined;
      (process as any).exit = (c: number) => {
        code = c;
        throw new Error(`EXIT_${c}`);
      };
      try {
        expect(() => handlePublishFailure(new Error('boom'))).toThrow('EXIT_1');
        expect(code).toBe(1);
        expect(err.mock.calls[0]?.[0]).toContain('Publish script failed');
      } finally {
        process.exit = originalExit;
        err.mockRestore();
      }
    });

    it('runPublishMain invokes start only when isMain is true', async () => {
      const { runPublishMain } = await import('../cmd/publish');
      let calls = 0;
      const start = async () => {
        calls++;
      };
      runPublishMain(false, start);
      expect(calls).toBe(0);
      runPublishMain(true, start);
      expect(calls).toBe(1);
    });

    it('exits with code 1 when publish fails under import.meta.main', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'publish-main-fail-'));
      temps.push(empty);
      const proc = Bun.spawn([REAL_BUN, join(import.meta.dir, '..', 'cmd', 'publish.ts')], {
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
