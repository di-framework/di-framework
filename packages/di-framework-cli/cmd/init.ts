import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type InitOptions = {
  /** Directory to create the app in (default: ./<name>). */
  dir: string;
  /** package.json name */
  name: string;
  /** Skip writing files that already exist */
  force: boolean;
};

const DEFAULT_NAME = 'di-app';

export function parseInitArgs(args: string[]): InitOptions {
  let name = DEFAULT_NAME;
  let dir: string | undefined;
  let force = false;
  let positional: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--force' || a === '-f') {
      force = true;
      continue;
    }
    if (a === '--dir' || a === '-d') {
      dir = args[++i];
      if (!dir) throw new Error(`${a} requires a path`);
      continue;
    }
    if (a === '--name' || a === '-n') {
      name = args[++i] ?? name;
      continue;
    }
    if (a === '--help' || a === '-h') {
      throw new Error('HELP');
    }
    if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a}`);
    }
    if (!positional) positional = a;
  }

  if (positional) name = positional;
  const target = resolve(process.cwd(), dir ?? name);
  return { dir: target, name, force };
}

export function printInitHelp(stream: NodeJS.WritableStream = process.stderr): void {
  stream.write(`Scaffold a new di-framework application.

Usage:
  di-framework init [name] [options]

Options:
  --dir, -d <path>   Target directory (default: ./<name>)
  --name, -n <name>  package.json name (default: directory / argument)
  --force, -f        Overwrite existing files
  --help, -h         Show this help

Example:
  di-framework init my-api
  cd my-api && bun install && bun run dev
`);
}

function writeFile(path: string, content: string, force: boolean): boolean {
  if (existsSync(path) && !force) {
    console.log(`  skip  ${path} (exists; use --force to overwrite)`);
    return false;
  }
  writeFileSync(path, content, 'utf-8');
  console.log(`  write ${path}`);
  return true;
}

export function scaffoldApp(opts: InitOptions): void {
  const { dir, name, force } = opts;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });

  console.log(`\nScaffolding di-framework app in ${dir}\n`);

  writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '0.0.1',
        private: true,
        type: 'module',
        scripts: {
          dev: 'bun run src/index.ts',
          start: 'bun run src/index.ts',
          build: 'bun build ./src/index.ts --outdir ./dist --target bun',
          check: 'tsc --noEmit',
        },
        dependencies: {
          '@di-framework/core': 'latest',
        },
        devDependencies: {
          '@types/bun': 'latest',
          typescript: '^5',
        },
      },
      null,
      2,
    ) + '\n',
    force,
  );

  writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ['ESNext'],
          target: 'ESNext',
          module: 'ESNext',
          moduleDetection: 'force',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: false,
          types: ['bun'],
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ) + '\n',
    force,
  );

  writeFile(
    join(dir, 'src/index.ts'),
    `import { useContainer } from '@di-framework/core/container';
import { Component, Container } from '@di-framework/core/decorators';

@Container()
class Greeter {
  greet(name: string) {
    return \`Hello, \${name}!\`;
  }
}

@Container()
class App {
  constructor(@Component(Greeter) private greeter: Greeter) {}

  run() {
    console.log(this.greeter.greet('di-framework'));
  }
}

const app = useContainer().resolve(App);
app.run();
`,
    force,
  );

  writeFile(
    join(dir, 'README.md'),
    `# ${name}

di-framework application scaffolded with \`di-framework init\`.

## Setup

\`\`\`bash
bun install
bun run dev
\`\`\`

## Scripts

| Script    | Description                          |
| --------- | ------------------------------------ |
| \`dev\`   | Run \`src/index.ts\` with Bun        |
| \`build\` | Bundle to \`dist/\`                  |
| \`check\` | Typecheck with \`tsc --noEmit\`      |

## Learn more

- [Documentation](https://docs.di-framework.dev)
- Add packages: \`bun add @di-framework/http\` (or graphql, auth, config, …)
`,
    force,
  );

  console.log(`
Done. Next:

  cd ${dir === resolve(process.cwd(), name) ? name : dir}
  bun install
  bun run dev
`);
}

export async function init(args: string[] = process.argv.slice(3)): Promise<void> {
  try {
    const opts = parseInitArgs(args);
    scaffoldApp(opts);
  } catch (err) {
    if (err instanceof Error && err.message === 'HELP') {
      printInitHelp();
      return;
    }
    throw err;
  }
}

export function handleInitFailure(err: unknown): never {
  console.error('init failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}

export function runInitMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => init().catch(handleInitFailure),
): void {
  if (isMain) void start();
}

runInitMain();
