import { describe, expect, it } from 'bun:test';
import { hostInterfacesFromRequirements, renderHostInterfacesYaml } from '../src/host-interface';
import type { WitRequirement } from '../src/wit';

const postgres: WitRequirement = {
  package: 'wasmcloud:postgres',
  version: '0.2.0',
  interfaces: ['query', 'prepared', 'types'],
  direction: 'import',
  instanceName: 'user-database',
  source: 'UserDatabase',
};

describe('host interface overlays', () => {
  it('preserves names for other named host bindings', () => {
    const [entry] = hostInterfacesFromRequirements([
      {
        ...postgres,
        package: 'wasi:keyvalue',
        version: '0.3.0',
        interfaces: ['store'],
        instanceName: 'sessions',
      },
    ]);
    expect(entry?.name).toBe('sessions');
  });
  it('keeps PostgreSQL overlays while matching its unlabeled guest import', () => {
    const [entry] = hostInterfacesFromRequirements([postgres], {}, [
      {
        name: 'user-database',
        className: 'UserDatabase',
        secretFrom: 'orders-user-database',
        configFrom: 'orders-user-database-config',
        config: { database: 'orders' },
      },
    ]);
    expect(entry?.name).toBeUndefined();
    expect(entry?.secretFrom).toEqual([{ name: 'orders-user-database' }]);
    expect(entry?.configFrom).toEqual([{ name: 'orders-user-database-config' }]);
    expect(entry?.config).toEqual({ database: 'orders' });
    const yaml = renderHostInterfacesYaml(entry === undefined ? [] : [entry]);
    expect(yaml).not.toContain('name: "user-database"');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('configFrom:');
    expect(yaml).toContain('"database": "orders"');
  });
});
