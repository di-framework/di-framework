import { CommandFailure, type CommandResult } from '../../command';
import { loadActorOperations, parseActorCliArgs } from './options';

export async function runActorList(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseActorCliArgs(args);
  const actors = await loadActorOperations(cwd);

  const baseDir = options.dir ?? '.actors';
  const manager = new actors.ActorDevManager({
    cwd,
    baseDir,
    namespace: options.namespace,
  });

  try {
    const list = await manager.list({
      namespace: options.namespace,
      activeOnly: options.active,
    });

    const lines: string[] = [`Known Actors (${list.length}):`];

    if (list.length === 0) {
      lines.push('  No actors found matching criteria.');
    } else {
      for (const item of list) {
        const nsStr = item.namespace ? `[${item.namespace}] ` : '';
        const callStats = `running: ${item.runningCalls}, pending: ${item.pendingCalls}`;
        lines.push(`  - ${nsStr}${item.actorType}:${item.actorKey} (${item.status}, ${callStats})`);
      }
    }

    return {
      data: {
        namespace: options.namespace,
        baseDir,
        total: list.length,
        actors: list.map((a) => ({
          actorId: a.actorId,
          namespace: a.namespace,
          actorType: a.actorType,
          actorKey: a.actorKey,
          status: a.status,
          runningCalls: a.runningCalls,
          pendingCalls: a.pendingCalls,
          storagePath: a.storagePath,
          failedMigration: a.migrationStatus?.failedMigration,
        })),
      },
      text: lines.join('\n'),
    };
  } catch (err) {
    if (err instanceof CommandFailure) throw err;
    throw new CommandFailure(
      'ACTOR_LIST_ERROR',
      `Failed to list actors: ${err instanceof Error ? err.message : String(err)}`,
      1,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    await manager.close();
  }
}
