import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Actor,
  ActorBackpressureError,
  ActorContext,
  ActorMethod,
  ActorRpcDispatcher,
  ActorRuntime,
  createActorBindingPolicy,
  InMemoryActorStorage,
  MemoryActorTransport,
  RemoteActorClient,
  SqliteActorStorage,
  StaleOwnerWriteError,
} from '../src/index.js';

@Actor({ name: 'OrderActor' })
class OrderActor {
  @ActorContext()
  ctx!: ActorContext;

  private callCount = 0;

  @ActorMethod()
  async placeOrder(
    orderId: string,
    amount: number,
  ): Promise<{ orderId: string; total: number; callCount: number }> {
    this.callCount++;
    const prevTotal = (await this.ctx.storage.get<number>('total')) ?? 0;
    const newTotal = prevTotal + amount;
    await this.ctx.storage.set('total', newTotal);
    await this.ctx.storage.set('lastOrderId', orderId);
    return { orderId, total: newTotal, callCount: this.callCount };
  }

  @ActorMethod()
  async getTotal(): Promise<number> {
    return (await this.ctx.storage.get<number>('total')) ?? 0;
  }

  @ActorMethod()
  async slowOperation(delayMs: number): Promise<string> {
    await new Promise((res) => setTimeout(res, delayMs));
    return 'done';
  }
}

