import { describe, expect, it } from 'bun:test';
import { Actor } from '../decorators/Actor';
import { ActorContext } from '../decorators/ActorContext';
import { ActorMethod } from '../decorators/ActorMethod';
import type { ActorMigrationDefinition } from '../migrations/types';
import type { ActorContext as ActorContextType } from '../runtime/context';

@Actor({ name: 'ContractCounter' })
export class ContractCounterActor {
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
  async slowIncrement(by: number = 1, delayMs: number = 15): Promise<number> {
    const current = (await this.context.storage.get<number>('count')) ?? 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const next = current + by;
    await this.context.storage.set('count', next);
    return next;
  }

  @ActorMethod()
  async failDuringExecution(message: string): Promise<void> {
    const current = (await this.context.storage.get<number>('count')) ?? 0;
    await this.context.storage.set('count', current + 100);
    throw new Error(message);
  }
}

export const FAILING_MIGRATION: ActorMigrationDefinition = {
  version: 1,
  description: 'failing initial schema',
  up: async () => {
    throw new Error('Migration failed intentionally');
  },
};

@Actor({
  name: 'ContractFailingMigrationActor',
  migrations: [FAILING_MIGRATION],
})
export class ContractFailingMigrationActor {
  @ActorMethod()
  async ping(): Promise<string> {
    return 'pong';
  }
}

export interface ActorContractAdapter {
  invoke(actorType: string, actorKey: string, method: string, args?: unknown[]): Promise<any>;
  restart(): Promise<void>;
  simulateBindingFailure?(): Promise<void>;
}

export interface ActorContractSuiteOptions {
  name: string;
  createAdapter: () => Promise<ActorContractAdapter>;
  cleanup?: () => Promise<void>;
}

export function defineActorContractSuite(options: ActorContractSuiteOptions): void {
  describe(`Actor Contract Tests: ${options.name}`, () => {
    it('supports basic invocation, parameter passing, and typed results', async () => {
      const adapter = await options.createAdapter();
      const initial = await adapter.invoke('ContractCounter', 'inst-1', 'getCount');
      expect(initial).toBe(0);

      const res1 = await adapter.invoke('ContractCounter', 'inst-1', 'increment', [5]);
      expect(res1).toBe(5);

      const res2 = await adapter.invoke('ContractCounter', 'inst-1', 'increment', [3]);
      expect(res2).toBe(8);

      const finalCount = await adapter.invoke('ContractCounter', 'inst-1', 'getCount');
      expect(finalCount).toBe(8);
    });

    it('propagates invocation errors and reports non-existent actors/methods', async () => {
      const adapter = await options.createAdapter();

      await expect(
        adapter.invoke('ContractCounter', 'inst-err', 'failDuringExecution', ['boom']),
      ).rejects.toThrow();

      await expect(
        adapter.invoke('ContractCounter', 'inst-err', 'nonExistentMethod'),
      ).rejects.toThrow();

      await expect(adapter.invoke('UnknownActor', 'inst-err', 'someMethod')).rejects.toThrow();
    });

    it('strictly serializes concurrent invocations for the same actor (mailbox scheduling)', async () => {
      const adapter = await options.createAdapter();

      const promises = [
        adapter.invoke('ContractCounter', 'sched-1', 'slowIncrement', [1, 20]),
        adapter.invoke('ContractCounter', 'sched-1', 'slowIncrement', [2, 10]),
        adapter.invoke('ContractCounter', 'sched-1', 'slowIncrement', [3, 5]),
      ];

      const results = await Promise.all(promises);
      expect(results).toEqual([1, 3, 6]);

      const count = await adapter.invoke('ContractCounter', 'sched-1', 'getCount');
      expect(count).toBe(6);
    });

    it('persists state across restarts and rolls back transactions on error', async () => {
      const adapter = await options.createAdapter();

      await adapter.invoke('ContractCounter', 'persist-1', 'increment', [42]);
      expect(await adapter.invoke('ContractCounter', 'persist-1', 'getCount')).toBe(42);

      // Verify transaction rollback
      try {
        await adapter.invoke('ContractCounter', 'persist-1', 'failDuringExecution', [
          'fail-rollback',
        ]);
      } catch {
        // Expected
      }

      // Count must still be 42, not 142
      expect(await adapter.invoke('ContractCounter', 'persist-1', 'getCount')).toBe(42);

      // Simulate restart
      await adapter.restart();

      // State must survive restart
      expect(await adapter.invoke('ContractCounter', 'persist-1', 'getCount')).toBe(42);
    });

    it('fails activation before allowing calls when migrations fail', async () => {
      const adapter = await options.createAdapter();

      let caughtError: any;
      try {
        await adapter.invoke('ContractFailingMigrationActor', 'fail-inst', 'ping');
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      expect(
        caughtError.message.includes('Migration failed intentionally') ||
          caughtError.name === 'ActorMigrationError' ||
          caughtError.message.includes('ContractFailingMigrationActor'),
      ).toBe(true);
    });

    it('handles binding failures gracefully without process crashes', async () => {
      const adapter = await options.createAdapter();
      if (adapter.simulateBindingFailure) {
        await adapter.simulateBindingFailure();
        await expect(
          adapter.invoke('ContractCounter', 'inst-bind-fail', 'increment', [1]),
        ).rejects.toThrow();
      }
    });
  });
}
