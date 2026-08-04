import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useContainer } from '@di-framework/core/container';
import { coerceEnvValue, toCamelCase } from '../src/coerce.ts';
import { loadConfig, loadConfigSync } from '../src/load.ts';
import { deepMerge, flattenEntries, getByPath, setByPath } from '../src/path.ts';
import { registerConfig } from '../src/register.ts';
import { schemaFromParse } from '../src/schema.ts';
import { envSource } from '../src/sources/env.ts';
import { jsonFileSource } from '../src/sources/json-file.ts';
import { objectSource } from '../src/sources/object.ts';

describe('path helpers', () => {
  it('getByPath / setByPath', () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, 'a.b.c', 1);
    expect(obj).toEqual({ a: { b: { c: 1 } } });
    expect(getByPath(obj, 'a.b.c')).toBe(1);
    expect(getByPath(obj, 'a.x')).toBeUndefined();
  });

  it('deepMerge prefers later source', () => {
    expect(deepMerge({ a: 1, b: { x: 1, y: 1 } }, { b: { y: 2 }, c: 3 })).toEqual({
      a: 1,
      b: { x: 1, y: 2 },
      c: 3,
    });
  });

  it('flattenEntries includes nested paths', () => {
    const entries = flattenEntries({ a: 1, b: { c: 2 } });
    expect(entries).toContainEqual(['a', 1]);
    expect(entries).toContainEqual(['b', { c: 2 }]);
    expect(entries).toContainEqual(['b.c', 2]);
  });

  it('deepMerge rejects excessive depth', () => {
    let nested: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) nested = { child: nested };
    expect(() => deepMerge({}, nested, 5)).toThrow(/max object depth/);
  });

  it('deepMerge rejects cyclic graphs', () => {
    const a: Record<string, unknown> = { x: 1 };
    const b: Record<string, unknown> = { y: a };
    a.b = b;
    expect(() => deepMerge({}, a)).toThrow(/cyclic/);
  });

  it('flattenEntries rejects excessive depth', () => {
    let nested: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) nested = { child: nested };
    expect(() => flattenEntries(nested, '', 5)).toThrow(/max object depth/);
  });
});

describe('coerce', () => {
  it('coerces booleans, numbers, json', () => {
    expect(coerceEnvValue('true')).toBe(true);
    expect(coerceEnvValue('false')).toBe(false);
    expect(coerceEnvValue('42')).toBe(42);
    expect(coerceEnvValue('3.5')).toBe(3.5);
    expect(coerceEnvValue('{"a":1}')).toEqual({ a: 1 });
    expect(coerceEnvValue('hello')).toBe('hello');
  });

  it('toCamelCase', () => {
    expect(toCamelCase('DATABASE_HOST')).toBe('databaseHost');
    expect(toCamelCase('port')).toBe('port');
  });
});

describe('sources', () => {
  it('envSource strips prefix, nests on __, camelCases', () => {
    const src = envSource({
      prefix: 'APP_',
      env: {
        APP_PORT: '3000',
        APP_DB__HOST: 'localhost',
        APP_DB__PORT: '5432',
        OTHER: 'ignored',
      },
    });
    expect(src.load()).toEqual({
      port: 3000,
      db: { host: 'localhost', port: 5432 },
    });
  });

  it('objectSource returns a shallow copy', () => {
    const value = { a: 1 };
    const loaded = objectSource(value).load() as Record<string, unknown>;
    expect(loaded).toEqual({ a: 1 });
    expect(loaded).not.toBe(value);
  });

  it('jsonFileSource reads JSON objects', () => {
    const dir = join(import.meta.dir, '.tmp-config');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'cfg.json');
    writeFileSync(file, JSON.stringify({ host: 'h', nested: { n: 1 } }));
    try {
      expect(jsonFileSource(file).load()).toEqual({ host: 'h', nested: { n: 1 } });
      expect(jsonFileSource(join(dir, 'missing.json'), { optional: true }).load()).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig', () => {
  it('merges defaults and sources left-to-right', async () => {
    const config = await loadConfig({
      defaults: { a: 1, b: { x: 1 } },
      sources: [objectSource({ b: { y: 2 }, c: 3 }), objectSource({ c: 4 })],
    });
    expect(config).toEqual({ a: 1, b: { x: 1, y: 2 }, c: 4 });
  });

  it('applies schema', () => {
    const config = loadConfigSync({
      sources: [objectSource({ port: '3000' })],
      schema: schemaFromParse((input) => {
        const obj = input as { port: string };
        return { port: Number(obj.port) };
      }),
    });
    expect(config).toEqual({ port: 3000 });
  });
});

describe('registerConfig', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  it('registers root and flattened tokens', () => {
    const c = useContainer();
    registerConfig({ db: { host: 'localhost' }, port: 1 });
    expect(c.resolve<{ db: { host: string }; port: number }>('config')).toEqual({
      db: { host: 'localhost' },
      port: 1,
    });
    expect(c.resolve<number>('config.port')).toBe(1);
    expect(c.resolve<{ host: string }>('config.db')).toEqual({ host: 'localhost' });
    expect(c.resolve<string>('config.db.host')).toBe('localhost');
  });
});
