import { describe, expect, it } from 'bun:test';
import { Field, Portal } from '../src/decorators.ts';
import { BatchLoader } from '../src/loader.ts';
import { buildSemanticSchema, createGraphQLHandler } from '../src/schema.ts';
import { withRegistry } from './helpers.ts';

function handler() {
  return withRegistry((registry) => {
    @Portal()
    class EchoPortal {
      @Field(() => String)
      echo(message: string, ctx: Record<string, any>): string {
        return `${ctx.prefix ?? ''}${message}`;
      }
    }

    const api = buildSemanticSchema({ registry });
    return createGraphQLHandler(api, {
      context: (request) => ({ prefix: request.headers.get('x-prefix') ?? '' }),
    });
  });
}

describe('createGraphQLHandler', () => {
  it('executes a POST query', async () => {
    const response = await handler()(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-prefix': '>>' },
        body: JSON.stringify({ query: '{ echo(message: "hi") }' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { echo: '>>hi' } });
  });

  it('executes a GET query', async () => {
    const response = await handler()(
      new Request('http://localhost/graphql?query={ echo(message: "hi") }'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { echo: 'hi' } });
  });

  it('rejects other methods and malformed bodies', async () => {
    const run = handler();

    const wrongMethod = await run(new Request('http://localhost/graphql', { method: 'DELETE' }));
    expect(wrongMethod.status).toBe(405);

    const badBody = await run(
      new Request('http://localhost/graphql', { method: 'POST', body: 'not json' }),
    );
    expect(badBody.status).toBe(400);

    const missingQuery = await run(new Request('http://localhost/graphql'));
    expect(missingQuery.status).toBe(400);

    const missingBodyQuery = await run(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ variables: {} }),
      }),
    );
    expect(missingBodyQuery.status).toBe(400);

    const withVariables = await run(
      new Request(
        'http://localhost/graphql?query=' +
          encodeURIComponent('{ echo(message: "via-get") }') +
          '&variables=' +
          encodeURIComponent('{}'),
      ),
    );
    expect(withVariables.status).toBe(200);
    expect(await withVariables.json()).toEqual({ data: { echo: 'via-get' } });
  });

  it('reports validation errors without executing', async () => {
    const response = await handler()(new Request('http://localhost/graphql?query={ nope }'));
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.errors[0].message).toContain('Cannot query field');
  });
});

describe('BatchLoader', () => {
  it('collapses keys requested in the same tick into one call', async () => {
    const calls: string[][] = [];
    const loader = new BatchLoader<string, string>((keys) => {
      calls.push([...keys]);
      return keys.map((key) => key.toUpperCase());
    });

    const results = await Promise.all([loader.load('a'), loader.load('b'), loader.load('a')]);

    expect(results).toEqual(['A', 'B', 'A']);
    expect(calls).toEqual([['a', 'b']]);
  });

  it('rejects every key when the batch function fails', async () => {
    const loader = new BatchLoader<string, string>(() => {
      throw new Error('nope');
    });
    await expect(loader.load('a')).rejects.toThrow('nope');
  });

  it('loadMany loads multiple keys and clear resets cache', async () => {
    const calls: string[][] = [];
    const loader = new BatchLoader<string, string>((keys) => {
      calls.push([...keys]);
      return keys.map((key) => key.toUpperCase());
    });

    const results = await loader.loadMany(['a', 'b']);
    expect(results).toEqual(['A', 'B']);
    expect(calls).toEqual([['a', 'b']]);

    loader.clear();
    await loader.load('a');
    expect(calls).toEqual([['a', 'b'], ['a']]);
  });
});
