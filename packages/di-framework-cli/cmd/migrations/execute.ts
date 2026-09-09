import { CommandFailure, type CommandResult } from '../../command';
import { createCliMigrationRunner, parseMigrationCliArgs } from './options';

export async function runMigrationsExecute(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseMigrationCliArgs(args);
  const runner = await createCliMigrationRunner(options, cwd);

  try {
    const result = await runner.execute({
      binding: options.binding,
      step: options.step,
      dryRun: options.dryRun,
    });

    const lines: string[] = [`Database binding: ${result.binding}`];

    if (result.dryRun) {
      lines.push('Dry run mode — no changes applied to database.', '');
      if (result.pending.length > 0) {
        lines.push(`Planned migration(s) (${result.pending.length}):`);
        for (const p of result.pending) {
          lines.push(`  - ${p.version}: ${p.description}`);
        }
      } else {
        lines.push('No pending migrations to apply.');
      }
    } else {
      if (result.applied.length > 0) {
        lines.push(
          `Successfully applied ${result.applied.length} migration(s) in ${result.durationMs}ms:`,
        );
        for (const a of result.applied) {
          lines.push(`  ✓ ${a.version}: ${a.description} (${a.execution_time_ms}ms)`);
        }
      } else {
        lines.push('Database is already up-to-date. No migrations applied.');
      }
    }

    return {
      data: {
        binding: result.binding,
        applied: result.applied.map((a) => ({
          version: a.version,
          description: a.description,
          binding: a.binding,
          applied_at: a.applied_at,
          checksum: a.checksum,
          execution_time_ms: a.execution_time_ms,
        })),
        pending: result.pending.map((p) => ({
          version: p.version,
          description: p.description,
          binding: p.binding,
          checksum: p.checksum,
          source: p.source ?? 'sql',
        })),
        dryRun: result.dryRun,
        durationMs: result.durationMs,
      },
      text: lines.join('\n'),
    };
  } catch (err) {
    if (err instanceof CommandFailure) throw err;
    throw new CommandFailure(
      'MIGRATION_EXECUTION_ERROR',
      `Migration execution failed: ${err instanceof Error ? err.message : String(err)}`,
      1,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    await runner.close();
  }
}
