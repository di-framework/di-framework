import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { useContainer } from '../container';
import { Container as Injectable, Telemetry, TelemetryListener } from '../decorators';

beforeEach(() => {
  useContainer().clear();
});

describe('Telemetry Decorators', () => {
  it('should capture telemetry from @Telemetry annotated methods', async () => {
    let capturedEvent: any = null;

    @Injectable()
    class MyListener {
      @TelemetryListener()
      onTelemetry(event: any) {
        capturedEvent = event;
      }
    }

    @Injectable()
    class MyService {
      @Telemetry()
      async doSomething(arg1: string) {
        return `done ${arg1}`;
      }
    }

    const container = useContainer();
    container.resolve(MyListener);
    const service = container.resolve(MyService);

    const result = await service.doSomething('test');

    expect(result).toBe('done test');
    expect(capturedEvent).toBeDefined();
    expect(capturedEvent.className).toBe('MyService');
    expect(capturedEvent.methodName).toBe('doSomething');
    expect(capturedEvent.args).toEqual(['test']);
    expect(capturedEvent.result).toBe('done test');
    expect(capturedEvent.startTime).toBeLessThanOrEqual(capturedEvent.endTime);
  });

  it('should capture errors in telemetry', async () => {
    let capturedEvent: any = null;

    @Injectable()
    class MyListener {
      @TelemetryListener()
      onTelemetry(event: any) {
        capturedEvent = event;
      }
    }

    @Injectable()
    class MyService {
      @Telemetry()
      doError() {
        throw new Error('fail');
      }
    }

    const container = useContainer();
    container.resolve(MyListener);
    const service = container.resolve(MyService);

    expect(() => service.doError()).toThrow('fail');

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent.error).toBeDefined();
    expect(capturedEvent.error.message).toBe('fail');
  });

  it('should work with sync methods', () => {
    let capturedEvent: any = null;

    @Injectable()
    class MyListener {
      @TelemetryListener()
      onTelemetry(event: any) {
        capturedEvent = event;
      }
    }

    @Injectable()
    class MyService {
      @Telemetry()
      doSync(val: number) {
        return val * 2;
      }
    }

    const container = useContainer();
    container.resolve(MyListener);
    const service = container.resolve(MyService);

    const result = service.doSync(21);

    expect(result).toBe(42);
    expect(capturedEvent).toBeDefined();
    expect(capturedEvent.methodName).toBe('doSync');
    expect(capturedEvent.result).toBe(42);
  });

  it('should log to console when logging option is enabled', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    @Injectable()
    class LoggingService {
      @Telemetry({ logging: true })
      doLogged(val: string) {
        return `logged ${val}`;
      }
    }

    const container = useContainer();
    const service = container.resolve(LoggingService);

    service.doLogged('hello');

    expect(logSpy).toHaveBeenCalled();
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1]![0];
    expect(lastCall).toContain('[Telemetry] LoggingService.doLogged - SUCCESS');
    expect(lastCall).toMatch(/\(\d+ms\)/);

    logSpy.mockRestore();
  });

  it('should log errors to console for async methods when logging option is enabled', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    @Injectable()
    class AsyncLoggingErrorService {
      @Telemetry({ logging: true })
      async doAsyncLoggedError() {
        throw new Error('async logged fail');
      }
    }

    const container = useContainer();
    const service = container.resolve(AsyncLoggingErrorService);

    await expect(service.doAsyncLoggedError()).rejects.toThrow('async logged fail');

    expect(logSpy).toHaveBeenCalled();
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1]![0];
    expect(lastCall).toContain(
      '[Telemetry] AsyncLoggingErrorService.doAsyncLoggedError - ERROR: async logged fail',
    );

    logSpy.mockRestore();
  });
});
