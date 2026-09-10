import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { computeSha256 } from './decorator';
import type {
  ManifestDiscoveryOptions,
  MigrationDefinition,
  MigrationExecutionContext,
  MigrationManifest,
} from './types';

export function compareVersions(a: string | number, b: string | number): number {
  const strA = String(a).trim();
  const strB = String(b).trim();

  // Try pure numeric comparison
  const numA = Number(strA);
  const numB = Number(strB);
  if (
    !/[._-]/.test(strA) &&
    !/[._-]/.test(strB) &&
    Number.isFinite(numA) &&
    Number.isFinite(numB)
  ) {
    return numA - numB;
  }

  // Dotted segments comparison (e.g. 1.2.0 vs 1.10.0)
  const partsA = strA.split(/[._-]/);
  const partsB = strB.split(/[._-]/);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const partA = partsA[i];
    const partB = partsB[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;

    const nA = Number(partA);
    const nB = Number(partB);
    if (!Number.isNaN(nA) && !Number.isNaN(nB)) {
      if (nA !== nB) return nA - nB;
    } else {
      const cmp = partA.localeCompare(partB, undefined, { numeric: true, sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    }
  }

  return strA.localeCompare(strB, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortMigrations(migrations: MigrationDefinition[]): MigrationDefinition[] {
  return [...migrations].sort((a, b) => compareVersions(a.version, b.version));
}

interface ParsedSqlFile {
  upSql: string;
  downSql?: string;
  headerVersion?: string;
  headerDescription?: string;
  headerBinding?: string;
}

export function parseSqlContent(content: string): ParsedSqlFile {
  const lines = content.split(/\r?\n/);
  let headerVersion: string | undefined;
  let headerDescription: string | undefined;
  let headerBinding: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('--')) {
      // Header comment block ends on first non-comment, non-empty line
      if (trimmed.length > 0) break;
      continue;
    }
    // Parse the comment prefix separately so whitespace cannot backtrack into the value.
    const header = trimmed
      .slice(2)
      .trimStart()
      .replace(/^migration[:_ -]\s*/i, '');
    const match = /^(version|description|binding)(?:[:=]|\s)(.*)$/i.exec(header);
    if (match) {
      const value = match[2]!.trim();
      if (value) {
        switch (match[1]!.toLowerCase()) {
          case 'version':
            headerVersion = value;
            break;
          case 'description':
            headerDescription = value;
            break;
          case 'binding':
            headerBinding = value;
            break;
        }
      }
    }
  }

  // Check for -- migrate:up and -- migrate:down delimiters
  const upIndex = content.search(/--\s*migrate:up/i);
  const downIndex = content.search(/--\s*migrate:down/i);

  if (upIndex !== -1 && downIndex !== -1) {
    if (upIndex < downIndex) {
      const upSql = content
        .slice(upIndex, downIndex)
        .replace(/--\s*migrate:up/i, '')
        .trim();
      const downSql = content
        .slice(downIndex)
        .replace(/--\s*migrate:down/i, '')
        .trim();
      return { upSql, downSql, headerVersion, headerDescription, headerBinding };
    } else {
      const downSql = content
        .slice(downIndex, upIndex)
        .replace(/--\s*migrate:down/i, '')
        .trim();
      const upSql = content
        .slice(upIndex)
        .replace(/--\s*migrate:up/i, '')
        .trim();
      return { upSql, downSql, headerVersion, headerDescription, headerBinding };
    }
  } else if (upIndex !== -1) {
    const upSql = content
      .slice(upIndex)
      .replace(/--\s*migrate:up/i, '')
      .trim();
    return { upSql, headerVersion, headerDescription, headerBinding };
  }

  return { upSql: content.trim(), headerVersion, headerDescription, headerBinding };
}

export function parseFilename(filename: string): { version?: string; description?: string } {
  const base = filename.replace(/\.(up|down)?\.sql$/i, '').replace(/\.sql$/i, '');
  // Scan once and remember the last valid separator, avoiding ambiguous regex repetitions.
  const start = /^v/i.test(base) ? 1 : 0;
  let end = start;
  let separator = -1;
  while (end < base.length) {
    const char = base[end]!;
    if (char >= '0' && char <= '9') {
      end++;
      continue;
    }
    if (end === start || !/[0-9]/.test(base[end - 1]!)) break;
    if (char === '_' || char === '-') separator = end;
    if (!'._-'.includes(char) || !/[0-9]/.test(base[end + 1] ?? '')) break;
    end++;
  }
  if (separator !== -1) {
    const description = base.slice(separator + 1).replace(/^_/, '');
    if (description)
      return {
        version: base.slice(start, separator),
        description: description.replaceAll(/[_-]/g, ' ').trim(),
      };
  }
  if (end === base.length && end > start && /^\d+$/.test(base.slice(start))) {
    const version = base.slice(start);
    return { version, description: `migration ${version}` };
  }

  return { description: base };
}

export async function executeSqlScript(
  db: MigrationExecutionContext['db'],
  sql: string,
): Promise<void> {
  if (!sql.trim()) return;
  // Use exec for full multi-statement scripts
  await db.exec(sql);
}

export function createSqlMigrationDefinition(params: {
  version: string;
  description: string;
  binding: string;
  upSql: string;
  downSql?: string;
  source?: 'sql' | 'manifest';
  filePath?: string;
}): MigrationDefinition {
  const checksum = computeSha256(params.upSql);

  return {
    version: params.version,
    description: params.description,
    binding: params.binding,
    checksum,
    source: params.source ?? 'sql',
    filePath: params.filePath,
    up: async (context: MigrationExecutionContext) => {
      await executeSqlScript(context.db, params.upSql);
    },
    down: params.downSql
      ? async (context: MigrationExecutionContext) => {
          await executeSqlScript(context.db, params.downSql!);
        }
      : undefined,
  };
}

export async function discoverSqlMigrations(
  dirPath: string,
  defaultBinding = 'default',
): Promise<MigrationDefinition[]> {
  if (!existsSync(dirPath)) return [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const sqlFiles = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith('.sql') && !entry.name.endsWith('.down.sql'),
  );

  const results: MigrationDefinition[] = [];

  for (const entry of sqlFiles) {
    const file = entry.name;
    const fullPath = join(dirPath, file);

    const content = readFileSync(fullPath, 'utf8');
    const parsed = parseSqlContent(content);
    const fromFilename = parseFilename(file);

    const version = parsed.headerVersion ?? fromFilename.version ?? file.replace(/\.sql$/i, '');
    const description = parsed.headerDescription ?? fromFilename.description ?? file;
    const binding = parsed.headerBinding ?? defaultBinding;

    // Check if separate .down.sql exists
    let downSql = parsed.downSql;
    if (!downSql) {
      const downFile = file.replace(/(\.up)?\.sql$/i, '.down.sql');
      const downFullPath = join(dirPath, downFile);
      if (existsSync(downFullPath)) {
        downSql = readFileSync(downFullPath, 'utf8');
      }
    }

    results.push(
      createSqlMigrationDefinition({
        version: String(version),
        description,
        binding,
        upSql: parsed.upSql,
        downSql,
        source: 'sql',
        filePath: fullPath,
      }),
    );
  }

  return sortMigrations(results);
}

export async function discoverManifestMigrations(
  options: ManifestDiscoveryOptions,
): Promise<MigrationDefinition[]> {
  const cwd = options.cwd ?? process.cwd();
  const defaultBinding = options.binding ?? 'default';

  let manifest: MigrationManifest | undefined = options.manifest;
  let manifestBaseDir = cwd;

  if (!manifest && options.manifestPath) {
    const fullManifestPath = resolve(cwd, options.manifestPath);
    if (existsSync(fullManifestPath)) {
      manifestBaseDir = dirname(fullManifestPath);
      const manifestText = readFileSync(fullManifestPath, 'utf8');
      manifest = JSON.parse(manifestText) as MigrationManifest;
    } else {
      throw new Error(`Migration manifest not found at: ${options.manifestPath}`);
    }
  }

  const results: MigrationDefinition[] = [];

  if (manifest && Array.isArray(manifest.migrations)) {
    const manifestBinding = manifest.binding ?? defaultBinding;
    for (const entry of manifest.migrations) {
      const version = String(entry.version);
      const description = entry.description;
      const binding = entry.binding ?? manifestBinding;

      let upSql = entry.up ?? entry.sql ?? '';
      let downSql = entry.down;
      let filePath: string | undefined;

      if (entry.file) {
        filePath = resolve(manifestBaseDir, entry.file);
        if (!existsSync(filePath)) {
          throw new Error(`Migration SQL file not found: ${entry.file} (${filePath})`);
        }
        const fileContent = readFileSync(filePath, 'utf8');
        const parsed = parseSqlContent(fileContent);
        upSql = parsed.upSql;
        downSql = parsed.downSql ?? downSql;
      }

      results.push(
        createSqlMigrationDefinition({
          version,
          description,
          binding,
          upSql,
          downSql,
          source: 'manifest',
          filePath,
        }),
      );
    }
  }

  // If directory is specified or default migrations dir exists and no manifest was loaded
  if (options.directory) {
    const dirPath = resolve(cwd, options.directory);
    if (existsSync(dirPath)) {
      const fromDir = await discoverSqlMigrations(dirPath, defaultBinding);
      for (const m of fromDir) {
        // Avoid duplicate version/binding
        if (!results.some((r) => r.version === m.version && r.binding === m.binding)) {
          results.push(m);
        }
      }
    }
  }

  const filtered = options.binding ? results.filter((m) => m.binding === options.binding) : results;

  return sortMigrations(filtered);
}
