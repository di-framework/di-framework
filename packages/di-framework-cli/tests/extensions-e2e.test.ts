import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionDispatch } from '../extensions/dispatch';
import { main } from '../main';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const PLUGIN_PACKAGE = '@di-framework/cli-plugin-wasmcloud';

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
  };
}

function writeFixturePlugin(store: string): void {
  const packageRoot = join(store, 'node_modules', '@di-framework', 'cli-plugin-wasmcloud');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(store, 'package.json'),
    `${JSON.stringify({
      name: 'di-framework-extensions',
      private: true,
      dependencies: { [PLUGIN_PACKAGE]: '6.0.0' },
    })}\n`,
  );
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: PLUGIN_PACKAGE,
      version: '6.0.0',
      type: 'module',
      main: 'index.js',
    })}\n`,
  );
  writeFileSync(
    join(packageRoot, 'index.js'),
    `export default {
  schemaVersion: 1,
  name: 'wasmcloud',
  description: 'Fixture platform extension',
  command: {
    description: 'Fixture platform extension',
    children: {
      doctor: {
        description: 'Check readiness',
        run: async () => {
          const config = await Bun.file('di-framework.config.json').json();
          return { data: { application: config.name, checks: [{ id: 'config', ok: true }] } };
        },
      },
    },
  },
};
`,
  );
}

describe('wasmcloud extension end-to-end', () => {
  const temps: string[] = [];

  afterEach(() => {
    process.chdir(REPO_ROOT);
    for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  });

  it('mounts an installed extension from a synthetic store and runs doctor', async () => {
    const store = mkdtempSync(join(tmpdir(), 'ext-e2e-store-'));
    temps.push(store);
    writeFixturePlugin(store);

    const project = mkdtempSync(join(tmpdir(), 'ext-e2e-project-'));
    temps.push(project);
    writeFileSync(
      join(project, 'di-framework.config.json'),
      `${JSON.stringify({ name: 'E2E App', entry: 'app.ts' })}\n`,
    );
    writeFileSync(join(project, 'app.ts'), 'export default () => new Response("ok");\n');

    const dispatch = createExtensionDispatch(store);

    const help = captureIo();
    expect(await main(['wasmcloud', '--help'], help.io, dispatch)).toBe(0);
    expect(help.stdout.join('')).toContain('doctor');

    const doctor = captureIo();
    process.chdir(project);
    const exitCode = await main(['wasmcloud', 'doctor', '--json'], doctor.io, dispatch);
    const envelope = JSON.parse(doctor.stdout.join(''));
    expect(envelope).toMatchObject({ schemaVersion: 1, command: 'wasmcloud doctor' });
    expect(envelope.data.application).toBe('E2E App');
    expect(envelope.data.checks.length).toBeGreaterThan(0);
    expect([0, 1]).toContain(exitCode);
    expect(envelope.ok).toBe(exitCode === 0);
  });
});
