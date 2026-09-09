import { afterAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActorRuntime, SqliteActorStorage } from '../src/index.js';
import {
  ContractCounterActor,
  ContractFailingMigrationActor,
  defineActorContractSuite,
} from '../src/testing/index.js';

describe('Local Actor Contract Tests', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-contract-local-'));
  let storage: SqliteActorStorage | undefined;
  let runtime: ActorRuntime | undefined;

  const createAdapter = async () => {
    if (!runtime) {
      storage = new SqliteActorStorage({ baseDir: tempDir, fileLocking: true });
      runtime = new ActorRuntime({ storage });
      runtime.register(ContractCounterActor);
      runtime.register(ContractFailingMigrationActor);
    }

    return {
      async invoke(actorType: string, actorKey: string, method: string, args: unknown[] = []) {
        if (!runtime) throw new Error('Runtime not initialized');
        return await runtime.invoke(actorType, actorKey, method, args);
      },
      async restart() {
        if (storage) {
          await storage.close();
        }
        storage = new SqliteActorStorage({ baseDir: tempDir, fileLocking: true });
        runtime = new ActorRuntime({ storage });
        runtime.register(ContractCounterActor);
        runtime.register(ContractFailingMigrationActor);
      },
      async simulateBindingFailure() {
        // Point storage to a path that cannot be accessed or close it
        if (storage) {
          await storage.close();
        }
        // Use an invalid directory (e.g. a file path treated as a directory)
        const invalidFile = path.join(tempDir, 'invalid-dir-file');
        fs.writeFileSync(invalidFile, 'not-a-dir');
        storage = new SqliteActorStorage({
          baseDir: path.join(invalidFile, 'sub'),
          fileLocking: true,
        });
        runtime = new ActorRuntime({ storage });
        runtime.register(ContractCounterActor);
      },
    };
  };

  defineActorContractSuite({
    name: 'Local ActorRuntime with SqliteActorStorage',
    createAdapter,
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

it('provides a callable method on the failing-migration fixture', async () => {
  expect(await new ContractFailingMigrationActor().ping()).toBe('pong');
});
