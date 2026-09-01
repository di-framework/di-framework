export type ExitCode = 0 | 1 | 2 | 3;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type CliStream = { write(chunk: string): unknown };

export type CliIo = {
  stdout: CliStream;
  stderr: CliStream;
};

export const PROCESS_IO: CliIo = { stdout: process.stdout, stderr: process.stderr };

export type CommandResult = {
  data?: JsonValue;
  text?: string;
  exitCode?: ExitCode;
};

export type CommandContext = {
  args: string[];
  command: string[];
  io: CliIo;
};

export type CommandNode = {
  description: string;
  usage?: string;
  options?: readonly string[];
  children?: Record<string, CommandNode>;
  run?: (context: CommandContext) => CommandResult | undefined | Promise<CommandResult | undefined>;
};

export class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: Exclude<ExitCode, 0>,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'CommandFailure';
  }
}

const HELP_TOKENS = new Set(['help', '--help', '-h']);

export function formatCommandHelp(node: CommandNode, path: readonly string[] = []): string {
  const command = ['di-framework', ...path].join(' ');
  const usage = node.usage ?? (node.children ? `${command} <command>` : `${command} [options]`);
  const lines = [node.description, '', `Usage:`, `  ${usage}`];

  if (node.children) {
    lines.push('', 'Commands:');
    const width = Math.max(...Object.keys(node.children).map((name) => name.length));
    for (const [name, child] of Object.entries(node.children)) {
      lines.push(`  ${name.padEnd(width)}  ${child.description}`);
    }
  }

  if (node.options?.length)
    lines.push('', 'Options:', ...node.options.map((option) => `  ${option}`));
  lines.push('', '  --json  Emit one stable JSON result', '  --help, -h  Show this help', '');
  return lines.join('\n');
}

function writeJson(io: CliIo, value: JsonValue): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function unexpectedFailure(error: unknown): CommandFailure {
  return new CommandFailure('INTERNAL_ERROR', 'Unexpected command failure', 3, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

export async function executeCommand(
  root: CommandNode,
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<ExitCode> {
  const json = argv.includes('--json');
  const tokens = argv.filter((token) => token !== '--json');
  const bufferedOut: string[] = [];
  const bufferedErr: string[] = [];
  const commandIo: CliIo = {
    stdout: { write: (chunk) => bufferedOut.push(chunk) },
    stderr: { write: (chunk) => bufferedErr.push(chunk) },
  };
  let node = root;
  const path: string[] = [];
  let position = 0;

  try {
    if (HELP_TOKENS.has(tokens[0] ?? '')) {
      const help = formatCommandHelp(root);
      if (json) writeJson(io, { schemaVersion: 1, command: '', ok: true, data: { help } });
      else io.stdout.write(help);
      return 0;
    }

    while (node.children) {
      const token = tokens[position];
      if (!token) {
        throw new CommandFailure(
          'INVALID_USAGE',
          `Missing command after ${['di-framework', ...path].join(' ')}`,
          2,
          {
            help: formatCommandHelp(node, path),
          },
        );
      }
      if (HELP_TOKENS.has(token)) {
        const help = formatCommandHelp(node, path);
        if (json)
          writeJson(io, { schemaVersion: 1, command: path.join(' '), ok: true, data: { help } });
        else io.stdout.write(help);
        return 0;
      }
      const child = node.children[token];
      if (!child) {
        throw new CommandFailure(
          'UNKNOWN_COMMAND',
          `Unknown command: ${[...path, token].join(' ')}`,
          2,
          {
            token,
            help: formatCommandHelp(node, path),
          },
        );
      }
      node = child;
      path.push(token);
      position++;
    }

    const args = tokens.slice(position);
    if (args.some((token) => HELP_TOKENS.has(token))) {
      const help = formatCommandHelp(node, path);
      if (json)
        writeJson(io, { schemaVersion: 1, command: path.join(' '), ok: true, data: { help } });
      else io.stdout.write(help);
      return 0;
    }
    if (!node.run) {
      throw new CommandFailure(
        'INVALID_COMMAND',
        `Command cannot be executed: ${path.join(' ')}`,
        2,
      );
    }

    const result = (await node.run({ args, command: path, io: commandIo })) ?? {};
    const exitCode = result.exitCode ?? 0;
    if (json) {
      writeJson(io, {
        schemaVersion: 1,
        command: path.join(' '),
        ok: exitCode === 0,
        data: result.data ?? null,
      });
    } else {
      for (const chunk of bufferedOut) io.stdout.write(chunk);
      for (const chunk of bufferedErr) io.stderr.write(chunk);
      if (result.text)
        io.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
    }
    return exitCode;
  } catch (error) {
    const failure = error instanceof CommandFailure ? error : unexpectedFailure(error);
    if (json) {
      writeJson(io, {
        schemaVersion: 1,
        command: path.join(' '),
        ok: false,
        error: { code: failure.code, message: failure.message, details: failure.details },
      });
    } else {
      io.stderr.write(`${failure.message}\n`);
      if (
        failure.details &&
        typeof failure.details === 'object' &&
        !Array.isArray(failure.details) &&
        typeof failure.details.help === 'string'
      ) {
        io.stderr.write(`\n${failure.details.help}`);
      }
    }
    return failure.exitCode;
  }
}
