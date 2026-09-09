import { expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ActorRpcRequest } from '../src/distributed/types';
import {
  ActorDeadlineExceededError,
  ActorRpcDispatcher,
  ActorRuntime,
  ChildProcessIpcTransport,
  InMemoryActorStorage,
  MemoryActorTransport,
  RemoteActorClient,
  SqliteActorStorage,
  StaleOwnerWriteError,
} from '../src/index';

const request = (id = 'request'): ActorRpcRequest => ({
  requestId: id,
  actorType: 'Counter',
  actorKey: 'key',
  method: 'run',
  args: [],
});

it('bounds hung remote calls and reconstructs application errors without retrying', async () => {
  const hung = new RemoteActorClient({
    transport: { send: () => new Promise(() => {}) },
    timeoutMs: 10,
  });
  await expect(hung.invokeRemote('Counter', 'key', 'run', [])).rejects.toBeInstanceOf(
    ActorDeadlineExceededError,
  );
  await expect(
    hung.invokeRemote('Counter', 'key', 'run', [], { timeoutMs: 0 }),
  ).rejects.toBeInstanceOf(ActorDeadlineExceededError);
  for (const error of [
    undefined,
    {},
    { name: 'StaleOwnerWriteError' },
    { name: 'ActorAuthorizationError' },
    { name: 'ActorDeadlineExceededError' },
    { name: 'ActorBackpressureError' },
    { name: 'ActorOwnershipConflictError' },
    { name: 'ActorNotOwnerError' },
    { name: 'BusinessError', message: 'declined', stack: 'remote stack' },
  ]) {
    let calls = 0;
    const client = new RemoteActorClient({
      transport: {
        send: async (req) => {
          calls++;
          return { requestId: req.requestId, success: false, error: error as any };
        },
      },
    });
    await expect(client.invokeRemote('Counter', 'key', 'run', [])).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  }
});

it('cleans up IPC requests after responses, send failures, deadlines and peer exits', async () => {
  const child = Object.assign(new EventEmitter(), { send: (_request: unknown) => {} });
  const ipc = new ChildProcessIpcTransport(child);
  const pending = ipc.send(request());
  const joined = ipc.send(request());
  child.emit('message', null);
  child.emit('message', { requestId: 'unrelated' });
  child.emit('message', { requestId: 'request', success: true, result: 4 });
  expect((await pending).result).toBe(4);
  expect((await joined).result).toBe(4);
  const abandoned = ipc.send(request('abandoned'));
  child.emit('exit', 1);
  await expect(abandoned).rejects.toThrow('disconnected');
  await expect(ipc.send(request('after-exit'))).rejects.toThrow('disconnected');
  const silent = new ChildProcessIpcTransport({ send() {} });
  await expect(silent.send({ ...request(), deadline: Date.now() + 5 })).rejects.toThrow(
    'timed out',
  );
  await expect(new ChildProcessIpcTransport({}).send(request())).rejects.toThrow('no send');
  await expect(
    new ChildProcessIpcTransport({
      send() {
        throw 'failed';
      },
    }).send(request()),
  ).rejects.toThrow('failed');
  let message = '';
  const stdin = new ChildProcessIpcTransport({
    stdin: {
      write(value: string) {
        message = value;
      },
    },
  });
  const delivered = stdin.send(request());
  expect(JSON.parse(message).requestId).toBe('request');
  stdin.handleIncomingMessage({ requestId: 'request', success: true });
  expect((await delivered).success).toBe(true);
});

it('exercises simulated transport failures and delay', async () => {
  const transport = new MemoryActorTransport();
  await expect(transport.send(request())).rejects.toThrow('No dispatcher');
  transport.simulateFailureNext(new Error('connection refused'));
  await expect(transport.send(request())).rejects.toThrow('connection refused');
  transport.setDispatcher({
    dispatch: async (req) => ({ requestId: req.requestId, success: true }),
  } as ActorRpcDispatcher);
  transport.delayNextRequest(1);
  expect((await transport.send(request())).success).toBe(true);
  transport.setDropRate(1);
  await expect(transport.send(request())).rejects.toThrow('dropped');
  expect(transport.transmittedCount).toBe(4);
});

