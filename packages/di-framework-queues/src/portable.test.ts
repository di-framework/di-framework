import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('portable queue entry excludes native SQLite and filesystem imports', async () => {
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, 'portable.ts')],
    target: 'node',
    packages: 'external',
  });
  expect(bundle.success).toBe(true);
  const output = await bundle.outputs[0]?.text();
  expect(output).toContain('QueueWorker');
  expect(output).toContain('ContainerQueueDispatcher');
  expect(output).not.toContain('bun:sqlite');
  expect(output).not.toContain('node:fs');
});
