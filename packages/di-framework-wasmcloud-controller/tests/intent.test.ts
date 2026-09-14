import { describe, expect, it } from 'bun:test';
import { parseDeployIntent } from '../src/intent';

describe('parseDeployIntent', () => {
  const valid = {
    application: 'warehouse-take',
    witName: 'warehouse-take',
    image: 'registry.example.com/take:sha256-abc',
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
    for (const field of ['org', 'team', 'namespace', 'hostPath', 'hostSelector', 'owner', 'kubeconfig']) {
      expect(() => parseDeployIntent({ ...valid, [field]: 'nope' })).toThrow(/cannot be set by the client/);
    }
  });

  it('rejects images that are not digest-pinned', () => {
    expect(() => parseDeployIntent({ ...valid, image: 'registry.example.com/take:latest' })).toThrow(
      /digest-pinned/,
    );
  });
});
