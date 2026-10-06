import { Bean, Component, Configuration, Container, Cron } from '@di-framework/core/decorators';
import { Value } from '@di-framework/config';
import { useContainer } from '@di-framework/core/container';
import { KeyValue, Postgres, WasmCloudBinding } from '@di-framework/bindings';
import { createTcpServer } from '@di-framework/socket/node';
import { ActorRuntime } from '@di-framework/actors/portable';

export const listen = createTcpServer;
export const runtime = ActorRuntime;
export const container = useContainer;

@Configuration()
export class AppConfiguration {
  @Bean()
  port() {
    return 8080;
  }

  @Bean('serverUrl', { dependencies: ['port'] })
  serverUrl(port: number) {
    return `http://localhost:${port}`;
  }
}

@Container()
export class UserService {
  @Value('database.host')
  host!: string;

  constructor(@Component(DatabaseService) private db: DatabaseService) {}

  @Cron('0 2 * * *')
  prune() {
    return this.db;
  }
}

@Controller()
export class UsersController {
  constructor(@Component(UserService) private users: UserService) {}

  list() {
    return this.users;
  }
}

@WasmCloudBinding('orders-db', { serviceName: 'orders' })
export class OrdersDatabase extends Postgres {
  query() {
    return [];
  }
}

@WasmCloudBinding('sessions', { config: { database: 'sessions' } })
export class Sessions extends KeyValue {
  open() {
    return 'sessions';
  }
}

export class User {
  @Id()
  @GeneratedValue({ strategy: 'uuid' })
  id!: string;
}

declare class DatabaseService {}
declare function Controller(): ClassDecorator;
declare class Postgres {}
declare function Id(): PropertyDecorator;
declare function GeneratedValue(options: { strategy: string }): PropertyDecorator;