describe('Distributed Actors Protocol & Reliability', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(
      '/tmp',
      `actors-dist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. RPC Dispatch & Identity', () => {
    it('dispatches RPC requests with full identity metadata and returns typed response', async () => {
      const storage = new InMemoryActorStorage();
      const runtime = new ActorRuntime({ storage, actors: [OrderActor] });
      const dispatcher = new ActorRpcDispatcher({ runtime });

      const request = {
        requestId: 'req-001',
        namespace: 'ecommerce',
        actorType: 'OrderActor',
        actorKey: 'user-42',
        method: 'placeOrder',
        args: ['ord-101', 50],
        callerId: 'checkout-service',
      };

      const response = await dispatcher.dispatch(request);

      expect(response.requestId).toBe('req-001');
      expect(response.success).toBe(true);
      expect(response.result).toEqual({ orderId: 'ord-101', total: 50, callCount: 1 });

      // Query state directly
      const total = await storage.get('ecommerce:OrderActor:user-42', 'total');
      expect(total).toBe(50);
    });

    it('validates request structure and rejects malformed requests', async () => {
      const runtime = new ActorRuntime({ actors: [OrderActor] });
      const dispatcher = new ActorRpcDispatcher({ runtime });

      const invalidReq: any = {
        requestId: '',
        actorType: 'OrderActor',
      };

      const resp = await dispatcher.dispatch(invalidReq);
      expect(resp.success).toBe(false);
      expect(resp.error?.name).toBe('InvalidRequestError');
    });
  });

  describe('2. Authorization Boundaries & Binding Policies', () => {
    it('enforces caller, namespace, and method authorization boundaries', async () => {
      const authPolicy = createActorBindingPolicy({
        allowedCallers: ['trusted-gateway', 'internal-admin'],
        allowedNamespaces: ['production', 'default'],
        allowedActorTypes: ['OrderActor'],
        allowedMethods: {
          OrderActor: ['getTotal'], // 'placeOrder' is intentionally NOT allowed for external callers
        },
      });

      const runtime = new ActorRuntime({
        actors: [OrderActor],
        authorizationPolicy: authPolicy,
      });
      const dispatcher = new ActorRpcDispatcher({ runtime });

      // Case A: Unauthorized caller
      const resUnauthCaller = await dispatcher.dispatch({
        requestId: 'req-auth-1',
        callerId: 'rogue-service',
        actorType: 'OrderActor',
        actorKey: 'user-1',
        method: 'getTotal',
        args: [],
      });
      expect(resUnauthCaller.success).toBe(false);
      expect(resUnauthCaller.error?.name).toBe('ActorAuthorizationError');
      expect(resUnauthCaller.error?.message).toContain("Caller 'rogue-service' is not authorized");

      // Case B: Unauthorized namespace
      const resUnauthNs = await dispatcher.dispatch({
        requestId: 'req-auth-2',
        callerId: 'trusted-gateway',
        namespace: 'restricted-sandbox',
        actorType: 'OrderActor',
        actorKey: 'user-1',
        method: 'getTotal',
        args: [],
      });
      expect(resUnauthNs.success).toBe(false);
      expect(resUnauthNs.error?.name).toBe('ActorAuthorizationError');
      expect(resUnauthNs.error?.message).toContain(
        "Access to namespace 'restricted-sandbox' is not authorized",
      );

      // Case C: Unauthorized method
      const resUnauthMethod = await dispatcher.dispatch({
        requestId: 'req-auth-3',
        callerId: 'trusted-gateway',
        actorType: 'OrderActor',
        actorKey: 'user-1',
        method: 'placeOrder',
        args: ['ord-1', 100],
      });
      expect(resUnauthMethod.success).toBe(false);
      expect(resUnauthMethod.error?.name).toBe('ActorAuthorizationError');
      expect(resUnauthMethod.error?.message).toContain(
        "Method 'placeOrder' on actor 'OrderActor' is not authorized",
      );

      // Case D: Authorized invocation succeeds
      const resAuth = await dispatcher.dispatch({
        requestId: 'req-auth-4',
        callerId: 'trusted-gateway',
        actorType: 'OrderActor',
        actorKey: 'user-1',
        method: 'getTotal',
        args: [],
      });
      expect(resAuth.success).toBe(true);
      expect(resAuth.result).toBe(0);
    });
  });

  describe('3. Distributed Ownership Protocol & Fencing Tokens', () => {
    it('allocates monotonically increasing generation tokens upon ownership acquisition and failover', async () => {
      const storage = new SqliteActorStorage({ baseDir: tempDir });
      const actorId = 'OrderActor:fencing-test-1';

      // Node 1 acquires ownership
      const rec1 = await storage.acquireOwnership!(actorId, 'node-1', { leaseTtlMs: 5000 });
      expect(rec1.ownerId).toBe('node-1');
      expect(rec1.generation).toBe(1);

      // Node 1 renews lease (generation stays at 1)
      const rec1Renew = await storage.acquireOwnership!(actorId, 'node-1', { leaseTtlMs: 5000 });
      expect(rec1Renew.generation).toBe(1);

      // Node 2 attempts acquire while lease is active -> conflict
      await expect(storage.acquireOwnership!(actorId, 'node-2')).rejects.toThrow();

      // Node 2 forces ownership takeover (failover) -> generation bumps to 2
      const rec2 = await storage.acquireOwnership!(actorId, 'node-2', { force: true });
      expect(rec2.ownerId).toBe('node-2');
      expect(rec2.generation).toBe(2);

      // Node 3 forces takeover -> generation bumps to 3
      const rec3 = await storage.acquireOwnership!(actorId, 'node-3', { force: true });
      expect(rec3.ownerId).toBe('node-3');
      expect(rec3.generation).toBe(3);

      await storage.close();
    });

    it('storage fencing rejects stale owner writes with StaleOwnerWriteError and rolls back changes', async () => {
      const storage = new SqliteActorStorage({ baseDir: tempDir });
      const actorId = 'OrderActor:stale-fencing';

      // 1. Node 1 acquires ownership (gen 1)
      await storage.acquireOwnership!(actorId, 'node-1');

      // 2. Node 1 opens a transaction at generation 1 and stages writes
      const tx1 = await storage.beginTransaction(actorId, { ownerId: 'node-1', generation: 1 });
      await tx1.set('status', 'pending_node_1');
      await tx1.set('balance', 500);

      // 3. Meanwhile, Node 2 takes over ownership (gen 2)
      await storage.acquireOwnership!(actorId, 'node-2', { force: true });

      // 4. Node 1 attempts to commit its transaction with obsolete generation 1
      let threwStaleError = false;
      try {
        await tx1.commit();
      } catch (err: any) {
        threwStaleError = true;
        expect(err.name).toBe('StaleOwnerWriteError');
        expect(err).toBeInstanceOf(StaleOwnerWriteError);
        expect(err.ownerGeneration).toBe(1);
        expect(err.storageGeneration).toBe(2);
      }
      expect(threwStaleError).toBe(true);

      // 5. Verify authoritative storage was rolled back and did NOT apply stale state
      const status = await storage.get(actorId, 'status');
      const balance = await storage.get(actorId, 'balance');
      expect(status).toBeUndefined();
      expect(balance).toBeUndefined();

      // 6. Node 2 (current owner at generation 2) can successfully commit
      const tx2 = await storage.beginTransaction(actorId, { ownerId: 'node-2', generation: 2 });
      await tx2.set('status', 'active_node_2');
      await tx2.set('balance', 999);
      await tx2.commit();

      expect(await storage.get<string>(actorId, 'status')).toBe('active_node_2');
      expect(await storage.get<number>(actorId, 'balance')).toBe(999);

      await storage.close();
    });
  });

  describe('4. Reliability, Deduplication & Idempotency Cache', () => {
    it('returns committed result for retransmitted request with same requestId without re-executing side effects', async () => {
      const storage = new SqliteActorStorage({ baseDir: tempDir });
      const runtime = new ActorRuntime({ storage, actors: [OrderActor] });
      const dispatcher = new ActorRpcDispatcher({ runtime });
      const transport = new MemoryActorTransport(dispatcher);

      // Direct invocation via dispatcher with requestId
      const req1 = {
        requestId: 'req-idem-100',
        actorType: 'OrderActor',
        actorKey: 'account-1',
        method: 'placeOrder',
        args: ['ord-1', 100],
      };

      const resp1 = await dispatcher.dispatch(req1);
      expect(resp1.success).toBe(true);
      expect(resp1.result.total).toBe(100);
      expect(resp1.result.callCount).toBe(1);

      // Simulate lost response / retry: same requestId arrives again
      const resp2 = await dispatcher.dispatch(req1);
      expect(resp2.success).toBe(true);
      // The total MUST still be 100 (NOT 200!) and callCount MUST still be 1!
      expect(resp2.result.total).toBe(100);
      expect(resp2.result.callCount).toBe(1);

      // Confirm committed storage state has only been incremented once
      const totalInStorage = await storage.get('OrderActor:account-1', 'total');
      expect(totalInStorage).toBe(100);

      await storage.close();
    });

    it('client automatically retransmits with same requestId on lost response and receives cached result', async () => {
      const storage = new SqliteActorStorage({ baseDir: tempDir });
      const runtime = new ActorRuntime({ storage, actors: [OrderActor] });
      const dispatcher = new ActorRpcDispatcher({ runtime });
      const transport = new MemoryActorTransport(dispatcher);

      // Configure client with short retry delay
      const client = new RemoteActorClient({
        transport,
        maxRetries: 3,
        retryDelayMs: 20,
      });

      const orderRef = client.get<OrderActor>(OrderActor, 'client-idem-test');

      // First call executes normally
      const res1 = await orderRef.placeOrder('ord-A', 50);
      expect(res1.total).toBe(50);
      expect(res1.callCount).toBe(1);

      // Simulate packet loss on the response of the next invocation:
      // The server will execute the method, commit total = 120, but the response is dropped in flight.
      transport.dropNextResponse();

      // Client should automatically retry with the same requestId, hitting the idempotency cache!
      const res2 = await orderRef.placeOrder('ord-B', 70);
      expect(res2.total).toBe(120);
      // Call count on the actor instance should only have executed once for ord-B!
      expect(res2.callCount).toBe(2);

      // State in storage must reflect exactly 120 (50 + 70)
      const total = await storage.get('OrderActor:client-idem-test', 'total');
      expect(total).toBe(120);

      await storage.close();
    });

    it('rejects expired requests with ActorDeadlineExceededError before execution', async () => {
      const storage = new InMemoryActorStorage();
      const runtime = new ActorRuntime({ storage, actors: [OrderActor] });
      const dispatcher = new ActorRpcDispatcher({ runtime });

      const pastDeadline = Date.now() - 1000; // 1 second in the past

      const response = await dispatcher.dispatch({
        requestId: 'req-expired-1',
        actorType: 'OrderActor',
        actorKey: 'user-expired',
        method: 'placeOrder',
        args: ['ord-x', 999],
        deadline: pastDeadline,
      });

      expect(response.success).toBe(false);
      expect(response.error?.name).toBe('ActorDeadlineExceededError');

      // Verify no storage mutations occurred
      const total = await storage.get('OrderActor:user-expired', 'total');
      expect(total).toBeUndefined();
    });

    it('enforces bounded admission and backpressure limits on actor mailboxes', async () => {
      const storage = new InMemoryActorStorage();
      // Set mailbox capacity to 2 (1 processing + 1 waiting)
      const runtime = new ActorRuntime({
        storage,
        actors: [OrderActor],
        maxMailboxSize: 2,
      });

      const actorKey = 'backpressure-key';

      // Task 1: slow operation that holds the mailbox processing loop
      const p1 = runtime.invoke('OrderActor', actorKey, 'slowOperation', [100]);

      // Give event loop a tick to ensure p1 starts
      await new Promise((res) => setTimeout(res, 5));

      // Task 2: enqueued in mailbox (queue length becomes 1)
      const p2 = runtime.invoke('OrderActor', actorKey, 'slowOperation', [50]);

      // Task 3: enqueued in mailbox (queue length becomes 2 = maxMailboxSize)
      const p3 = runtime.invoke('OrderActor', actorKey, 'slowOperation', [50]);

      // Task 4: should immediately fail with ActorBackpressureError!
      let rejectedBackpressure = false;
      try {
        await runtime.invoke('OrderActor', actorKey, 'slowOperation', [50]);
      } catch (err: any) {
        if (err instanceof ActorBackpressureError || err.name === 'ActorBackpressureError') {
          rejectedBackpressure = true;
          expect(err.actorId).toBe(`OrderActor:${actorKey}`);
        }
      }
      expect(rejectedBackpressure).toBe(true);

      await Promise.all([p1, p2, p3]);
    });
  });
});
