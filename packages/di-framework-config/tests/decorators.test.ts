import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { Container } from '@di-framework/core/decorators';
import { z } from 'zod';
import { zodSchema } from '../src/adapters/zod.ts';
import { Configuration, Value } from '../src/decorators.ts';
import { envSource } from '../src/sources/env.ts';
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
});
