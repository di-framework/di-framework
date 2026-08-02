import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '../container';
import { Component, Container as Injectable } from '../decorators';

beforeEach(() => {
  useContainer().clear();
});

describe('Constructor parameter injection with @Component', () => {
  it('injects class dependencies into constructor using @Component on params', () => {
    @Injectable()
    class Repo {
      id = 'repo';
    }

    @Injectable()
    class Service {
      dep: Repo;
      constructor(@Component(Repo) dep: Repo) {
        this.dep = dep;
      }
    }

    const c = useContainer();
    const s = c.resolve(Service);
    expect(s.dep).toBeInstanceOf(Repo);
    // default singleton
    expect(s.dep).toBe(c.resolve(Repo));
  });

  it('supports string tokens in constructor params with factory registration', () => {
    const TOKEN = 'endpoint';

    @Injectable()
    class ApiClient {
      endpoint: string;
      constructor(@Component(TOKEN) endpoint: string) {
        this.endpoint = endpoint;
      }
    }

    const c = useContainer();
    c.registerFactory(TOKEN, () => 'https://example.test');

    const api = c.resolve(ApiClient);
    expect(api.endpoint).toBe('https://example.test');
  });
});
