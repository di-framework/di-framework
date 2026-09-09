import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildComponent } from '../src/build';
import { DEFAULT_DEPS } from '../src/deps';
import { loadProject } from '../src/project';
import { captureIo, makeProject } from './helpers';

const root = makeProject({
  name: 'Cron Regression',
  entry: 'src/app.ts',
  wasmcloud: { ingress: false },
});
let built: Promise<ReturnType<typeof loadProject>> | undefined;
afterAll(() => rmSync(root, { recursive: true, force: true }));

function component() {
  built ??= (async () => {
    mkdirSync(join(root, 'node_modules/@di-framework'), { recursive: true });
    symlinkSync(
      resolve(import.meta.dir, '../../di-framework-core'),
      join(root, 'node_modules/@di-framework/core'),
    );
    writeFileSync(
      join(root, 'src/app.ts'),
      `
import { Container, Cron } from '@di-framework/core';
class ScheduledService {
  @Cron('* * * * *', { name: 'regression-job' })
  async execute() { return { completed: true }; }
}
if (process.env.RUNTIME_TEST_SECRET !== 'runtime-only') throw new Error('Application initialized without runtime environment');
export const container = new Container();
container.setCronMode('external');
container.register(ScheduledService);
container.resolve(ScheduledService);
export default { container };
`,
    );
    const project = { ...loadProject(root), ingress: false };
    const summary = await buildComponent(project, captureIo().io, DEFAULT_DEPS);
    expect(summary.profile).toBe('wasmcloud-cron');
    expect(readFileSync(project.outputPath).subarray(0, 4)).toEqual(Buffer.from([0, 97, 115, 109]));
    const inspected = await DEFAULT_DEPS.runCaptured(
      DEFAULT_DEPS.nodeBinaryPath()!,
      [DEFAULT_DEPS.jcoCliPath(), 'wit', project.outputPath],
      { cwd: root },
    );
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout).toContain('export wasi:cli/run@0.3.0');
    return project;
  })();
  return built;
}

test('componentizes cron without evaluating services against snapshot WASI stderr', async () => {
  await component();
}, 120_000);

const wasmtime = DEFAULT_DEPS.wasmtimeBinaryPath();
test.skipIf(!wasmtime)(
  'invokes the registered container with runtime WASI environment and rejects unknown jobs',
  async () => {
    const project = await component();
    if (!wasmtime) throw new Error('wasmtime is required for the cron runtime regression');
    const executed = await DEFAULT_DEPS.runCaptured(
      wasmtime,
      [
        'run',
        '-S',
        'p3=y',
        '--invoke',
        'wasi:cli/run.run@0.3.0()',
        '--env',
        'RUNTIME_TEST_SECRET=runtime-only',
        '--env',
        'DI_CRON_INVOKE_JOB=regression-job',
        project.outputPath,
      ],
      { cwd: root },
    );
    expect(executed.stdout.trim()).toBe('ok');
    expect(executed.exitCode).toBe(0);
    const missing = await DEFAULT_DEPS.runCaptured(
      wasmtime,
      [
        'run',
        '-S',
        'p3=y',
        '--invoke',
        'wasi:cli/run.run@0.3.0()',
        '--env',
        'RUNTIME_TEST_SECRET=runtime-only',
        '--env',
        'DI_CRON_INVOKE_JOB=unknown',
        project.outputPath,
      ],
      { cwd: root },
    );
    expect(missing.exitCode).not.toBe(0);
  },
  120_000,
);
