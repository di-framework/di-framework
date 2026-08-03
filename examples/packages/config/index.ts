/**
 * @di-framework/config example
 *
 * Load AppConfig from defaults + env, inject nested values into a service.
 */

import { Configuration, envSource, Value } from '@di-framework/config';
import { useContainer } from '@di-framework/core/container';
import { Container } from '@di-framework/core/decorators';

@Configuration({
  sources: [
    envSource({
      prefix: 'APP_',
      env: {
        APP_PORT: '8080',
        APP_DATABASE__HOST: 'db.example',
        APP_DATABASE__PORT: '5432',
      },
    }),
  ],
})
class AppConfig {
  host = 'localhost';
  port = 3000;
  database = { host: 'localhost', port: 5432 };
}

@Container()
class DatabaseService {
  @Value('database.host')
  host!: string;

  @Value('database.port')
  port!: number;

  constructor(@Value('host') public listenHost: string) {}

  describe() {
    return `${this.listenHost} → ${this.host}:${this.port}`;
  }
}

const container = useContainer();
const cfg = container.resolve(AppConfig);
const db = container.resolve(DatabaseService);

console.log('config.port =', cfg.port);
console.log('database    =', db.describe());

container.clear();
