import { Component, Container } from '@di-framework/di-framework/decorators';
import { LoggerService } from '../../../services/LoggerService';

@Container()
export class CounterService {
  constructor(@Component(LoggerService) private readonly logger: LoggerService) {}

  private getStub(env: any) {
    return (env as any).MY_DURABLE_OBJECT.getByName('counter');
  }

  async increment(env: any, delta = 1) {
    const next = await this.getStub(env).increment(delta);
    this.logger.log(`Counter incremented by ${delta} -> ${next}`);
    return next;
  }

  async get(env: any) {
    const value = await this.getStub(env).getCount();
    this.logger.log(`Counter read -> ${value}`);
    return value;
  }

  async reset(env: any) {
    const value = await this.getStub(env).reset();
    this.logger.log(`Counter reset -> ${value}`);
    return value;
  }
}
