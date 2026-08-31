import { Component, Container } from '@di-framework/core/decorators';
import { LoggerService } from '@di-framework/services-example/LoggerService';

type Env = unknown | any;

@Container()
export class CounterService {
  constructor(@Component(LoggerService) private readonly logger: LoggerService) {}

  private getStub(env: Env) {
    return (env as any).MY_DURABLE_OBJECT.getByName('counter');
  }

  async increment(env: Env, delta = 1) {
    const next = await this.getStub(env).increment(delta);
    this.logger.log(`Counter incremented by ${delta} -> ${next}`);
    return next;
  }

  async get(env: Env) {
    const value = await this.getStub(env).getCount();
    this.logger.log(`Counter read -> ${value}`);
    return value;
  }

  async reset(env: Env) {
    const value = await this.getStub(env).reset();
    this.logger.log(`Counter reset -> ${value}`);
    return value;
  }
}
