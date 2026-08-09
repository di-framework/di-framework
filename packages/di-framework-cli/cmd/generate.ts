export async function generateCommand(rawArgs: string[] = process.argv.slice(3)) {
  const { generate } = await import('@di-framework/codegen');
  const args = rawArgs.length > 0 ? rawArgs : process.argv.slice(3);

  let configPath: string | undefined;
  let init = false;
  let check = false;
  let clean = false;
  let outDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice(9);
    } else if (arg === '--outDir' && i + 1 < args.length) {
      outDir = args[++i];
    } else if (arg.startsWith('--outDir=')) {
      outDir = arg.slice(9);
    } else if (arg === '--init') {
      init = true;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--clean') {
      clean = true;
    }
  }

  console.log('⚡ Running @di-framework/codegen...');

  const result = await generate({
    config: configPath,
    init,
    check,
    clean,
    outDir,
  });

  for (const diag of result.diagnostics) {
    const icon = result.drifted ? '❌' : 'ℹ️ ';
    console.log(`  ${icon} ${diag}`);
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
    console.log(`  ${icon.padEnd(12)} ${file.relativePath}`);
  }

  if (result.drifted) {
    console.error('\n❌ Codegen check failed: Schema manifests or generated files have drifted.');
    process.exit(1);
  }

  console.log('\n✅ Application surfaces generated successfully!');
}
