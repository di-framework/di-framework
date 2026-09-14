import { describe, expect, it } from 'bun:test';
import { hostStoragePath, workloadDocuments } from '../src/documents';
import { type DeployIntent, ORG_LABEL, OWNER_LABEL, TEAM_LABEL } from '../src/intent';

const intent: DeployIntent = {
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

describe('workloadDocuments', () => {
  it('stamps org, team, and owner from the principal, not the client', () => {
    const documents = workloadDocuments(
      intent,
      { namespace: 'wasmcloud' },
      { org: 'acme', team: 'warehouse', owner: 'alice' },
      'token',
    );
    const wd = documents.find((document) => document.kind === 'WorkloadDeployment');
    expect(wd?.metadata.namespace).toBe('wasmcloud');
    expect(wd?.metadata.labels[ORG_LABEL]).toBe('acme');
    expect(wd?.metadata.labels[TEAM_LABEL]).toBe('warehouse');
    expect(wd?.metadata.labels[OWNER_LABEL]).toBe('alice');
    expect(JSON.stringify(wd)).toContain('registry.example.com/take:sha256-abc');
    expect(JSON.stringify(wd)).not.toContain('hostPath');
  });

  it('uses the server namespace even when the application name looks like a path', () => {
    const documents = workloadDocuments(
      intent,
      { namespace: 'platform' },
      { org: 'acme', owner: 'alice' },
    );
    expect(documents.every((document) => document.metadata.namespace === 'platform')).toBe(true);
    expect(hostStoragePath('warehouse-take')).toBe('/var/lib/di-framework/storage/warehouse-take');
  });
});
