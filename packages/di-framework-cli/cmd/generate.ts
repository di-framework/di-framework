export async function getGenerateFn() {
  try {
    const mod = await import('@di-framework/codegen');
    return mod.generate;
  } catch {
    const mod = await import('../../di-framework-codegen/index.ts');
    return mod.generate;
  }
}

export async function generateCommand() {
  const args = process.argv.slice(3);

  let configPath: string | undefined;
  let init = false;
  let check = false;
  let clean = false;
  let outDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg.startsWith('--config=')) {
      configPath = arg.split('=')[1];
    } else if (arg === '--outDir' && i + 1 < args.length) {
      outDir = args[++i];
    } else if (arg.startsWith('--outDir=')) {
      outDir = arg.split('=')[1];
    } else if (arg === '--init') {
      init = true;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--clean') {
      clean = true;
    }
  }

  console.log('⚡ Running @di-framework/codegen...');

  const generateFn = await getGenerateFn();
  const result = await generateFn({
    config: configPath,
    init,
    check,
    clean,
    outDir,
  });

  for (const diag of result.diagnostics) {
    if (result.drifted) {
      console.error(`  ❌ ${diag}`);
    } else {
      console.log(`  ℹ️  ${diag}`);
    }
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
