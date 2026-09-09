import { CommandFailure, type CommandResult } from '../../command';
import { createCliMigrationRunner, parseMigrationCliArgs } from './options';

export async function runMigrationsStatus(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseMigrationCliArgs(args);
  const runner = await createCliMigrationRunner(options, cwd);

  try {
    const status = await runner.status({ binding: options.binding });

    const lines: string[] = [
      `Database binding: ${status.binding}`,
      `Applied migrations: ${status.applied.length}`,
      `Pending migrations: ${status.pending.length}`,
      '',
    ];

    if (status.pending.length > 0) {
      lines.push('Pending:');
      for (const p of status.pending) {
        lines.push(`  - ${p.version}: ${p.description} (${p.binding})`);
      }
      lines.push('', `Status: ${status.pending.length} pending migration(s) to execute.`);
    } else {
      lines.push('Status: Up-to-date. All migrations have been applied.');
    }

    return {
      data: {
        binding: status.binding,
        isUpToDate: status.isUpToDate,
        applied: status.applied.map((a) => ({
          version: a.version,
          description: a.description,
          binding: a.binding,
          applied_at: a.applied_at,
          checksum: a.checksum,
          execution_time_ms: a.execution_time_ms,
        })),
        pending: status.pending.map((p) => ({
          version: p.version,
          description: p.description,
          binding: p.binding,
          checksum: p.checksum,
          source: p.source ?? 'sql',
        })),
      },
      text: lines.join('\n'),
    };
  } catch (err) {
    if (err instanceof CommandFailure) throw err;
    throw new CommandFailure(
      'MIGRATION_STATUS_ERROR',
      `Failed to determine migration status: ${err instanceof Error ? err.message : String(err)}`,
      1,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    await runner.close();
  }
}
