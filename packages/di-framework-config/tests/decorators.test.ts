import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useContainer } from '@di-framework/core/container';
import { Container } from '@di-framework/core/decorators';
import { z } from 'zod';
import { zodSchema } from '../src/adapters/zod.ts';
import { Configuration, Value, WithProfile } from '../src/decorators.ts';
import { envSource } from '../src/sources/env.ts';
import { jsonFileSource } from '../src/sources/json-file.ts';
import { objectSource } from '../src/sources/object.ts';

describe('Configuration / Value', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  it('loads sources, registers token, and injects via @Value', () => {
    @Configuration({
      sources: [
        objectSource({
          database: { host: 'db.local', port: 5432 },
          apiKey: 'secret',
        }),
      ],
    })
    class AppConfig {
      database = { host: 'localhost', port: 5432 };
      apiKey = '';
    }

    @Container()
    class DatabaseService {
      @Value('database.host')
      host!: string;

      @Value('database.port')
      port!: number;

      constructor(@Value('apiKey') public apiKey: string) {}
    }

    const c = useContainer();
    const cfg = c.resolve(AppConfig);
    expect(cfg.database.host).toBe('db.local');
    expect(c.resolve<string>('config.apiKey')).toBe('secret');

    const db = c.resolve(DatabaseService);
    expect(db.host).toBe('db.local');
    expect(db.port).toBe(5432);
    expect(db.apiKey).toBe('secret');
  });

  it('merges env over class defaults', () => {
    @Configuration({
      sources: [
        envSource({
          prefix: 'APP_',
          env: { APP_PORT: '8080', APP_HOST: '0.0.0.0' },
        }),
      ],
    })
    class AppConfig {
      host = '127.0.0.1';
      port = 3000;
    }

    const cfg = useContainer().resolve(AppConfig);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.port).toBe(8080);
  });

  it('supports zod schema via adapter', () => {
    const schema = zodSchema(
      z.object({
        port: z.number().int().positive(),
        name: z.string().default('app'),
      }),
    );

    @Configuration({
      sources: [objectSource({ port: 9 })],
      schema,
    })
    class AppConfig {
      port!: number;
      name!: string;
    }

    const cfg = useContainer().resolve(AppConfig);
    expect(cfg.port).toBe(9);
    expect(cfg.name).toBe('app');
  });

  it('skips class registration and tolerates throwing constructors for defaults', () => {
    @Configuration({
      sources: [objectSource({ ok: true })],
      registerClass: false,
      token: 'cfg2',
    })
    class ThrowsOnConstruct {
      ok = false;
      constructor() {
        throw new Error('no defaults');
      }
    }

    expect(ThrowsOnConstruct).toBeDefined();
    expect(useContainer().has(ThrowsOnConstruct)).toBe(false);
    expect(useContainer().resolve<{ ok: boolean }>('cfg2')).toEqual({ ok: true });
  });

  it('WithProfile overlays {profile}.config.{ext} for file sources', () => {
    const dir = join(import.meta.dir, '.tmp-with-profile');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ host: 'base', port: 1 }));
    writeFileSync(join(dir, 'dev.config.json'), JSON.stringify({ port: 8080 }));
    try {
      @WithProfile('dev')
      @Configuration({
        sources: [jsonFileSource(file)],
        token: 'profiled',
      })
      class AppConfig {
        host = 'localhost';
        port = 3000;
      }

      const cfg = useContainer().resolve(AppConfig);
      expect(cfg.host).toBe('base');
      expect(cfg.port).toBe(8080);
      expect(useContainer().resolve<number>('profiled.port')).toBe(8080);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
