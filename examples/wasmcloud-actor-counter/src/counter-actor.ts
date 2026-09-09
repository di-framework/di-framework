import { Actor, ActorContext, ActorMethod } from '@di-framework/actors';
import type { ActorContext as ActorContextType } from '@di-framework/actors';

@Actor({
  name: 'Counter',
  namespace: 'default',
  migrations: [
    {
      version: 1,
      description: 'initialize counter schema',
      up: async (db) => {
        // Migration automatically executed before actor activation
        db.run(`
          CREATE TABLE IF NOT EXISTS counter_metadata (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `);
      },
    },
  ],
})
export class CounterActor {
  @ActorContext()
  private context!: ActorContextType;

  @ActorMethod()
  async getCount(): Promise<number> {
    return (await this.context.storage.get<number>('count')) ?? 0;
  }

  @ActorMethod()
  async increment(by: number = 1): Promise<number> {
    const current = (await this.context.storage.get<number>('count')) ?? 0;
    const next = current + by;
    await this.context.storage.set('count', next);
    return next;
  }

  @ActorMethod()
  async decrement(by: number = 1): Promise<number> {
    const current = (await this.context.storage.get<number>('count')) ?? 0;
    const next = current - by;
    await this.context.storage.set('count', next);
    return next;
  }

  @ActorMethod()
  async reset(): Promise<number> {
    await this.context.storage.set('count', 0);
    return 0;
  }

  @ActorMethod()
  async failingAction(): Promise<void> {
    const current = (await this.context.storage.get<number>('count')) ?? 0;
    await this.context.storage.set('count', current + 999);
    throw new Error('Action failed intentionally for transaction rollback testing');
  }
}