it('returns namespaced fencing generations and preserves void results after retransmission', async () => {
  const storage = SqliteActorStorage.temporary();
  let calls = 0;
  class Counter {
    run() {
      calls++;
    }
  }
  const runtime = new ActorRuntime({ storage, actors: [Counter], ownerId: 'host' });
  try {
    const dispatcher = new ActorRpcDispatcher(runtime);
    const req = { ...request(), namespace: 'tenant' };
    const first = await dispatcher.dispatch(req);
    expect(first.success).toBe(true);
    expect(first.generation).toBe(1);
    expect(first.result).toBeUndefined();
    const second = await dispatcher.dispatch(req);
    expect(second.result).toBeUndefined();
    expect(calls).toBe(1);
    expect(
      (await runtime.getActorOwnership(Counter, 'key', { namespace: 'tenant' }))?.generation,
    ).toBe(1);
    expect(await runtime.getActorOwnership(Counter, 'key')).toBeNull();
  } finally {
    await runtime.clear();
  }
});

it('supports explicit ownership and transactional idempotency in both storage providers', async () => {
  for (const storage of [new InMemoryActorStorage(), SqliteActorStorage.temporary()]) {
    const actorId = 'Counter:key';
    try {
      expect(await storage.getOwnership(actorId)).toBeNull();
      const first = await storage.acquireOwnership(actorId, 'one', { leaseTtlMs: 1 });
      expect((await storage.acquireOwnership(actorId, 'one')).generation).toBe(first.generation);
      await expect(storage.acquireOwnership(actorId, 'two')).rejects.toThrow('owned');
      const second = await storage.acquireOwnership(actorId, 'two', { force: true });
      expect(second.generation).toBe(first.generation + 1);
      const stale = await storage.beginTransaction(actorId, {
        ownerId: 'one',
        generation: first.generation,
      });
      await stale.set('value', 1);
      await expect(stale.commit()).rejects.toBeInstanceOf(StaleOwnerWriteError);
      expect(await storage.get(actorId, 'value')).toBeUndefined();
      expect(await storage.releaseOwnership(actorId, 'one')).toBe(false);
      expect(await storage.releaseOwnership(actorId, 'two')).toBe(true);
      await storage.setIdempotencyRecord(actorId, 'stored', { value: 2 });
      const tx = await storage.beginTransaction(actorId);
      expect((await tx.getIdempotencyRecord!('stored'))?.response).toEqual({ value: 2 });
      await tx.setIdempotencyRecord!('staged', { value: 3 });
      expect((await tx.getIdempotencyRecord!('staged'))?.response).toEqual({ value: 3 });
      await tx.commit();
      expect((await storage.getIdempotencyRecord(actorId, 'staged'))?.response).toEqual({
        value: 3,
      });
    } finally {
      if (storage instanceof SqliteActorStorage) await storage.close();
    }
  }
  class Counter {
    run() {
      return 1;
    }
  }
  const runtime = new ActorRuntime({ actors: [Counter] });
  expect((await runtime.acquireActorOwnership(Counter, 'key')).ownerId).toBe('default-owner');
  expect((await runtime.getActorOwnership(Counter, 'key'))?.generation).toBe(1);
  expect(await runtime.releaseActorOwnership(Counter, 'key')).toBe(true);
  expect(await runtime.releaseActorOwnership('missing', 'key')).toBe(false);
  await expect(runtime.acquireActorOwnership('missing', 'key')).rejects.toThrow('not registered');
  await expect(runtime.getActorOwnership('missing', 'key')).rejects.toThrow('not registered');
  await runtime.clear();
});

it('preserves fencing diagnostics when a failed commit already closed its transaction', async () => {
  const storage = SqliteActorStorage.temporary();
  class Counter {
    async run() {
      await storage.acquireOwnership('Counter:key', 'replacement', { force: true });
    }
  }
  const runtime = new ActorRuntime({ storage, actors: [Counter], ownerId: 'original' });
  try {
    await expect(runtime.get(Counter, 'key').run()).rejects.toBeInstanceOf(StaleOwnerWriteError);
  } finally {
    await runtime.clear();
  }
});
