/**
 * Worker process entrypoint for multi-process distributed actor testing.
 */
import * as readline from 'node:readline';
import { Actor, ActorContext, ActorMethod } from '../../src/decorators/index';
import { ActorRpcDispatcher } from '../../src/distributed/dispatcher';
import { ActorRuntime } from '../../src/runtime/runtime';
import { SqliteActorStorage } from '../../src/storage/sqlite';

@Actor({ name: 'CounterActor' })
export class CounterActor {
  @ActorContext()
  ctx!: ActorContext;

  @ActorMethod()
  async increment(amount = 1): Promise<number> {
    const current = (await this.ctx.storage.get<number>('count')) ?? 0;
    const next = current + amount;
    await this.ctx.storage.set('count', next);
    return next;
  }

  @ActorMethod()
  async getCount(): Promise<number> {
    return (await this.ctx.storage.get<number>('count')) ?? 0;
  }

  @ActorMethod()
  async slowIncrement(amount: number, delayMs: number): Promise<number> {
    const current = (await this.ctx.storage.get<number>('count')) ?? 0;
    await new Promise((res) => setTimeout(res, delayMs));
    const next = current + amount;
    await this.ctx.storage.set('count', next);
    return next;
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
let ownerId = 'worker-default';
let baseDir = '.actors-test';

for (const arg of args) {
  if (arg.startsWith('--ownerId=')) {
    ownerId = arg.split('=')[1] ?? 'worker-default';
  } else if (arg.startsWith('--baseDir=')) {
    baseDir = arg.split('=')[1] ?? '.actors-test';
  }
}

const storage = new SqliteActorStorage({
  baseDir,
  fileLocking: false,
});

const runtime = new ActorRuntime({
  ownerId,
  storage,
  actors: [CounterActor],
  autoAcquireOwnership: true,
  leaseTtlMs: 10000,
});

const dispatcher = new ActorRpcDispatcher({ runtime });

function sendOutput(obj: any): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const msg = JSON.parse(trimmed);

    switch (msg.type) {
      case 'ping': {
        sendOutput({ type: 'pong', id: msg.id, ownerId });
        break;
      }

      case 'invoke': {
        const resp = await dispatcher.dispatch(msg.request);
        sendOutput({ type: 'response', id: msg.id, response: resp });
        break;
      }

      case 'acquire': {
        try {
          const rec = await runtime.acquireActorOwnership(msg.actorType, msg.actorKey, {
            force: msg.force,
            leaseTtlMs: msg.leaseTtlMs,
          });
          sendOutput({ type: 'acquire_result', id: msg.id, record: rec });
        } catch (err: any) {
          sendOutput({
            type: 'acquire_result',
            id: msg.id,
            error: { name: err.name, message: err.message },
          });
        }
        break;
      }

      case 'get_ownership': {
        const rec = await runtime.getActorOwnership(msg.actorType, msg.actorKey);
        sendOutput({ type: 'ownership_result', id: msg.id, record: rec });
        break;
      }

      case 'direct_stale_commit': {
        // Simulates an obsolete writer attempting commit with a stale generation token
        try {
          const compositeId = `CounterActor:${msg.actorKey}`;
          const tx = await storage.beginTransaction(compositeId, {
            ownerId,
            generation: msg.staleGeneration,
          });
          await tx.set(msg.key, msg.value);
          await tx.commit();
          sendOutput({ type: 'stale_commit_result', id: msg.id, success: true });
        } catch (err: any) {
          sendOutput({
            type: 'stale_commit_result',
            id: msg.id,
            success: false,
            error: {
              name: err.name,
              message: err.message,
              ownerGeneration: err.ownerGeneration,
              storageGeneration: err.storageGeneration,
            },
          });
        }
        break;
      }

      case 'crash': {
        // Immediate termination simulating abrupt crash (no graceful shutdown)
        process.exit(msg.exitCode ?? 1);
        break;
      }

      default: {
        sendOutput({ type: 'unknown_command', id: msg.id, rawType: msg.type });
      }
    }
  } catch (err: any) {
    sendOutput({ type: 'error', error: err.message });
  }
});
