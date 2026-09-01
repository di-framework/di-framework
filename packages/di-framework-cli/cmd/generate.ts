import {
  type CliIo,
  CommandFailure,
  type CommandResult,
  type JsonValue,
  PROCESS_IO,
} from '../command';

export async function generateCommand(
  rawArgs: string[] = process.argv.slice(3),
  io: CliIo = PROCESS_IO,
): Promise<CommandResult> {
  const { generate } = await import('@di-framework/codegen');
  const args = rawArgs;

  let configPath: string | undefined;
  let init = false;
  let check = false;
  let clean = false;
  let outDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--config') {
      const value = args[++i];
      if (!value) throw new CommandFailure('INVALID_USAGE', '--config requires a path', 2);
      configPath = value;
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice(9);
      if (!configPath) throw new CommandFailure('INVALID_USAGE', '--config requires a path', 2);
    } else if (arg === '--outDir') {
      const value = args[++i];
      if (!value) throw new CommandFailure('INVALID_USAGE', '--outDir requires a path', 2);
      outDir = value;
    } else if (arg.startsWith('--outDir=')) {
      outDir = arg.slice(9);
      if (!outDir) throw new CommandFailure('INVALID_USAGE', '--outDir requires a path', 2);
    } else if (arg === '--init') {
      init = true;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--clean') {
      clean = true;
    } else {
      throw new CommandFailure('INVALID_USAGE', `Unknown argument: ${arg}`, 2, { token: arg });
    }
  }

  io.stdout.write('⚡ Running @di-framework/codegen...\n');

  const result = await generate({
    config: configPath,
    init,
    check,
    clean,
    outDir,
  });

  for (const diag of result.diagnostics) {
    const icon = result.drifted ? '❌' : 'ℹ️ ';
    io.stdout.write(`  ${icon} ${diag}\n`);
  }

  for (const file of result.files) {
    const icon =
      file.status === 'created'
        ? '✨ created'
        : file.status === 'updated'
          ? '📝 updated'
          : file.status === 'deleted'
            ? '🗑️  deleted'
            : file.status === 'drifted'
              ? '❌ drifted'
              : '🔹 unchanged';
    io.stdout.write(`  ${icon.padEnd(12)} ${file.relativePath}\n`);
  }

  if (result.drifted) {
    io.stderr.write(
      '\n❌ Codegen check failed: Schema manifests or generated files have drifted.\n',
    );
    return { data: result as unknown as JsonValue, exitCode: 1 };
  }

  io.stdout.write('\n✅ Application surfaces generated successfully!\n');
  return { data: result as unknown as JsonValue };
}
