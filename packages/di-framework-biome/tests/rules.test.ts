import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageRoot, '../..');
const biome = join(repoRoot, 'node_modules/.bin/biome');
const config = join(packageRoot, 'fixtures/config.json');

const invalid = [
  ['no-bootstrap-decorator.ts', '@Bootstrap()'],
  ['no-reflect-metadata.ts', 'reflect-metadata'],
  ['no-wasmcloud-package.ts', '@di-framework/bindings'],
  ['no-cli-plugin-wasmcloud.ts', '@di-framework/cli-plugin-platform'],
  ['no-socket-bun-alias.ts', '@di-framework/socket/node'],
  ['no-actors-testing-import.ts', 'bun:test'],
  ['use-scoped-core-import.ts', 'second container'],
  ['use-configuration-import.ts', '@di-framework/core/decorators'],
  ['no-bean-outside-configuration.ts', '@Configuration()'],
  ['use-bean-dependencies.ts', 'dependencies'],
  ['no-inject-outside-container.ts', '@Container()'],
  ['no-bad-cron-expression.ts', '5-field'],
  ['no-generated-value-without-id.ts', '@GeneratedValue'],
  ['no-plaintext-binding-secret.ts', 'secretFrom'],
  ['use-wit-binding-name.ts', 'WIT identifiers'],
  ['no-service-name-on-non-postgres.ts', 'Postgres'],
  ['no-short-auth-secret.ts', '32 bytes'],
  ['no-emit-decorator-metadata.json', 'emitDecoratorMetadata'],
  ['use-experimental-decorators.json', 'experimentalDecorators'],
] as const;

function lint(path: string) {
  return spawnSync(biome, ['lint', '--config-path', config, '--diagnostic-level=error', path], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

describe('@di-framework/biome', () => {
  for (const [file, message] of invalid) {
    it(`reports ${file}`, () => {
      const result = lint(join(packageRoot, 'fixtures/invalid', file));
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain(message);
    });
  }

  it('accepts the recommended patterns', () => {
    const result = lint(join(packageRoot, 'fixtures/valid'));
    expect(result.status).toBe(0);
  });
});
