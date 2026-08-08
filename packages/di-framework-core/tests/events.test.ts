import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { useContainer } from '../container';
import { Container as Injectable, Publisher, Subscriber } from '../decorators';

beforeEach(() => {
  useContainer().clear();
});

describe('Event Decorators - @Publisher and @Subscriber', () => {
  it('publishes events and delivers them to subscribers (after phase by default)', () => {
    const received: any[] = [];

    @Injectable()
    class AuditService {
      @Subscriber('user.created')
      onUserCreated(payload: any) {
        received.push(payload);
      }
    }

    @Injectable()
    class UserService {
      @Publisher('user.created')
      createUser(name: string) {
        return { id: 1, name };
      }
    }

    const c = useContainer();
    const _audit = c.resolve(AuditService);
    const user = c.resolve(UserService);

    const res = user.createUser('Alice');
    expect(res).toEqual({ id: 1, name: 'Alice' });

    expect(received.length).toBe(1);
    const evt = received[0];
    expect(evt.className).toBe('UserService');
    expect(evt.methodName).toBe('createUser');
    expect(evt.args).toEqual(['Alice']);
    expect(evt.result).toEqual({ id: 1, name: 'Alice' });
  });

  it("supports phase: 'before' to emit prior to execution without result", () => {
    let got: any | null = null;

    @Injectable()
    class Listener {
      @Subscriber('work')
      onBefore(payload: any) {
        got = payload;
      }
    }

    @Injectable()
    class Worker {
      @Publisher({ event: 'work', phase: 'before' })
      run(n: number) {
        return n * 2;
      }
    }

    const c = useContainer();
    c.resolve(Listener);
    const w = c.resolve(Worker);

    const r = w.run(7);
    expect(r).toBe(14);

    expect(got).toBeTruthy();
    expect(got.methodName).toBe('run');
    expect(got.args).toEqual([7]);
    expect(got.result).toBeUndefined();
  });

  it('emits for async success and error cases', async () => {
    const events: any[] = [];

    @Injectable()
    class Sink {
      @Subscriber('async.op')
      onEvt(e: any) {
        events.push(e);
      }
    }

    @Injectable()
    class AsyncService {
      @Publisher('async.op')
      async succeed(x: number) {
        return x + 1;
      }

      @Publisher('async.op')
      async fail() {
        throw new Error('boom');
      }
    }

    const c = useContainer();
    c.resolve(Sink);
    const s = c.resolve(AsyncService);

    const ok = await s.succeed(9);
    expect(ok).toBe(10);

    // At least one success event should be present
    const successEvt = events.find((e) => e.methodName === 'succeed');
    expect(successEvt).toBeTruthy();
    expect(successEvt.result).toBe(10);

    await expect(s.fail()).rejects.toThrow('boom');

    const errorEvt = events.find((e) => e.methodName === 'fail');
    expect(errorEvt).toBeTruthy();
    expect(errorEvt.error).toBeTruthy();
    expect(errorEvt.error.message).toBe('boom');
  });

  it('logs when logging option is enabled on @Publisher', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    @Injectable()
    class Logged {
      @Publisher({ event: 'log.op', logging: true })
      go() {
        return 'ok';
      }
    }

    const c = useContainer();
    const svc = c.resolve(Logged);
    svc.go();

    expect(logSpy).toHaveBeenCalled();
    const last = logSpy.mock.calls[logSpy.mock.calls.length - 1]?.[0];
    expect(last).toContain("[Publisher] Logged.go -> 'log.op' - SUCCESS");

    logSpy.mockRestore();
  });
});
