/**
 * Resolver internals not already exercised end-to-end through `schema.test.ts`:
 * stable batch cache keys, field middleware chains, subscription authorization
 * (the deferred-iterator dance) and the container event bridge's lifecycle
 * methods.
 */

import { describe, expect, it } from 'bun:test';
import { Container } from '@di-framework/core/container';
import {
  Arg,
  Field,
  Info,
  Parent,
  Portal,
  Requires,
  SemanticType,
  Subscription,
} from '../src/decorators.ts';
import { containerEventIterator, ResolverFactory } from '../src/resolvers.ts';
import { buildSemanticSchema } from '../src/schema.ts';
import { buildTypeGraph } from '../src/type-graph.ts';
import { withRegistry } from './helpers.ts';

describe('field middleware', () => {
  it('runs an ordered chain around the resolved method, and @Info() injects resolve info', () => {
    const seen: string[] = [];

    const api = withRegistry(() => {
      @Portal()
      class Query {
        @Field(() => String, {
          middleware: [
            (next, ctx) => {
              seen.push(`before:${ctx.field.name}`);
              const result = next();
              seen.push('after');
              return result;
            },
          ],
        })
        greet(@Info() info: any): string {
          seen.push('handler');
          return typeof info === 'object' && info !== null ? 'hi' : 'no-info';
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    return api.execute({ query: '{ greet }' }).then((result) => {
      expect(result.errors).toBeUndefined();
      expect(result.data?.greet).toBe('hi');
      expect(seen).toEqual(['before:greet', 'handler', 'after']);
    });
  });

  it('falls through every layer to the underlying method when middleware calls next()', () => {
    const order: string[] = [];

    const api = withRegistry(() => {
      @Portal()
      class Query {
        @Field(() => Number, {
          middleware: [
            (next) => {
              order.push('outer');
              return (next() as number) + 1;
            },
            (next) => {
              order.push('inner');
              return (next() as number) * 10;
            },
          ],
        })
        value(): number {
          order.push('method');
          return 2;
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    return api.execute({ query: '{ value }' }).then((result) => {
      expect(result.errors).toBeUndefined();
      // outer(inner(method())) => (2 * 10) + 1
      expect(result.data?.value).toBe(21);
      expect(order).toEqual(['outer', 'inner', 'method']);
    });
  });
});

describe('batched field cache keys', () => {
  it('coalesces calls with identical multi-key arguments into one batch', async () => {
    let batches = 0;

    const api = withRegistry(() => {
      @SemanticType({ key: 'id' })
      class Widget {
        id!: string;

        @Field(() => String, { batch: 'labelsFor' })
        label(
          @Arg('prefix', () => String) prefix: string,
          @Arg('suffix', () => String) suffix: string,
        ): string {
          return `${prefix}-${this.id}-${suffix}`;
        }

        static labelsFor(widgets: Widget[]): string[] {
          batches += 1;
          return widgets.map((w) => `${w.id}!`);
        }
      }

      @Portal()
      class Query {
        @Field(() => [Widget])
        widgets(): Widget[] {
          return ['a', 'b'].map((id) => Object.assign(new Widget(), { id }));
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    const result = await api.execute({
      query: '{ widgets { label(prefix: "p", suffix: "s") } }',
      context: {},
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as any)?.widgets.map((w: any) => w.label)).toEqual(['a!', 'b!']);
    expect(batches).toBe(1);
  });
});

describe('@Subscription with @Requires', () => {
  function subscriptionField() {
    return withRegistry((registry) => {
      @Portal()
      class Query {
        @Requires({ roles: ['admin'] })
        @Subscription('resolvers-test.event', () => String)
        onEvent(): string {
          return 'x';
        }
      }

      const graph = buildTypeGraph({ registry });
      const container = new Container();
      const factory = new ResolverFactory({ graph, container });
      const field = graph.query.fields
        .concat(graph.subscription?.fields ?? [])
        .find((f) => f.name === 'onEvent')!;
      return { field, factory, container };
    });
  }

  it('rejects before opening the stream when the caller lacks the role', async () => {
    const { field, factory } = subscriptionField();
    const subscribe = factory.createSubscribe(field);
    const iterator = subscribe(undefined, {}, { user: { id: 'u1', roles: [] } }, {});

    await expect(iterator.next()).rejects.toThrow('Not authorized.');
  });

  it('opens the stream once the caller is authorized, and forwards return/throw', async () => {
    const { field, factory, container } = subscriptionField();
    const subscribe = factory.createSubscribe(field);
    const ctx = { user: { id: 'u1', roles: ['admin'] } };
    const iterator = subscribe(undefined, {}, ctx, {});

    // Symbol.asyncIterator on the deferred wrapper returns itself.
    expect((iterator as any)[Symbol.asyncIterator]()).toBe(iterator);

    const pending = iterator.next();
    // Let the authorization check's microtasks settle before the container
    // has anyone listening — otherwise emitting here is a no-op.
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.emit('resolvers-test.event' as any, { hello: 'world' });
    const { value, done } = await pending;
    expect(done).toBe(false);
    expect(value).toEqual({ hello: 'world' });

    // return() delegates to the now-open source once it exists.
    const closed = await iterator.return!();
    expect(closed).toEqual({ value: undefined, done: true });
  });

  it('return() before the stream opens resolves done without a source', async () => {
    const { field, factory } = subscriptionField();
    const subscribe = factory.createSubscribe(field);
    const iterator = subscribe(undefined, {}, { user: { id: 'u1', roles: ['admin'] } }, {});

    const result = await iterator.return!();
    expect(result).toEqual({ value: undefined, done: true });
  });

  it('throw() before the stream opens rejects immediately without a source', async () => {
    const { field, factory } = subscriptionField();
    const subscribe = factory.createSubscribe(field);
    const iterator = subscribe(undefined, {}, { user: { id: 'u1', roles: ['admin'] } }, {});

    await expect(iterator.throw!(new Error('early'))).rejects.toThrow('early');
  });

  it('throw() once open delegates to the underlying container event iterator', async () => {
    const { field, factory, container } = subscriptionField();
    const subscribe = factory.createSubscribe(field);
    const ctx = { user: { id: 'u1', roles: ['admin'] } };
    const iterator = subscribe(undefined, {}, ctx, {});

    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.emit('resolvers-test.event' as any, { n: 1 });
    await pending;

    await expect(iterator.throw!(new Error('boom'))).rejects.toThrow('boom');
  });
});

describe('@Subscription field resolver with arguments', () => {
  it('coerces the subscription field method arguments like any other field', async () => {
    const container = new Container();
    const api = withRegistry(() => {
      @Portal()
      class Query {
        @Subscription('resolvers-test.argged-event', () => String)
        onEventShout(
          @Parent() payload: string,
          @Arg('suffix', () => String) suffix: string,
        ): string {
          return `${payload}${suffix}`;
        }
      }

      return buildSemanticSchema({ container });
    });

    const iterator = (await api.subscribe({
      query: 'subscription { onEventShout(suffix: "!") }',
    })) as AsyncIterableIterator<any>;

    const next = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.emit('resolvers-test.argged-event' as any, 'hi');

    const event = await next;
    expect(event.value.data.onEventShout).toBe('hi!');
  });
});

describe('@Subscription on a property field', () => {
  it('publishes the raw event payload with no method to invoke', async () => {
    const container = new Container();
    const api = withRegistry(() => {
      @Portal()
      class Query {
        // @ts-expect-error - @Subscription is typed as MethodDecorator; property fields are supported at runtime.
        @Subscription('resolvers-test.property-event', () => String)
        declare onRaw: string;
      }

      return buildSemanticSchema({ container });
    });

    const iterator = (await api.subscribe({
      query: 'subscription { onRaw }',
    })) as AsyncIterableIterator<any>;

    const next = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.emit('resolvers-test.property-event' as any, 'raw-value');

    const event = await next;
    expect(event.value.data.onRaw).toBe('raw-value');
  });
});

describe('containerEventIterator', () => {
  it('rejects and finishes when thrown into directly', async () => {
    const container = new Container();
    const iterator = containerEventIterator(container, 'direct.event', (payload) => payload);

    await expect(iterator.throw!(new Error('kaboom'))).rejects.toThrow('kaboom');
    // Finishing unsubscribes and marks the iterator done for any further reads.
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('return() resolves done even with nothing pending', async () => {
    const container = new Container();
    const iterator = containerEventIterator(container, 'direct.event', (payload) => payload);
    expect(await iterator.return!()).toEqual({ value: undefined, done: true });
  });

  it('is its own async iterator', () => {
    const container = new Container();
    const iterator = containerEventIterator(container, 'direct.event', (payload) => payload);
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
  });
});
