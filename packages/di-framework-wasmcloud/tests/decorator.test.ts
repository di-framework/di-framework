import { describe, expect, it } from 'bun:test';
import { Postgres } from '../src/bindings/postgres.ts';
import { WasmCloudBinding } from '../src/decorator.ts';
import { getBindingMetadata, isWitIdentifier } from '../src/metadata.ts';

describe('WasmCloudBinding', () => {
  it('stores the binding name and options on the class', () => {
    @WasmCloudBinding('user-database', {
      interfaces: ['query'],
      secretFrom: 'orders-user-database',
    })
    class UserDatabase extends Postgres {}

    expect(getBindingMetadata(UserDatabase)).toEqual({
      name: 'user-database',
      options: { interfaces: ['query'], secretFrom: 'orders-user-database' },
    });
  });

  it('rejects names that are not WIT identifiers', () => {
    expect(isWitIdentifier('user-database')).toBe(true);
    expect(isWitIdentifier('UserDatabase')).toBe(false);
    expect(() => {
      @WasmCloudBinding('UserDatabase')
      class Bad extends Postgres {}
      return Bad;
    }).toThrow(/WIT identifier/);
  });

  it('rejects plaintext secret values in config', () => {
    expect(() => {
      @WasmCloudBinding('user-database', { config: { url: 'postgres://secret' } })
      class Bad extends Postgres {}
      return Bad;
    }).toThrow(/secretFrom/);
    expect(() => {
      @WasmCloudBinding('cache', { config: { password: 'hunter2' } })
      class Bad extends Postgres {}
      return Bad;
    }).toThrow(/secretFrom/);
  });
});
