import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const CLI_PATH = path.resolve(import.meta.dir, 'cli.ts');
const TEST_OUTPUT = 'test.openapi.json';

describe('CLI', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_OUTPUT)) {
      fs.unlinkSync(TEST_OUTPUT);
    }
  });

  it('should show help when no command is provided', () => {
    const { stdout } = spawnSync('bun', [CLI_PATH]);
    expect(stdout.toString()).toContain('Usage: di-framework-http generate');
  });

  it('should error when --controllers is missing', () => {
    const { stderr, status } = spawnSync('bun', [CLI_PATH, 'generate']);
    expect(status).toBe(1);
    expect(stderr.toString()).toContain('Error: --controllers path is required');
  });

  it('should generate OpenAPI spec with --controllers and --output', () => {
    const controllersPath = path.resolve(
      import.meta.dir,
      '../../../examples/packages/http-router/index.ts',
    );
    const { stdout, status } = spawnSync('bun', [
      CLI_PATH,
      'generate',
      '--controllers',
      controllersPath,
      '--output',
      TEST_OUTPUT,
    ]);

    expect(status).toBe(0);
    expect(stdout.toString()).toContain('Successfully generated OpenAPI spec at test.openapi.json');
    expect(fs.existsSync(TEST_OUTPUT)).toBe(true);

    const spec = JSON.parse(fs.readFileSync(TEST_OUTPUT, 'utf8'));
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/echo']).toBeDefined();
    expect(spec.paths['/echo'].post).toBeDefined();
  });

  it('should use default output path (openapi.json) if --output is missing', () => {
    const DEFAULT_OUTPUT = 'openapi.json';
    if (fs.existsSync(DEFAULT_OUTPUT)) fs.unlinkSync(DEFAULT_OUTPUT);

    const controllersPath = path.resolve(
      import.meta.dir,
      '../../../examples/packages/http-router/index.ts',
    );
    const { status } = spawnSync('bun', [CLI_PATH, 'generate', '--controllers', controllersPath]);

    expect(status).toBe(0);
    expect(fs.existsSync(DEFAULT_OUTPUT)).toBe(true);
    fs.unlinkSync(DEFAULT_OUTPUT);
  });

  it('should error with invalid controllers path', () => {
    const { stderr, status } = spawnSync('bun', [
      CLI_PATH,
      'generate',
      '--controllers',
      './non-existent-file.ts',
    ]);
    expect(status).toBe(1);
    expect(stderr.toString()).toContain('Error generating OpenAPI spec');
  });
});
