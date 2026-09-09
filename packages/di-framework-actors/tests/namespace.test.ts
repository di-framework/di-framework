import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Actor,
  ActorAmbiguityError,
  ActorContext,
  ActorMethod,
  ActorRuntime,
  SqliteActorStorage,
} from '../src/index.js';

describe('Actor Namespace and Multi-Application Workspaces', () => {
  let tmpDir: string;
  let storage: SqliteActorStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-ns-test-'));
    storage = new SqliteActorStorage({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await storage.close();
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('configures namespace at runtime level without embedding deployment details in actor methods', async () => {
    @Actor()
    class ConfiguredActor {
      @ActorContext()
      ctx!: ActorContext;

      @ActorMethod()
      async setValue(val: string): Promise<void> {
        // Method only interacts with context.storage, unaware of baseDir, path, or namespace
        await this.ctx.storage.set('item', val);
      }

      @ActorMethod()
      async getValue(): Promise<string> {
        return (await this.ctx.storage.get('item')) ?? 'none';
      }
    }

    const runtimeA = new ActorRuntime({ storage, namespace: 'tenant-alpha' });
    const runtimeB = new ActorRuntime({ storage, namespace: 'tenant-beta' });

    runtimeA.register(ConfiguredActor);
    runtimeB.register(ConfiguredActor);

    const actorA = runtimeA.get(ConfiguredActor, 'shared-key');
    const actorB = runtimeB.get(ConfiguredActor, 'shared-key');

    await actorA.setValue('alpha-data');
    await actorB.setValue('beta-data');

    expect(await actorA.getValue()).toBe('alpha-data');
    expect(await actorB.getValue()).toBe('beta-data');

    // Storage files should be partitioned under tenant-alpha and tenant-beta
    expect(fs.existsSync(path.join(tmpDir, 'tenant-alpha'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tenant-beta'))).toBe(true);
  });

  it('supports duplicate actor names across namespaces in the same runtime with typed class lookup', async () => {
    const runtime = new ActorRuntime({ storage });

    // App 1 Counter
    @Actor()
    class Counter {
      @ActorContext()
      ctx!: ActorContext;

      @ActorMethod()
      async inc(): Promise<number> {
        const cur = (await this.ctx.storage.get<number>('cnt')) ?? 0;
        await this.ctx.storage.set('cnt', cur + 1);
        return cur + 1;
      }
    }

    // App 2 Counter (same actor name "Counter" via decorator)
    @Actor({ name: 'Counter' })
    class App2Counter {
      @ActorContext()
      ctx!: ActorContext;

      @ActorMethod()
      async inc(): Promise<number> {
        const cur = (await this.ctx.storage.get<number>('cnt')) ?? 100;
        await this.ctx.storage.set('cnt', cur + 10);
        return cur + 10;
      }
    }

    runtime.register(Counter, { namespace: 'billing' });
    runtime.register(App2Counter, { namespace: 'analytics' });

    // Typed lookup by class reference is always unambiguous
    const billingRef = runtime.get(Counter, 'primary');
    const analyticsRef = runtime.get(App2Counter, 'primary');

    expect(await billingRef.inc()).toBe(1);
    expect(await analyticsRef.inc()).toBe(110);

    // Qualified string lookup works
    const qBilling = runtime.get<any>('billing:Counter', 'primary');
    const qAnalytics = runtime.get<any>('analytics:Counter', 'primary');

    expect(await (qBilling as any).inc()).toBe(2);
    expect(await (qAnalytics as any).inc()).toBe(120);
  });

  it('throws ActorAmbiguityError when referencing ambiguous duplicate actor name by short string', async () => {
    const runtime = new ActorRuntime({ storage });

    @Actor({ name: 'Order' })
    class SalesOrder {
      @ActorMethod()
      async test(): Promise<string> {
        return 'sales';
      }
    }

    @Actor({ name: 'Order' })
    class WarehouseOrder {
      @ActorMethod()
      async test(): Promise<string> {
        return 'warehouse';
      }
    }

    runtime.register(SalesOrder, { namespace: 'sales' });
    runtime.register(WarehouseOrder, { namespace: 'warehouse' });

    // Referencing without namespace qualification should throw ActorAmbiguityError
    expect(() => {
      runtime.get('Order', '123');
    }).toThrow(ActorAmbiguityError);

    try {
      runtime.get('Order', '123');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ActorAmbiguityError);
      expect(err.candidates).toContain('sales');
      expect(err.candidates).toContain('warehouse');
      expect(err.message).toContain('Disambiguate');
    }
  });
});
