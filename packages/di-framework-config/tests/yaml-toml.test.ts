import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadConfigSync } from '../src/load.ts';
import { requireOptionalPeer } from '../src/optional-peer.ts';
import {
  getSelectedProfiles,
  profileConfigPath,
  runWithProfiles,
  setSelectedProfiles,
} from '../src/profiles.ts';

import { jsonFileSource } from '../src/sources/json-file.ts';
import { objectSource } from '../src/sources/object.ts';
import { tomlFileSource } from '../src/sources/toml-file.ts';
import { yamlFileSource } from '../src/sources/yaml-file.ts';

function withTempDir(prefix: string, run: (dir: string) => void): void {
  const dir = join(import.meta.dir, prefix);
  mkdirSync(dir, { recursive: true });
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('yamlFileSource', () => {
  it('reads object roots and treats missing optional files as empty', () => {
    withTempDir('.tmp-yaml', (dir) => {
      const file = join(dir, 'cfg.yaml');
      writeFileSync(file, 'host: h\nnested:\n  n: 1\n');
      expect(yamlFileSource(file).load()).toEqual({ host: 'h', nested: { n: 1 } });
      expect(yamlFileSource(join(dir, 'missing.yaml'), { optional: true }).load()).toEqual({});
    });
  });

  it('rejects non-object roots, invalid syntax, and required missing files', () => {
    withTempDir('.tmp-yaml-bad', (dir) => {
      const arr = join(dir, 'arr.yaml');
      writeFileSync(arr, '- 1\n- 2\n');
      expect(() => yamlFileSource(arr).load()).toThrow(/must be an object/);
      writeFileSync(join(dir, 'null.yaml'), 'null\n');
      expect(() => yamlFileSource(join(dir, 'null.yaml')).load()).toThrow(/must be an object/);
      writeFileSync(join(dir, 'bad.yaml'), 'host: [unterminated');
      expect(() => yamlFileSource(join(dir, 'bad.yaml')).load()).toThrow();
      expect(() => yamlFileSource(join(dir, 'bad.yaml'), { optional: true }).load()).toThrow();
      expect(() => yamlFileSource(join(dir, 'noop.yaml')).load()).toThrow();
    });
  });

  it('uses an injected parser', () => {
    withTempDir('.tmp-yaml-inject', (dir) => {
      const file = join(dir, 'cfg.yaml');
      writeFileSync(file, 'ignored');
      expect(yamlFileSource(file, { parse: () => ({ from: 'inject' }) }).load()).toEqual({
        from: 'inject',
      });
    });
  });
});

describe('tomlFileSource', () => {
  it('reads object roots and treats missing optional files as empty', () => {
    withTempDir('.tmp-toml', (dir) => {
      const file = join(dir, 'cfg.toml');
      writeFileSync(file, 'host = "h"\n\n[nested]\nn = 1\n');
      expect(tomlFileSource(file).load()).toEqual({ host: 'h', nested: { n: 1 } });
      expect(tomlFileSource(join(dir, 'missing.toml'), { optional: true }).load()).toEqual({});
    });
  });

  it('rejects invalid syntax, non-object roots, and required missing files', () => {
    withTempDir('.tmp-toml-bad', (dir) => {
      writeFileSync(join(dir, 'bad.toml'), 'host =');
      expect(() => tomlFileSource(join(dir, 'bad.toml')).load()).toThrow();
      expect(() => tomlFileSource(join(dir, 'bad.toml'), { optional: true }).load()).toThrow();
      writeFileSync(join(dir, 'arr.toml'), 'ignored');
      expect(() => tomlFileSource(join(dir, 'arr.toml'), { parse: () => [1, 2] }).load()).toThrow(
        /must be an object/,
      );
      expect(() => tomlFileSource(join(dir, 'noop.toml')).load()).toThrow();
    });
  });

  it('uses an injected parser', () => {
    withTempDir('.tmp-toml-inject', (dir) => {
      const file = join(dir, 'cfg.toml');
      writeFileSync(file, 'ignored');
      expect(tomlFileSource(file, { parse: () => ({ from: 'inject' }) }).load()).toEqual({
        from: 'inject',
      });
    });
  });
});

describe('profile overlays', () => {
  beforeEach(() => {
    setSelectedProfiles();
  });

  it('merges {profile}.config.{ext} over the base file', () => {
    withTempDir('.tmp-profile-yaml', (dir) => {
      const file = join(dir, 'config.yaml');
      writeFileSync(file, 'host: base\nport: 1\n');
      writeFileSync(join(dir, 'dev.config.yaml'), 'port: 9\nextra: true\n');
      expect(profileConfigPath(file, 'dev')).toBe(join(dir, 'dev.config.yaml'));
      expect(yamlFileSource(file, { profiles: ['dev'] }).load()).toEqual({
        host: 'base',
        port: 9,
        extra: true,
      });
    });
  });

  it('skips a missing profile overlay and still loads the base file', () => {
    withTempDir('.tmp-profile-missing', (dir) => {
      const file = join(dir, 'config.toml');
      writeFileSync(file, 'host = "base"\n');
      expect(tomlFileSource(file, { profiles: ['staging'] }).load()).toEqual({ host: 'base' });
    });
  });

  it('uses loadConfig profiles for json overlays', () => {
    withTempDir('.tmp-profile-json', (dir) => {
      const file = join(dir, 'config.json');
      writeFileSync(file, JSON.stringify({ a: 1, b: 1 }));
      writeFileSync(join(dir, 'prod.config.json'), JSON.stringify({ b: 2 }));
      expect(
        loadConfigSync({
          profiles: ['prod'],
          sources: [jsonFileSource(file)],
        }),
      ).toEqual({ a: 1, b: 2 });
    });
  });

  it('rejects unsafe profile names', () => {
    expect(() => yamlFileSource('config.yaml', { profiles: ['../x'] }).load()).toThrow(
      /Invalid config profile/,
    );
    expect(() => setSelectedProfiles('')).toThrow(/Invalid config profile/);
  });

  it('restores selected profiles when the profiled callback throws', () => {
    setSelectedProfiles();
    expect(() =>
      runWithProfiles(['dev'], () => {
        throw new Error('deverr');
      }),
    ).toThrow(/deverr/);
    expect(getSelectedProfiles()).toEqual([]);
  });

  it('honors setSelectedProfiles and restores after loadConfig', async () => {
    withTempDir('.tmp-profile-global', (dir) => {
      const file = join(dir, 'config.json');
      writeFileSync(file, JSON.stringify({ n: 1 }));
      writeFileSync(join(dir, 'qa.config.json'), JSON.stringify({ n: 2 }));
      setSelectedProfiles('qa');
      expect(getSelectedProfiles()).toEqual(['qa']);
      expect(jsonFileSource(file).load()).toEqual({ n: 2 });
    });
    expect(
      await loadConfig({
        profiles: ['other'],
        sources: [objectSource({ ok: true })],
      }),
    ).toEqual({ ok: true });
    expect(getSelectedProfiles()).toEqual(['qa']);
    setSelectedProfiles();
  });
});

describe('file source merge order', () => {
  it('deep-merges yaml then toml then later object sources', () => {
    withTempDir('.tmp-merge', (dir) => {
      const yaml = join(dir, 'a.yaml');
      const toml = join(dir, 'b.toml');
      writeFileSync(yaml, 'a: 1\nb:\n  x: 1\n');
      writeFileSync(toml, 'b = { y = 2 }\nc = 3\n');
      const json = join(dir, 'c.json');
      writeFileSync(json, JSON.stringify({ c: 4 }));
      expect(
        loadConfigSync({
          defaults: { a: 0 },
          sources: [
            yamlFileSource(yaml),
            tomlFileSource(toml),
            jsonFileSource(json),
            objectSource({ d: 5 }),
          ],
        }),
      ).toEqual({ a: 1, b: { x: 1, y: 2 }, c: 4, d: 5 });
    });
  });
});

describe('requireOptionalPeer', () => {
  it('loads an installed module and fails closed with install guidance', () => {
    const yaml = requireOptionalPeer<{ parse: (text: string) => unknown }>(
      'yaml',
      'should not throw',
    );
    expect(typeof yaml.parse).toBe('function');
    expect(() =>
      requireOptionalPeer(
        'this-optional-peer-is-not-installed',
        '@di-framework/config/yaml requires the optional peer dependency "yaml". Install it with: bun add yaml',
      ),
    ).toThrow(/optional peer dependency "yaml"/);
  });
});
