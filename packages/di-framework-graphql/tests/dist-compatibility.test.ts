import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Import decorator APIs directly from built dist artifacts
import { Container as Injectable } from '../../di-framework-core/dist/decorators/index.js';
import { buildTypeGraph, SemanticRegistry, setRegistry } from '../dist/core.js';
import { Action, Arg, Field, Lookup, Portal, SemanticType } from '../dist/index.js';

function withDistRegistry<T>(fn: (registry: InstanceType<typeof SemanticRegistry>) => T): T {
  const fresh = new SemanticRegistry();
  const previous = setRegistry(fresh);
  try {
    return fn(fresh);
  } finally {
    setRegistry(previous);
  }
}

describe('Dist Artifacts & Packaging Compatibility', () => {
  it('supports decorator APIs imported from dist JS artifacts', () => {
    withDistRegistry((registry) => {
      @Injectable()
      @SemanticType()
      class TestUser {
        @Field(() => String)
        id(): string {
          return 'u-123';
        }

        @Field(() => String)
        name(): string {
          return 'Alice';
        }
      }

      @Portal()
      class TestUserPortal {
        @Action(() => TestUser)
        getUser(@Arg('id', () => String) id: string): TestUser {
          const u = new TestUser();
          return u;
        }

        @Lookup()
        static lookupUser(@Arg('id', () => String) id: string): TestUser {
          const u = new TestUser();
          return u;
        }
      }

      expect(TestUser).toBeDefined();
      expect(TestUserPortal).toBeDefined();
    });
  });

  it('builds type graph using decorators imported from dist artifacts', () => {
    withDistRegistry((registry) => {
      @SemanticType()
      class Product {
        @Field(() => String)
        sku(): string {
          return 'PROD-1';
        }
      }

      @Portal()
      class ProductPortal {
        @Action(() => Product)
        getProduct(@Arg('sku', () => String) sku: string): Product {
          return new Product();
        }
      }

      const graph = buildTypeGraph({ registry });
      expect(graph).toBeDefined();
      expect(graph.query).toBeDefined();
    });
  });

  it('verifies Node.js compatibility for dist JS artifacts across all subpaths', () => {
    const rootDir = path.resolve(import.meta.dir, '../../..');

    const nodeScript = `
      import { Container as Injectable } from "./packages/di-framework-core/dist/container.js";
      import { SemanticType, Portal, Field, Arg, Action, Lookup } from "./packages/di-framework-graphql/dist/index.js";
      import { buildTypeGraph, SemanticRegistry, setRegistry } from "./packages/di-framework-graphql/dist/core.js";

      if (typeof Injectable !== "function") throw new Error("Injectable is not a function");
      if (typeof SemanticType !== "function") throw new Error("SemanticType is not a function");
      if (typeof Portal !== "function") throw new Error("Portal is not a function");
      if (typeof Field !== "function") throw new Error("Field is not a function");
      if (typeof Arg !== "function") throw new Error("Arg is not a function");
      if (typeof Action !== "function") throw new Error("Action is not a function");
      if (typeof Lookup !== "function") throw new Error("Lookup is not a function");
      if (typeof buildTypeGraph !== "function") throw new Error("buildTypeGraph is not a function");

      const reg = new SemanticRegistry();
      setRegistry(reg);
      const graph = buildTypeGraph({ registry: reg });
      if (!graph) throw new Error("Failed to build type graph");
      console.log("SUCCESS");
    `;

    const output = execFileSync('node', ['--input-type=module', '-e', nodeScript], {
      cwd: rootDir,
      encoding: 'utf8',
    });

    expect(output.trim()).toBe('SUCCESS');
  });

  it('verifies type declaration (.d.ts) files exist for all public subpath exports', () => {
    const rootDir = path.resolve(import.meta.dir, '../../..');
    const runtimePackages = [
      {
        name: 'di-framework-core',
        exports: ['./dist/container.d.ts', './dist/decorators/index.d.ts', './dist/types.d.ts'],
      },
      { name: 'di-framework-repo', exports: ['./dist/index.d.ts'] },
      { name: 'di-framework-http', exports: ['./dist/index.d.ts'] },
      { name: 'di-framework-graphql', exports: ['./dist/index.d.ts', './dist/core.d.ts'] },
      {
        name: 'di-framework-events',
        exports: [
          './dist/index.d.ts',
          './dist/memory.d.ts',
          './dist/kafka.d.ts',
          './dist/nats.d.ts',
        ],
      },
      { name: 'di-framework-config', exports: ['./dist/index.d.ts', './dist/zod.d.ts'] },
      {
        name: 'di-framework-auth',
        exports: [
          './dist/index.d.ts',
          './dist/webauthn.d.ts',
          './dist/oauth.d.ts',
          './dist/http.d.ts',
          './dist/graphql.d.ts',
          './dist/repo.d.ts',
          './dist/server.d.ts',
        ],
      },
      {
        name: 'di-framework-authz',
        exports: ['./dist/index.d.ts', './dist/http.d.ts', './dist/graphql.d.ts'],
      },
      {
        name: 'di-framework-socket',
        exports: [
          './dist/index.d.ts',
          './dist/node.d.ts',
          './dist/bun.d.ts',
          './dist/graphql.d.ts',
          './dist/workers.d.ts',
        ],
      },
      {
        name: 'di-framework-rpc',
        exports: [
          './dist/index.d.ts',
          './dist/memory.d.ts',
          './dist/http.d.ts',
          './dist/socket.d.ts',
          './dist/grpc.d.ts',
        ],
      },
      { name: 'di-framework-codegen', exports: ['./dist/index.d.ts'] },
    ];

    for (const pkg of runtimePackages) {
      for (const dtsRelativePath of pkg.exports) {
        const fullDtsPath = path.join(rootDir, 'packages', pkg.name, dtsRelativePath);
        expect(fs.existsSync(fullDtsPath)).toBe(true);
      }
    }
  });
});
