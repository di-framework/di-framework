import { describe, expect, it } from 'bun:test';
import { parseDeployIntent } from '../src/intent';

describe('parseDeployIntent', () => {
  const valid = {
    application: 'warehouse-take',
    witName: 'warehouse-take',
    image: `registry.example.com/take@sha256:${'a'.repeat(64)}`,
    deploymentDigest: 'abc',
    ingress: true,
    worker: false,
    bindings: [],
    hasActors: false,
    persistentStorage: false,
    cronJobs: [],
    queueHandlers: [],
  };

  it('accepts a digest-pinned intent', () => {
    expect(parseDeployIntent(valid).application).toBe('warehouse-take');
  });

  it('rejects client-set org, team, namespace, and hostPath', () => {
    for (const field of [
      'org',
      'team',
      'namespace',
      'hostPath',
      'hostSelector',
      'owner',
      'kubeconfig',
    ]) {
      expect(() => parseDeployIntent({ ...valid, [field]: 'nope' })).toThrow(
        /cannot be set by the client/,
      );
    }
  });

  it('rejects images that are not digest-pinned', () => {
    for (const image of [
      'registry.example.com/take:latest',
      'app:sha256-latest',
      'sha256-app:latest',
      'app:sha256-abc',
      'app@sha256:abc',
      `app@sha256:${'g'.repeat(64)}`,
      `app@sha256:${'a'.repeat(65)}`,
      `app@sha256:${'a'.repeat(64)}:latest`,
      `app@sha256:${'a'.repeat(64)}\n`,
    ]) {
      expect(() => parseDeployIntent({ ...valid, image })).toThrow(/digest-pinned/);
    }
  });
});
