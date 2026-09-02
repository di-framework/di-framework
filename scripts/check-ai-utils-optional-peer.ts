import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'di-ai-utils-peer-'));

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function available(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pack(directory: string): { path: string; result: PackResult } {
  const [result] = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', temporary], directory),
  );
  return { path: join(temporary, result.filename), result };
}

try {
  const ai = pack(resolve(root, 'packages/di-framework-ai'));
  const utils = pack(resolve(root, 'packages/di-framework-ai-utils'));
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'packages/di-framework-ai-utils/package.json'), 'utf8'),
  );
  if (manifest.peerDependencies?.['@huggingface/transformers'] !== '4.2.0') {
    throw new Error('ai-utils must declare the supported Transformers.js peer version');
  }
  if (manifest.peerDependenciesMeta?.['@huggingface/transformers']?.optional !== true) {
    throw new Error('Transformers.js must be an optional peer');
  }
  if (manifest.optionalDependencies?.['@huggingface/transformers']) {
    throw new Error('Transformers.js must not be an optionalDependency');
  }
  const forbidden = utils.result.files.find(({ path }) => {
    const normalized = path.toLowerCase();
    return (
      normalized.includes('transformers') ||
      normalized.includes('onnxruntime') ||
      normalized.includes('sharp') ||
      normalized.endsWith('.node')
    );
  });
  if (forbidden)
    throw new Error(`packed ai-utils contains Transformer/native artifact: ${forbidden.path}`);

  const source = `
    import { agentSkill, buildSkillsIndex, TransformersJsSkillEmbedder } from '@di-framework/ai-utils';
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const skill = agentSkill({ name: 'tiny-skill', description: 'A tiny valid skill for packaging checks', content: '# Tiny\\n' });
    const dir = mkdtempSync(join(tmpdir(), 'ai-utils-consumer-'));
    const small = await buildSkillsIndex({ skills: [skill], outputFile: join(dir, 'small.jsonl') });
    if (small.indexed) throw new Error('small catalog unexpectedly indexed');
    const embedder = { id: 'fixture', model: 'fixture', revision: '1', split: async (text) => [text], embed: async (texts) => texts.map(() => Float32Array.of(1, 0)) };
    const custom = await buildSkillsIndex({ skills: [skill], threshold: 0, embedder, outputFile: join(dir, 'custom.jsonl') });
    if (!custom.indexed) throw new Error('custom embedder did not index');
    let guidance = '';
    try { await new TransformersJsSkillEmbedder().embed(['query'], { purpose: 'query' }); } catch (error) { guidance = String(error); }
    if (!guidance.includes('@huggingface/transformers@4.2.0') || !guidance.includes('custom SkillEmbedder')) throw new Error('missing install guidance');
  `;

  const managers = [
    { name: 'bun', command: 'bun', install: ['install', '--ignore-scripts'] },
    { name: 'npm', command: 'npm', install: ['install', '--ignore-scripts', '--legacy-peer-deps'] },
    {
      name: 'pnpm',
      command: 'pnpm',
      install: ['install', '--ignore-scripts', '--strict-peer-dependencies=false'],
    },
    { name: 'yarn', command: 'yarn', install: ['install', '--ignore-scripts'] },
  ];
  for (const manager of managers) {
    if (!available(manager.command)) {
      console.log(`optional-peer smoke: ${manager.name} unavailable (documented skip)`);
      continue;
    }
    const fixture = join(temporary, manager.name);
    run('mkdir', ['-p', fixture]);
    writeFileSync(
      join(fixture, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module', dependencies: { '@di-framework/ai': `file:${ai.path}`, '@di-framework/ai-utils': `file:${utils.path}`, '@di-framework/auth': '^5', '@di-framework/core': '^5' } }, null, 2)}\n`,
    );
    writeFileSync(join(fixture, 'consumer.mjs'), source);
    run(manager.command, manager.install, fixture);
    if (existsSync(join(fixture, 'node_modules/@huggingface/transformers'))) {
      throw new Error(`${manager.name} installed the optional Transformers.js peer`);
    }
    // The peer @di-framework/ai intentionally remains a Bun/TypeScript source package.
    run('bun', ['consumer.mjs'], fixture);
    console.log(`optional-peer smoke: ${manager.name} passed`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
