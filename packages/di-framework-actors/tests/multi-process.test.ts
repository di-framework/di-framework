/**
 * Multi-Process Integration Test Harness for Distributed Actors.
 * Exercises remote references, competing activations, owner crash failover,
 * storage fencing token verification, state recovery, and duplicate delivery
 * across independent Bun child processes communicating over IPC.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RemoteActorClient } from '../src/distributed/client';
import { spawnTestWorker, type TestWorkerNode } from './harness/cluster';
import { CounterActor } from './harness/worker';

describe('Multi-Process Distributed Actors Integration Harness', () => {
  let tempDir: string;
  const activeWorkers: TestWorkerNode[] = [];

  beforeEach(() => {
    tempDir = path.join(
      '/tmp',
      `actors-multiprocess-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    for (const worker of activeWorkers) {
      worker.kill();
    }
    activeWorkers.length = 0;

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function createWorker(ownerId: string): TestWorkerNode {
    const worker = spawnTestWorker(ownerId, tempDir);
    activeWorkers.push(worker);
    return worker;
  }

  it('verifies workers boot and respond to ping over IPC', async () => {
    const nodeA = createWorker('node-A');
    const nodeB = createWorker('node-B');

    const pongA = await nodeA.ping();
    const pongB = await nodeB.ping();

    expect(pongA).toBe('node-A');
    expect(pongB).toBe('node-B');
    expect(nodeA.pid).toBeGreaterThan(0);
    expect(nodeB.pid).toBeGreaterThan(0);
  });

  it('competing activation attempts: exactly one node wins initial generation, other is rejected', async () => {
    const nodeA = createWorker('node-A');
    const nodeB = createWorker('node-B');
    const actorKey = 'competing-actor-1';

    // Both attempt simultaneous initial activation
    const [resA, resB] = await Promise.all([
      nodeA.acquire('CounterActor', actorKey, { leaseTtlMs: 10000 }),
      nodeB.acquire('CounterActor', actorKey, { leaseTtlMs: 10000 }),
    ]);

    const successes = [resA, resB].filter((r) => r.record && !r.error);
    const conflicts = [resA, resB].filter((r) => r.error);

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(1);

    expect(successes[0]?.record?.generation).toBe(1);
    expect(conflicts[0]?.error?.name).toBe('ActorOwnershipConflictError');
  });

  it('owner crash and failover: surviving node acquires ownership with incremented generation and resumes state', async () => {
    const nodeA = createWorker('node-A');
    const actorKey = 'crash-failover-actor';

    // 1. Node A owns actor and commits count = 10
    const clientA = new RemoteActorClient({ transport: nodeA.asTransport() });
    const counterRefA = clientA.get<CounterActor>(CounterActor, actorKey);
    const countA = await counterRefA.increment(10);
    expect(countA).toBe(10);

    // 2. Abruptly kill Node A (simulating hard process crash / SIGKILL)
    await nodeA.crash();

    // 3. Node B detects crash / failover and takes over ownership (force: true)
    const nodeB = createWorker('node-B');
    const acquireB = await nodeB.acquire('CounterActor', actorKey, { force: true });
    expect(acquireB.record?.ownerId).toBe('node-B');
    expect(acquireB.record?.generation).toBe(2);

    // 4. Node B reads previous state (10) and increments to 15
    const clientB = new RemoteActorClient({ transport: nodeB.asTransport() });
    const counterRefB = clientB.get<CounterActor>(CounterActor, actorKey);

    const recoveredCount = await counterRefB.getCount();
    expect(recoveredCount).toBe(10);

    const nextCount = await counterRefB.increment(5);
    expect(nextCount).toBe(15);
  });

  it('delayed requests: expired requests with passed deadlines are rejected without side effects', async () => {
    const node = createWorker('node-delayed');
    const actorKey = 'delayed-actor-key';

    const pastDeadline = Date.now() - 2000;

    const resp = await node.invoke({
      requestId: 'req-delayed-1',
      actorType: 'CounterActor',
      actorKey,
      method: 'increment',
      args: [50],
      deadline: pastDeadline,
    });

    expect(resp.success).toBe(false);
    expect(resp.error?.name).toBe('ActorDeadlineExceededError');

    // Confirm state was not modified
    const client = new RemoteActorClient({ transport: node.asTransport() });
    const counterRef = client.get<CounterActor>(CounterActor, actorKey);
    const current = await counterRef.getCount();
    expect(current).toBe(0);
  });

  it('stale-owner write prevention: authoritative storage rejects obsolete generation commit with StaleOwnerWriteError', async () => {
    const nodeA = createWorker('node-A');
    const nodeB = createWorker('node-B');
    const actorKey = 'fencing-stale-actor';

    // 1. Node A acquires ownership at generation 1
    const acqA = await nodeA.acquire('CounterActor', actorKey);
    expect(acqA.record?.generation).toBe(1);

    // 2. Ownership is transferred/forced to Node B (generation bumps to 2)
    const acqB = await nodeB.acquire('CounterActor', actorKey, { force: true });
    expect(acqB.record?.generation).toBe(2);

    // 3. Node A (still running) attempts to commit a transaction with obsolete generation 1
    const staleCommit = await nodeA.directStaleCommit(actorKey, 1, 'count', 9999);

    expect(staleCommit.success).toBe(false);
    expect(staleCommit.error?.name).toBe('StaleOwnerWriteError');
    expect(staleCommit.error?.ownerGeneration).toBe(1);
    expect(staleCommit.error?.storageGeneration).toBe(2);
  });

  it('state recovery across orderly owner transfers: continuous state consistency', async () => {
    const nodeA = createWorker('node-A');
    const nodeB = createWorker('node-B');
    const actorKey = 'state-transfer-key';

    const clientA = new RemoteActorClient({ transport: nodeA.asTransport() });
    const counterA = clientA.get<CounterActor>(CounterActor, actorKey);

    // Node A increments to 42
    await counterA.increment(42);

    // Orderly transfer: Node B takes over ownership
    const acqB = await nodeB.acquire('CounterActor', actorKey, { force: true });
    expect(acqB.record?.generation).toBe(2);

    // Node B continues operations from state 42
    const clientB = new RemoteActorClient({ transport: nodeB.asTransport() });
    const counterB = clientB.get<CounterActor>(CounterActor, actorKey);

    const initialOnB = await counterB.getCount();
    expect(initialOnB).toBe(42);

    const updatedOnB = await counterB.increment(8);
    expect(updatedOnB).toBe(50);
  });

  it('duplicate delivery / retry after lost response: returns committed result without re-executing non-idempotent side effects', async () => {
    const node = createWorker('node-retry');
    const actorKey = 'idempotent-multi-proc-key';

    const reqId = 'shared-request-id-12345';

    // 1. First invocation
    const resp1 = await node.invoke({
      requestId: reqId,
      actorType: 'CounterActor',
      actorKey,
      method: 'increment',
      args: [10],
    });

    expect(resp1.success).toBe(true);
    expect(resp1.result).toBe(10);

    // 2. Simulated retransmission after lost response with identical requestId
    const resp2 = await node.invoke({
      requestId: reqId,
      actorType: 'CounterActor',
      actorKey,
      method: 'increment',
      args: [10],
    });

    expect(resp2.success).toBe(true);
    // Result returned MUST be 10 (not 20!)
    expect(resp2.result).toBe(10);

    // 3. Confirm count in actor storage is indeed 10
    const client = new RemoteActorClient({ transport: node.asTransport() });
    const counterRef = client.get<CounterActor>(CounterActor, actorKey);
    const finalCount = await counterRef.getCount();
    expect(finalCount).toBe(10);
  });
});
