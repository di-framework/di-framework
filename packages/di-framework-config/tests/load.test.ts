import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useContainer } from '@di-framework/core/container';
import { loadAndRegisterConfig, loadAndRegisterConfigSync } from '../src/bootstrap.ts';
import { coerceEnvValue, toCamelCase } from '../src/coerce.ts';
import { loadConfig, loadConfigSync } from '../src/load.ts';
import { deepMerge, flattenEntries, getByPath, setByPath } from '../src/path.ts';
import { registerConfig } from '../src/register.ts';
import { identitySchema, schemaFromParse } from '../src/schema.ts';
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

  it('flattenEntries rejects cyclic graphs', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => flattenEntries(a)).toThrow(/cyclic/);
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

  it('returns raw string when JSON-looking value fails to parse', () => {
    expect(coerceEnvValue('{not-json}')).toBe('{not-json}');
    expect(coerceEnvValue('[not-json]')).toBe('[not-json]');
  });

  it('toCamelCase', () => {
    expect(toCamelCase('DATABASE_HOST')).toBe('databaseHost');
    expect(toCamelCase('port')).toBe('port');
  });
});

describe('schema helpers', () => {
  it('identitySchema returns input unchanged', () => {
    const schema = identitySchema<{ a: number }>();
    expect(schema.parse({ a: 1 })).toEqual({ a: 1 });
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

  it('jsonFileSource rejects non-object JSON and missing required files', () => {
    const dir = join(import.meta.dir, '.tmp-config-bad');
    mkdirSync(dir, { recursive: true });
    const arr = join(dir, 'arr.json');
    writeFileSync(arr, '[]');
    try {
      expect(() => jsonFileSource(arr).load()).toThrow(/must be an object/);
      expect(() => jsonFileSource(join(dir, 'nope.json')).load()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('envSource skips undefined values, empty keys, and supports coerce=false', () => {
    const src = envSource({
      prefix: 'X_',
      coerce: false,
      keyCase: 'lower',
      env: {
        X_: 'ignored-empty',
        X_NAME: 'raw',
        X_SKIP: undefined,
        OTHER: 'no',
      },
    });
    expect(src.load()).toEqual({ name: 'raw' });
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

  it('applies schema asynchronously via loadConfig', async () => {
    const config = await loadConfig({
      sources: [objectSource({ port: '3000' })],
      schema: schemaFromParse((input) => {
        const obj = input as { port: string };
        return { port: Number(obj.port) };
      }),
    });
    expect(config).toEqual({ port: 3000 });
  });

  it('wraps source load failures with a labeled error', async () => {
    await expect(
      loadConfig({
        sources: [
          {
            name: 'broken',
            load() {
              throw new Error('boom');
            },
          },
        ],
      }),
    ).rejects.toThrow(/Failed to load config from broken: boom/);
  });

  it('stringifies non-Error load failures', async () => {
    await expect(
      loadConfig({
        sources: [
          {
            load() {
              throw 'plain';
            },
          },
        ],
      }),
    ).rejects.toThrow(/Failed to load config from source: plain/);
  });

  it('rejects async sources in loadConfigSync', () => {
    expect(() =>
      loadConfigSync({
        sources: [
          {
            name: 'async-src',
            load() {
              return Promise.resolve({ a: 1 });
            },
          },
        ],
      }),
    ).toThrow(/async-src.*async/);
  });
});

describe('loadAndRegisterConfig', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  it('loads async then registers into the container', async () => {
    const config = await loadAndRegisterConfig({
      sources: [objectSource({ port: 9 })],
    });
    expect(config).toEqual({ port: 9 });
    expect(useContainer().resolve<number>('config.port')).toBe(9);
  });

  it('loads sync then registers into the container', () => {
    const config = loadAndRegisterConfigSync({
      sources: [objectSource({ host: 'h' })],
      schema: identitySchema<{ host: string }>(),
    });
    expect(config).toEqual({ host: 'h' });
    expect(useContainer().resolve<string>('config.host')).toBe('h');
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

  it('skips flatten for arrays and when flatten=false', () => {
    const c = useContainer();
    registerConfig([1, 2], { token: 'arr', flatten: false });
    expect(c.resolve<number[]>('arr')).toEqual([1, 2]);
    expect(c.has('arr.0')).toBe(false);
  });

  it('throws when container lacks registerFactory', () => {
    expect(() => registerConfig({ a: 1 }, { container: {} as never })).toThrow(
      /does not support registerFactory/,
    );
  });
});

describe('path edge cases', () => {
  it('getByPath / setByPath guard dangerous and empty paths', () => {
    expect(getByPath({ a: 1 }, '')).toEqual({ a: 1 });
    expect(getByPath({ a: 1 }, '__proto__.x')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
    const obj: Record<string, unknown> = {};
    setByPath(obj, '', 1);
    expect(obj).toEqual({});
    setByPath(obj, '__proto__.x', 1);
    expect(Object.hasOwn(obj, '__proto__')).toBe(false);
    setByPath(obj, 'list.0', 'via-array-replace');
    expect(obj).toEqual({ list: { '0': 'via-array-replace' } });
  });
});
