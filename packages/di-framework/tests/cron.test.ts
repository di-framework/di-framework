import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '../container';
import { Cron, Container as Injectable } from '../decorators';

beforeEach(() => {
  useContainer().clear();
});

afterEach(() => {
  useContainer().clear();
});

describe('@Cron decorator', () => {
  it('runs a method on an interval (ms shorthand)', async () => {
    let count = 0;

    @Injectable()
    class Worker {
      @Cron(50)
      tick() {
        count++;
      }
    }

    const c = useContainer();
    c.resolve(Worker);

    expect(count).toBe(0);
    await new Promise((r) => setTimeout(r, 130));
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('stops cron jobs when container is cleared', async () => {
    let count = 0;

    @Injectable()
    class Worker {
      @Cron(30)
      tick() {
        count++;
      }
    }

    const c = useContainer();
    c.resolve(Worker);

    await new Promise((r) => setTimeout(r, 80));
    const countBeforeClear = count;
    expect(countBeforeClear).toBeGreaterThanOrEqual(1);

    c.clear();

    await new Promise((r) => setTimeout(r, 80));
    expect(count).toBe(countBeforeClear);
  });

  it('stopCronJobs() stops jobs without clearing services', async () => {
    let count = 0;

    @Injectable()
    class Worker {
      @Cron(30)
      tick() {
        count++;
      }
    }

    const c = useContainer();
    c.resolve(Worker);

    await new Promise((r) => setTimeout(r, 80));
    c.stopCronJobs();
    const snapshot = count;

    await new Promise((r) => setTimeout(r, 80));
    expect(count).toBe(snapshot);
    expect(c.has(Worker)).toBe(true);
  });

  it('handles errors in cron methods without stopping the schedule', async () => {
    let calls = 0;

    @Injectable()
    class Faulty {
      @Cron(40)
      boom() {
        calls++;
        if (calls === 1) throw new Error('first call fails');
      }
    }

    const c = useContainer();
    c.resolve(Faulty);

    await new Promise((r) => setTimeout(r, 130));
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
