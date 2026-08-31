import { describe, expect, it } from 'bun:test';
import { ApplicationContext } from '../application-context';
import { Container } from '../container';
import { Bean, Configuration } from '../decorators';

describe('ApplicationContext configuration', () => {
  it('materializes sync and async beans in dependency order', async () => {
    const calls: string[] = [];
    @Configuration()
    class AppConfiguration {
      @Bean()
      port() {
        calls.push('port');
        return 0;
      }

      @Bean('url', { dependencies: ['port'] })
      async url(port: number) {
        calls.push('url');
        return `http://localhost:${port}`;
      }

      @Bean('optional')
      optional(): undefined {
        return undefined;
      }
    }

    const context = ApplicationContext.builder().configuration(AppConfiguration);
    await context.start();
    expect(calls).toEqual(['port', 'url']);
    expect(context.container.resolve<number>('port')).toBe(0);
    expect(context.container.resolve<string>('url')).toBe('http://localhost:0');
    expect(context.container.resolve('optional')).toBeUndefined();
    expect(context.container.resolve('optional')).toBeUndefined();
  });

  it('supports explicit class tokens', async () => {
    class Clock {}
    @Configuration()
    class Config {
      @Bean(Clock)
      clock() {
        return new Clock();
      }
    }
    const context = ApplicationContext.builder().configuration(new Config());
    await context.start();
    expect(context.container.resolve(Clock)).toBeInstanceOf(Clock);
  });

  it('preflights duplicate, missing, and cyclic beans before factories run', async () => {
    let invoked = false;
    @Configuration()
    class Missing {
      @Bean('a', { dependencies: ['absent'] })
      a() {
        invoked = true;
      }
    }
    await expect(ApplicationContext.builder().configuration(Missing).start()).rejects.toThrow(
      "Missing dependency 'absent' required by bean 'a'",
    );
    expect(invoked).toBe(false);

    @Configuration()
    class Cyclic {
      @Bean('a', { dependencies: ['b'] })
      a() {}
      @Bean('b', { dependencies: ['a'] })
      b() {}
    }
    await expect(ApplicationContext.builder().configuration(Cyclic).start()).rejects.toThrow(
      'Cyclic bean dependency',
    );

    @Configuration()
    class Duplicate {
      @Bean('same')
      one() {}
      @Bean('same')
      two() {}
    }
    await expect(ApplicationContext.builder().configuration(Duplicate).start()).rejects.toThrow(
      "Duplicate bean token 'same'",
    );
  });

  it('rejects classes not marked as configurations', async () => {
    class Plain {}
    await expect(ApplicationContext.builder().configuration(Plain).start()).rejects.toThrow(
      'must be decorated with @Configuration()',
    );
  });

  it('rejects @Bean on non-method properties', () => {
    expect(() => Bean()({}, 'notAMethod', { value: 1 } as PropertyDescriptor)).toThrow(
      '@Bean can only decorate methods (notAMethod)',
    );
  });
});

describe('ApplicationContext lifecycle', () => {
  it('starts once and stops successfully started components in reverse order', async () => {
    const events: string[] = [];
    class First {
      async start() {
        events.push('first:start');
      }
      stop() {
        events.push('first:stop');
      }
    }
    class Second {
      start() {
        events.push('second:start');
      }
      async stop() {
        events.push('second:stop');
      }
    }
    const context = ApplicationContext.builder().bootstrap(First, Second);
    const starts = await Promise.all([context.start(), context.start()]);
    expect(starts).toEqual([context, context]);
    await Promise.all([context.stop(), context.stop()]);
    expect(events).toEqual(['first:start', 'second:start', 'second:stop', 'first:stop']);
  });

  it('cleans up after startup failure and keeps failure terminal', async () => {
    const events: string[] = [];
    class Good {
      start() {
        events.push('good:start');
      }
      stop() {
        events.push('good:stop');
      }
    }
    class Bad {
      start() {
        throw new Error('startup failed');
      }
    }
    const context = ApplicationContext.builder().bootstrap(Good, Bad);
    await expect(context.start()).rejects.toThrow('startup failed');
    await expect(context.start()).rejects.toThrow('startup failed');
    await context.stop();
    expect(events).toEqual(['good:start', 'good:stop']);
  });
});

describe('Container.registerValue', () => {
  it('caches false, zero, empty strings, null, and undefined', () => {
    const container = new Container();
    for (const [token, value] of [
      ['false', false],
      ['zero', 0],
      ['empty', ''],
      ['null', null],
      ['undefined', undefined],
    ] as const) {
      container.registerValue(token, value);
      expect(container.resolve<unknown>(token)).toBe(value);
      expect(container.resolve<unknown>(token)).toBe(value);
    }
  });
});
