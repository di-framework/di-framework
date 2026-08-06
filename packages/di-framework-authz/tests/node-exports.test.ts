import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

describe('published Node exports', () => {
  it('shares policy registrations across the root and HTTP entry points', async () => {
    const packagesDir = join(import.meta.dir, '..', '..');
    for (const name of [
      'di-framework-core',
      'di-framework-http',
      'di-framework-auth',
      'di-framework-authz',
    ]) {
      const build = Bun.spawn(['bun', 'run', 'build'], {
        cwd: join(packagesDir, name),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const buildExit = await build.exited;
      const buildError = await new Response(build.stderr).text();
      expect(buildExit, `${name}: ${buildError}`).toBe(0);
    }

    const node = Bun.spawn(['node', join(import.meta.dir, 'node-exports.mjs')], {
      cwd: join(packagesDir, 'di-framework-authz'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const nodeExit = await node.exited;
    const nodeError = await new Response(node.stderr).text();
    expect(nodeExit, nodeError).toBe(0);
  });
});
