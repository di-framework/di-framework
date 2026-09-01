import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type CliIo, type CommandNode, executeCommand, formatCommandHelp } from '../command';
import type { CliHandlers } from '../main';
import { COMMAND_TREE, createCommandTree } from '../main';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

const CANONICAL_GROUPS = ['agent', 'http', 'http openapi', 'skills', 'skills index', 'mx'];
const CANONICAL_LEAVES = [
  'init',
  'generate',
  'build',
  'check',
  'agent audit',
  'agent init',
  'agent inspect',
  'agent migrate',
  'http openapi generate',
  'skills index build',
  'skills index inspect',
  'skills index validate',
  'skills index query',
  'skills index migrate',
  'skills validate',
  'mx build',
  'mx test',
  'mx typecheck',
  'mx publish',
];

const FEATURE_ADAPTER_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  'cmd/agent/audit.ts': ['auditAgentConfiguration'],
  'cmd/agent/init.ts': [
    'auditAgentConfiguration',
    'planAgentConfigurationMigration',
    'executeAgentConfigurationMigration',
  ],
  'cmd/agent/inspect.ts': [
    'resolveSkillSources',
    'validateResolvedSkillCatalog',
    'discoverAgentInstructions',
    'loadAiIgnorePolicy',
  ],
  'cmd/agent/migrate.ts': [
    'auditAgentConfiguration',
    'planAgentConfigurationMigration',
    'executeAgentConfigurationMigration',
  ],
  'cmd/http/openapi-generate.ts': ['generateOpenAPIDocument', 'writeOpenAPIDocument'],
  'cmd/skills/index.ts': [
    'buildSkillsIndex',
    'inspectSkillsIndex',
    'validateSkillsIndex',
    'querySkillsIndex',
    'migrateSkillsIndex',
  ],
  'cmd/skills/validate.ts': ['validateSkillCatalog'],
};

const REMOVED_ENTRYPOINTS = [
  'packages/di-framework-ai-utils/src/skills-index-cli.ts',
  'packages/di-framework-ai-utils/src/skills/skills-index-cli.ts',
  'packages/di-framework-http/src/cli.ts',
  'packages/di-framework-tsc/bin/dtsc.cjs',
  'packages/di-framework-cli/cmd/mx.ts',
];

function captureIo(): { stdout: string[]; stderr: string[]; io: CliIo } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

function commandEntries(root: CommandNode): Array<{ path: string; node: CommandNode }> {
  const entries: Array<{ path: string; node: CommandNode }> = [];
  const visit = (node: CommandNode, parts: readonly string[]) => {
    for (const [name, child] of Object.entries(node.children ?? {})) {
      const childParts = [...parts, name];
      entries.push({ path: childParts.join(' '), node: child });
      visit(child, childParts);
    }
  };
  visit(root, []);
  return entries;
}

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'coverage')
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

