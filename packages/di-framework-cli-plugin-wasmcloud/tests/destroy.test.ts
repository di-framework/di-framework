import { describe, expect, it } from 'bun:test';
import { runWasmcloudDestroy } from '../src/destroy';
import { captureIo, fakeDeps, makeWorkspace, type RunnerInvocation } from './helpers';

describe('runWasmcloudDestroy', () => {
  it('deletes through the controller and never invokes pulumi or kubectl', async () => {
    const { greeter } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudDestroy(
      ['--target', 'development'],
      captureIo().io,
      fakeDeps({ cwd: greeter, invocations }),
    );

    expect(invocations.every((invocation) => invocation.command !== 'pulumi')).toBe(true);
    expect(invocations.every((invocation) => invocation.command !== 'kubectl')).toBe(true);
    expect(invocations.some((invocation) => invocation.args[0] === 'destroy')).toBe(false);
    expect(result.data).toMatchObject({
      application: 'greeter',
      target: 'development',
      namespace: 'wasmcloud',
      service: 'greeter',
    });
    expect(result.text).toContain('Removed greeter');
  });

  it('destroys a named project from the workspace root', async () => {
    const { root } = makeWorkspace();
    const result = await runWasmcloudDestroy(
      ['echo', '--target', 'development'],
      captureIo().io,
      fakeDeps({ cwd: root }),
    );
    expect(result.data).toMatchObject({ application: 'echo', service: 'echo' });
  });

  it('requires login when no credentials are stored', async () => {
    const { greeter } = makeWorkspace();
    await expect(
      runWasmcloudDestroy(
        ['--target', 'development'],
        captureIo().io,
        fakeDeps({ cwd: greeter, env: { DI_FRAMEWORK_DEPLOY_TOKEN: '' } }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_LOGIN_REQUIRED', exitCode: 2 });
  });
});
