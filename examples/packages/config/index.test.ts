import { beforeEach, describe, expect, it } from 'bun:test';
import { Configuration, envSource, objectSource, Value } from '@di-framework/config';
import { useContainer } from '@di-framework/core/container';
import { Container } from '@di-framework/core/decorators';

describe('config example', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  it('injects env-backed config into a service', () => {
    @Configuration({
      sources: [
        objectSource({ port: 3000 }),
        envSource({
          prefix: 'APP_',
          env: {
            APP_PORT: '9090',
            APP_DATABASE__HOST: 'db.test',
          },
        }),
      ],
    })
    class AppConfig {
      port = 1;
      database = { host: 'localhost' };
    }

    @Container()
    class Api {
      @Value('database.host')
      dbHost!: string;

      constructor(@Value('port') public port: number) {}
    }

    const api = useContainer().resolve(Api);
    expect(api.port).toBe(9090);
    expect(api.dbHost).toBe('db.test');
    expect(useContainer().resolve(AppConfig).port).toBe(9090);
  });
});