describe('unified CLI end-to-end contract', () => {
  it('exposes the exhaustive canonical command tree without aliases', () => {
    const entries = commandEntries(COMMAND_TREE);
    expect(entries.filter(({ node }) => node.children).map(({ path }) => path)).toEqual(
      CANONICAL_GROUPS,
    );
    expect(entries.filter(({ node }) => node.run).map(({ path }) => path)).toEqual(
      CANONICAL_LEAVES,
    );
    expect(entries.every(({ node }) => Boolean(node.children) !== Boolean(node.run))).toBe(true);
  });

  it('renders text and single-envelope JSON help for every canonical group and leaf', async () => {
    const handlers = new Proxy({} as CliHandlers, {
      get: () => async () => {
        throw new Error('Help must not invoke a command handler');
      },
    });
    const tree = createCommandTree(handlers);
    for (const { path, node } of commandEntries(tree)) {
      const tokens = path.split(' ');
      const expectedHelp = formatCommandHelp(node, tokens);
      for (const helpToken of ['help', '--help', '-h']) {
        const text = captureIo();
        expect(await executeCommand(tree, [...tokens, helpToken], text.io)).toBe(0);
        expect(text.stdout.join('')).toBe(expectedHelp);
        expect(text.stderr).toEqual([]);
      }

      const json = captureIo();
      expect(await executeCommand(tree, [...tokens, '--help', '--json'], json.io)).toBe(0);
      expect(json.stderr).toEqual([]);
      expect(JSON.parse(json.stdout.join(''))).toEqual({
        schemaVersion: 1,
        command: path,
        ok: true,
        data: { help: expectedHelp },
      });
    }
  });

  it('rejects removed binaries and top-level maintainer aliases through unified exits', async () => {
    for (const alias of [
      'di-skills-index',
      'di-framework-http',
      'dtsc',
      'test',
      'typecheck',
      'publish',
    ]) {
      const text = captureIo();
      expect(await executeCommand(COMMAND_TREE, [alias], text.io)).toBe(2);
      expect(text.stdout).toEqual([]);
      expect(text.stderr.join('')).toContain(`Unknown command: ${alias}`);

      const json = captureIo();
      expect(await executeCommand(COMMAND_TREE, [alias, '--json'], json.io)).toBe(2);
      expect(json.stderr).toEqual([]);
      expect(JSON.parse(json.stdout.join(''))).toMatchObject({
        schemaVersion: 1,
        command: '',
        ok: false,
        error: { code: 'UNKNOWN_COMMAND', details: { token: alias } },
      });
    }
  });

  it('rejects invalid legacy-handler arguments with one JSON envelope and no stream leakage', async () => {
    for (const argv of [
      ['generate', '--definitely-unknown'],
      ['generate', '--config'],
      ['init', 'one', 'two'],
      ['check', '--definitely-unknown'],
      ['mx', 'build', '--definitely-unknown'],
      ['mx', 'test', 'unexpected'],
      ['mx', 'typecheck', '--definitely-unknown'],
      ['mx', 'publish', 'unexpected'],
    ]) {
      const captured = captureIo();
      expect(await executeCommand(COMMAND_TREE, [...argv, '--json'], captured.io)).toBe(2);
      expect(captured.stderr).toEqual([]);
      expect(captured.stdout).toHaveLength(1);
      expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
        schemaVersion: 1,
        command: argv.slice(0, argv[0] === 'mx' ? 2 : 1).join(' '),
        ok: false,
        error: { code: 'INVALID_USAGE' },
      });
    }
  });

  it('returns non-null stable JSON data from every legacy handler adapter', async () => {
    const operations = [
      ['init', 'demo'],
      ['generate'],
      ['build'],
      ['check'],
      ['mx', 'build'],
      ['mx', 'test'],
      ['mx', 'typecheck'],
      ['mx', 'publish'],
    ];
    const handlers = new Proxy({} as CliHandlers, {
      get: (_target, name) => async (_args: unknown, io: CliIo) => {
        io.stdout.write(`handled ${String(name)}\n`);
        return { data: { handler: String(name) } };
      },
    });
    const tree = createCommandTree(handlers);
    for (const argv of operations) {
      const captured = captureIo();
      expect(await executeCommand(tree, [...argv, '--json'], captured.io)).toBe(0);
      expect(captured.stderr).toEqual([]);
      expect(captured.stdout).toHaveLength(1);
      expect(JSON.parse(captured.stdout[0]!).data).not.toBeNull();
    }
  });

  it('publishes only di-framework and keeps removed entrypoint sources deleted', () => {
    const packagesDirectory = join(REPO_ROOT, 'packages');
    const publishedBins: Array<{ packageName: string; command: string; entrypoint: string }> = [];
    for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(packagesDirectory, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name: string;
        bin?: Record<string, string>;
      };
      for (const [command, entrypoint] of Object.entries(manifest.bin ?? {})) {
        publishedBins.push({ packageName: manifest.name, command, entrypoint });
      }
    }
    expect(publishedBins).toEqual([
      {
        packageName: '@di-framework/cli',
        command: 'di-framework',
        entrypoint: './main.ts',
      },
    ]);
    for (const entrypoint of REMOVED_ENTRYPOINTS) {
      expect(existsSync(join(REPO_ROOT, entrypoint))).toBe(false);
    }
  });

  it('keeps removed command invocations out of repository documentation', () => {
    const removedInvocation =
      /^\s*(?:\$\s*)?(?:di-skills-index|di-framework-http|dtsc)(?:\s|$)|`(?:di-skills-index|di-framework-http|dtsc)\s+[^`]+`|^\s*(?:\$\s*)?di-framework\s+(?:test|typecheck|publish)(?:\s|$)|`di-framework\s+(?:test|typecheck|publish)(?:\s[^`]*)?`/m;
    const violations = markdownFiles(REPO_ROOT).flatMap((path) => {
      const content = readFileSync(path, 'utf8');
      return removedInvocation.test(content) ? [relative(REPO_ROOT, path)] : [];
    });
    expect(violations).toEqual([]);
  });

  it('keeps feature adapters thin and delegated to their typed package operations', () => {
    const cliDirectory = join(REPO_ROOT, 'packages', 'di-framework-cli');
    for (const [relativePath, operations] of Object.entries(FEATURE_ADAPTER_OPERATIONS)) {
      const source = readFileSync(join(cliDirectory, relativePath), 'utf8');
      expect(source).not.toContain("from 'node:fs'");
      expect(source).not.toContain('Bun.file');
      expect(source).not.toContain('Bun.write');
      for (const operation of operations) {
        expect(source).toContain(`typeof ${operation}`);
        expect(source).toContain(`api.${operation}(`);
      }
    }
  });
});
