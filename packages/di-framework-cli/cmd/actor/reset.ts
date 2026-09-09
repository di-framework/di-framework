import { CommandFailure, type CommandResult } from '../../command';
import { loadActorOperations, parseActorCliArgs } from './options';

export async function runActorReset(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseActorCliArgs(args);

  if (!options.all && !options.namespace && !options.actor) {
    throw new CommandFailure(
      'INVALID_USAGE',
      'Actor reset requires explicit scope: specify --actor <name>, --namespace <name>, or --all to prevent accidental deletion.',
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
    const result = await manager.reset({
      all: options.all,
      namespace: options.namespace,
      actorName: options.actor,
      actorKey: options.key,
      baseDir,
    });

    const lines: string[] = [
      'Actor storage reset successfully.',
      `  Scope:         ${options.all ? 'all' : (options.namespace ? `namespace: ${options.namespace}` : '') + (options.actor ? ` actor: ${options.actor}` : '')}`,
      `  Deactivated:   ${result.deactivatedCount} instance(s)`,
      `  Deleted Files: ${result.deletedFiles.length} file(s) / directory(ies)`,
    ];

    for (const f of result.deletedFiles) {
      lines.push(`    - ${f}`);
    }

    return {
      data: {
        scope: result.scope,
        deactivatedCount: result.deactivatedCount,
        deletedFiles: result.deletedFiles,
        success: result.success,
      },
      text: lines.join('\n'),
    };
  } catch (err) {
    if (err instanceof CommandFailure) throw err;
    throw new CommandFailure(
      'ACTOR_RESET_ERROR',
      `Failed to reset actors: ${err instanceof Error ? err.message : String(err)}`,
      1,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    await manager.close();
  }
}
