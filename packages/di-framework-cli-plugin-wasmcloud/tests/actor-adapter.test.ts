import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ActorRuntime,
  ContractCounterActor,
  ContractFailingMigrationActor,
  defineActorContractSuite,
  SqliteActorStorage,
} from '@di-framework/actors';
import {
  ACTORS_INVOCATION_PATH,
  createWasmcloudActorAdapter,
  type WasmcloudActorAdapter,
} from '../src/index.js';

describe('wasmCloud Actor Adapter Integration', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-contract-wasmcloud-'));
  let storage: SqliteActorStorage | undefined;
  let runtime: ActorRuntime | undefined;
  let adapter: WasmcloudActorAdapter | undefined;

  const initAdapter = () => {
    storage = new SqliteActorStorage({ baseDir: tempDir, fileLocking: true });
    runtime = new ActorRuntime({ storage });
    runtime.register(ContractCounterActor);
    runtime.register(ContractFailingMigrationActor);
    adapter = createWasmcloudActorAdapter(runtime);
  };

  initAdapter();

  defineActorContractSuite({
    name: 'WasmcloudActorAdapter',
    createAdapter: async () => {
      if (!adapter) initAdapter();
      return {
        async invoke(actorType: string, actorKey: string, method: string, args: unknown[] = []) {
          return await adapter!.invoke(actorType, actorKey, method, args);
        },
        async restart() {
          if (storage) await storage.close();
          initAdapter();
        },
        async simulateBindingFailure() {
          if (storage) await storage.close();
          const invalidFile = path.join(tempDir, 'invalid-dir-file');
          fs.writeFileSync(invalidFile, 'not-a-dir');
          storage = new SqliteActorStorage({ baseDir: path.join(invalidFile, 'sub'), fileLocking: true });
          runtime = new ActorRuntime({ storage });
          runtime.register(ContractCounterActor);
          adapter = createWasmcloudActorAdapter(runtime);
        },
      };
    },
  });

  describe('HTTP Protocol Invocations', () => {
    beforeEach(() => {
      initAdapter();
    });
    it('handles POST /_actors/invoke with body payload', async () => {
      const req = new Request(`http://localhost${ACTORS_INVOCATION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorType: 'ContractCounter',
          actorKey: 'http-1',
          method: 'increment',
          args: [10],
        }),
      });

      const res = await adapter!.handle(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, result: 10 });
    });

    it('returns 400 when required invocation parameters are missing', async () => {
      const req = new Request(`http://localhost${ACTORS_INVOCATION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorType: 'ContractCounter' }),
      });

      const res = await adapter!.handle(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.name).toBe('ActorInvocationBadRequest');
    });

    it('returns 404 for unknown actor or method', async () => {
      const req = new Request(`http://localhost${ACTORS_INVOCATION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorType: 'UnknownActor',
          actorKey: 'k',
          method: 'm',
        }),
      });

      const res = await adapter!.handle(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.name).toBe('ActorNotRegisteredError');
    });
  });

  afterAll(async () => {
    if (storage) {
      await storage.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });
});
