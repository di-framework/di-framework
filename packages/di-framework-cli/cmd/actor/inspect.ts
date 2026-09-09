import { CommandFailure, type CommandResult } from '../../command';
import { loadActorOperations, parseActorCliArgs } from './options';

export async function runActorInspect(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseActorCliArgs(args);
  const target = options.positional[0];

  if (!target) {
    throw new CommandFailure(
      'INVALID_USAGE',
      'di-framework actor inspect requires an actor type or identity: di-framework actor inspect <actorType|identity> [--key <key>]',
      2,
    );
  }

  const actors = await loadActorOperations(cwd);
  const baseDir = options.dir ?? '.actors';
  const manager = new actors.ActorDevManager({
    cwd,
    baseDir,
    namespace: options.namespace,
  });

  try {
    const inspection = await manager.inspect(target, options.key, {
      showState: options.showState,
    });

    if (!inspection) {
      throw new CommandFailure(
        'ACTOR_NOT_FOUND',
        `Actor '${target}' was not found in runtime or storage.`,
        1,
        { target },
      );
    }

    const lines: string[] = [
      `Actor Identity: ${inspection.actorId}`,
      `  Namespace:     ${inspection.namespace ?? '(none)'}`,
      `  Type:          ${inspection.actorType}`,
      `  Key:           ${inspection.actorKey}`,
      `  Status:        ${inspection.status}`,
      `  Running Calls: ${inspection.runningCalls}`,
      `  Pending Calls: ${inspection.pendingCalls}`,
      `  Storage Path:  ${inspection.storagePath ?? '(none)'}`,
    ];

    if (inspection.methods && inspection.methods.length > 0) {
      lines.push(`  Methods:       ${inspection.methods.join(', ')}`);
    }

    if (inspection.migrationStatus?.failedMigration) {
      const f = inspection.migrationStatus.failedMigration;
      lines.push(
        `  Migration Failure:`,
        `    Version: ${f.version ?? '(unknown)'}`,
        `    Error:   ${f.error}`,
      );
    }

    if (inspection.state !== undefined) {
      lines.push('  Committed State (Explicitly requested):');
      for (const [k, v] of Object.entries(inspection.state)) {
        lines.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    }

    return {
      data: {
        actorId: inspection.actorId,
        namespace: inspection.namespace,
        actorType: inspection.actorType,
        actorKey: inspection.actorKey,
        status: inspection.status,
        runningCalls: inspection.runningCalls,
        pendingCalls: inspection.pendingCalls,
        storagePath: inspection.storagePath,
        methods: inspection.methods,
        failedMigration: inspection.migrationStatus?.failedMigration,
        state: inspection.state,
      },
      text: lines.join('\n'),
    };
  } catch (err) {
    if (err instanceof CommandFailure) throw err;
    throw new CommandFailure(
      'ACTOR_INSPECT_ERROR',
      `Failed to inspect actor: ${err instanceof Error ? err.message : String(err)}`,
      1,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    await manager.close();
  }
}
