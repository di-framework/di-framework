import { closeSync, constants, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type CliIo, CommandFailure, type CommandResult, PROCESS_IO } from '../command';

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
      const value = args[++i];
      if (!value) throw new Error(`${a} requires a name`);
      name = value;
      continue;
    }
    if (a === '--help' || a === '-h') {
      throw new Error('HELP');
    }
    if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a}`);
    }
    if (!positional) positional = a;
    else throw new Error(`Unexpected argument: ${a}`);
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

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}

function writeFile(path: string, content: string, force: boolean, io: CliIo): boolean {
  if (force) {
    writeFileSync(path, content, 'utf-8');
    io.stdout.write(`  write ${path}\n`);
    return true;
  }

  // Atomic create-or-skip avoids TOCTOU between existsSync and writeFileSync.
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    try {
      writeSync(fd, content, undefined, 'utf-8');
    } finally {
      closeSync(fd);
    }
    io.stdout.write(`  write ${path}\n`);
    return true;
  } catch (err) {
    if (isErrno(err, 'EEXIST')) {
      io.stdout.write(`  skip  ${path} (exists; use --force to overwrite)\n`);
      return false;
    }
    throw err;
  }
}

export function scaffoldApp(opts: InitOptions, io: CliIo = PROCESS_IO): void {
  const { dir, name, force } = opts;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });

  io.stdout.write(`\nScaffolding di-framework app in ${dir}\n\n`);

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
          build: 'di-framework build',
          start: 'node dist/index.js',
          check: 'di-framework check',
        },
        dependencies: {
          '@di-framework/core': 'latest',
        },
        devDependencies: {
          '@di-framework/cli': 'latest',
          '@di-framework/tsc': 'latest',
          '@types/bun': 'latest',
        },
      },
      null,
      2,
    ) + '\n',
    force,
    io,
  );

  writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ['ESNext'],
          target: 'ESNext',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['bun'],
          rootDir: 'src',
          outDir: 'dist',
          strict: true,
          skipLibCheck: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: false,
          plugins: [{ transform: '@di-framework/tsc' }],
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ) + '\n',
    force,
    io,
  );

  writeFile(
    join(dir, 'src/index.ts'),
    `import { useContainer } from '@di-framework/core/container';
import { Component, Container } from '@di-framework/core/decorators';

@Container()
class Greeter {
  hello(name: string) {
    return \`Hello, \${name}!\`;
  }
}

@Container()
class App {
  constructor(@Component(Greeter) private greeter: Greeter) {}

  run() {
    console.log(this.greeter.hello('di-framework'));
  }
}

const app = useContainer().resolve(App);
app.run();
`,
    force,
    io,
  );

  writeFile(
    join(dir, 'README.md'),
    `# ${name}

di-framework application scaffolded with \`di-framework init\`.

Includes [\`@di-framework/tsc\`](https://www.npmjs.com/package/@di-framework/tsc) for emit-time runtime parameter checks (\`ttsc\`). The first \`ttsc\` build compiles a Go sidecar (needs a Go toolchain; see [ttsc](https://ttsc.dev)).

## Setup

\`\`\`bash
bun install
bun run dev
\`\`\`

## Scripts

| Script    | Description |
| --------- | ----------- |
| \`dev\`   | Run \`src/index.ts\` with Bun (no emit; runtime checks not injected) |
| \`build\` | \`di-framework build\` → \`ttsc --emit\` (injects runtime checks) |
| \`start\` | Run emitted \`dist/index.js\` |
| \`check\` | \`di-framework check\` → \`ttsc --noEmit\` |

## Learn more

- [Documentation](https://docs.di-framework.dev)
- [Runtime type checks](https://docs.di-framework.dev/tsc.html)
- Add packages: \`bun add @di-framework/http\` (or graphql, auth, config, …)
`,
    force,
    io,
  );

  io.stdout.write(`
Done. Next:

  cd ${dir === resolve(process.cwd(), name) ? name : dir}
  bun install
  bun run dev
`);
}

export async function init(
  args: string[] = process.argv.slice(3),
  io: CliIo = PROCESS_IO,
): Promise<CommandResult> {
  try {
    const opts = parseInitArgs(args);
    scaffoldApp(opts, io);
    return { data: { directory: opts.dir, name: opts.name, force: opts.force } };
  } catch (err) {
    if (err instanceof Error && err.message === 'HELP') {
      printInitHelp(io.stderr as NodeJS.WritableStream);
      return { data: { help: true } };
    }
    throw new CommandFailure('INVALID_USAGE', err instanceof Error ? err.message : String(err), 2);
  }
}

export function handleInitFailure(
  err: unknown,
  io: CliIo = PROCESS_IO,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): void {
  io.stderr.write(`init failed: ${err instanceof Error ? err.message : String(err)}\n`);
  setExitCode(1);
}

export function runInitMain(
  isMain = import.meta.main,
  start: () => Promise<unknown> = () => init().catch(handleInitFailure),
): void {
  if (isMain) void start();
}

runInitMain();
