import { describe, expect, it } from 'bun:test';
import {
  getWorkload,
  getWorkloadComponent,
  getWorkloadService,
  Workload,
  WorkloadComponent,
  WorkloadService,
} from '../src/workload.ts';

describe('workload membership', () => {
  it('records a colocation namespace name', async () => {
    const fetch = Workload('warehouse')(
      WorkloadComponent({ workload: 'warehouse' })(async () => new Response('ok')),
    );

    expect(getWorkload(fetch)).toEqual({ name: 'warehouse' });
    expect(getWorkloadComponent(fetch)).toEqual({ workload: 'warehouse' });
    expect(await (await fetch(new Request('http://warehouse/'))).text()).toBe('ok');
  });

  it('records component membership and an optional HTTP route', async () => {
    const fetch = WorkloadComponent({ workload: 'warehouse', route: '/take' })(
      async () => new Response('take'),
    );

    expect(getWorkload(fetch)).toBeUndefined();
    expect(getWorkloadComponent(fetch)).toEqual({ workload: 'warehouse', route: '/take' });
  });

  it('rejects routes that are not paths', () => {
    expect(() => WorkloadComponent({ workload: 'warehouse', route: 'take' })).toThrow(/\//);
  });

  it('records a service in the same workload, uncoupled from fetch', async () => {
    const run = WorkloadService({ workload: 'warehouse' })(async () => undefined);

    expect(getWorkloadService(run)).toEqual({ workload: 'warehouse' });
    expect(getWorkloadComponent(run)).toBeUndefined();
    await run();
  });

  it('rejects empty names', () => {
    expect(() => Workload('')).toThrow(/required/);
    expect(() => WorkloadComponent({ workload: ' ' })).toThrow(/required/);
    expect(() => WorkloadService({ workload: '' })).toThrow(/required/);
  });
});
