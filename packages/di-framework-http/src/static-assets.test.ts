import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRegisteredStaticAssets,
  createStaticAssetHandler,
  generateAssetManifest,
  getMimeType,
  HttpRouter,
  matchesIfNoneMatch,
  packageStaticAssets,
  registerStaticAssets,
} from '../index.ts';

let TEST_DIR: string;
let outsideDir: string;

function setupTestFiles() {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'di-static-test-'));

  writeFileSync(join(TEST_DIR, 'index.html'), '<!doctype html><html>Hello</html>');
  writeFileSync(join(TEST_DIR, 'style.css'), 'body { color: red; }');
  writeFileSync(join(TEST_DIR, 'app.js'), 'console.log("app");');
  writeFileSync(join(TEST_DIR, 'data.json'), '{"key":"value"}');
  writeFileSync(join(TEST_DIR, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  writeFileSync(join(TEST_DIR, '.env'), 'SECRET=forbidden');

  const subDir = join(TEST_DIR, 'subdir');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'subfile.txt'), 'hello from subdir');
  writeFileSync(join(subDir, '.hidden.txt'), 'hidden file in sub');

  // Internal safe symlink
  try {
    symlinkSync(join(TEST_DIR, 'style.css'), join(TEST_DIR, 'safe-link.css'));
  } catch {}

  // External symlink (escape attempt)
  outsideDir = mkdtempSync(join(tmpdir(), 'di-static-outside-'));
  writeFileSync(join(outsideDir, 'secret.txt'), 'sensitive outside data');
  try {
    symlinkSync(outsideDir, join(TEST_DIR, 'symlink-outside'));
  } catch {}
}

describe('Static Assets Serving', () => {
  beforeEach(() => {
    clearRegisteredStaticAssets();
    setupTestFiles();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    clearRegisteredStaticAssets();
  });

  it('serves files with correct MIME type, content, and headers', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        cacheControl: 'public, max-age=3600',
      })
      .build();

    // GET HTML
    const htmlRes = await router.fetch(new Request('http://localhost/assets/index.html'));
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(htmlRes.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(htmlRes.headers.get('etag')).toBeDefined();
    expect(htmlRes.headers.get('content-length')).toBe(
      String(Buffer.byteLength('<!doctype html><html>Hello</html>')),
    );
    expect(await htmlRes.text()).toBe('<!doctype html><html>Hello</html>');

    // GET CSS
    const cssRes = await router.fetch(new Request('http://localhost/assets/style.css'));
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await cssRes.text()).toBe('body { color: red; }');

    // GET JSON
    const jsonRes = await router.fetch(new Request('http://localhost/assets/data.json'));
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await jsonRes.json()).toEqual({ key: 'value' });

    // GET PNG
    const pngRes = await router.fetch(new Request('http://localhost/assets/image.png'));
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get('content-type')).toBe('image/png');
    const pngBytes = new Uint8Array(await pngRes.arrayBuffer());
    expect(pngBytes.length).toBe(8);

    // GET nested file
    const subRes = await router.fetch(new Request('http://localhost/assets/subdir/subfile.txt'));
    expect(subRes.status).toBe(200);
    expect(subRes.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await subRes.text()).toBe('hello from subdir');
  });

  it('supports HEAD method returning headers without body', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        cacheControl: 'public, max-age=7200',
      })
      .build();

    const res = await router.fetch(
      new Request('http://localhost/assets/style.css', { method: 'HEAD' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('content-length')).toBe(
      String(Buffer.byteLength('body { color: red; }')),
    );
    expect(res.headers.get('etag')).toBeDefined();
    expect(res.headers.get('cache-control')).toBe('public, max-age=7200');

    const bodyText = await res.text();
    expect(bodyText).toBe('');
  });

  it('rejects unsupported methods with 405 when fallthrough is false', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        fallthrough: false,
      })
      .build();

    const postRes = await router.fetch(
      new Request('http://localhost/assets/style.css', { method: 'POST' }),
    );
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get('allow')).toBe('GET, HEAD');

    const deleteRes = await router.fetch(
      new Request('http://localhost/assets/style.css', { method: 'DELETE' }),
    );
    expect(deleteRes.status).toBe(405);
  });

  it('passes unsupported methods to subsequent routes when fallthrough is true', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        fallthrough: true,
      })
      .build();

    router.post('/assets/style.css', () => new Response('custom POST handler'));

    const res = await router.fetch(
      new Request('http://localhost/assets/style.css', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('custom POST handler');
  });

  it('supports ETag and conditional If-None-Match requests (304 Not Modified)', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        cacheControl: 'public, max-age=3600',
      })
      .build();

    // 1. Initial request to get ETag
    const firstRes = await router.fetch(new Request('http://localhost/assets/style.css'));
    expect(firstRes.status).toBe(200);
    const etag = firstRes.headers.get('etag');
    expect(etag).toBeDefined();

    // 2. Conditional request with exact ETag -> 304
    const notModifiedRes = await router.fetch(
      new Request('http://localhost/assets/style.css', {
        headers: { 'If-None-Match': etag! },
      }),
    );
    expect(notModifiedRes.status).toBe(304);
    expect(notModifiedRes.headers.get('etag')).toBe(etag);
    expect(notModifiedRes.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await notModifiedRes.text()).toBe('');

    // 3. Conditional request with wildcard '*' -> 304
    const wildcardRes = await router.fetch(
      new Request('http://localhost/assets/style.css', {
        headers: { 'If-None-Match': '*' },
      }),
    );
    expect(wildcardRes.status).toBe(304);

    // 4. Conditional request with weak ETag -> 304
    const weakRes = await router.fetch(
      new Request('http://localhost/assets/style.css', {
        headers: { 'If-None-Match': etag!.startsWith('W/') ? etag! : `W/${etag}` },
      }),
    );
    expect(weakRes.status).toBe(304);

    // 5. Conditional request with comma-separated list including etag -> 304
    const listRes = await router.fetch(
      new Request('http://localhost/assets/style.css', {
        headers: { 'If-None-Match': `"other-tag", ${etag}` },
      }),
    );
    expect(listRes.status).toBe(304);

    // 6. Conditional request with mismatched ETag -> 200
    const mismatchRes = await router.fetch(
      new Request('http://localhost/assets/style.css', {
        headers: { 'If-None-Match': '"stale-etag-value"' },
      }),
    );
    expect(mismatchRes.status).toBe(200);
    expect(await mismatchRes.text()).toBe('body { color: red; }');
  });

  it('prevents directory traversal attacks', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        fallthrough: false,
      })
      .build();

    // Encoded traversal %2e%2e
    const res1 = await router.fetch(new Request('http://localhost/assets/%2e%2e%2fpackage.json'));
    expect([403, 404]).toContain(res1.status);

    // Subdirectory traversal with %2f
    const res2 = await router.fetch(
      new Request('http://localhost/assets/subdir/..%2f..%2fsecret.txt'),
    );
    expect([403, 404]).toContain(res2.status);

    // Double encoded traversal (%252e%252e)
    const res3 = await router.fetch(new Request('http://localhost/assets/%252e%252e%2findex.html'));
    expect([403, 404]).toContain(res3.status);

    // Null byte injection
    const res4 = await router.fetch(new Request('http://localhost/assets/style.css%00.html'));
    expect([400, 403, 404]).toContain(res4.status);

    // Root mounted static router prevents traversal beyond root
    const rootRouter = HttpRouter.builder()
      .static('/', { directory: TEST_DIR, fallthrough: false })
      .build();
    const res5 = await rootRouter.fetch(new Request('http://localhost/../etc/passwd'));
    expect([403, 404]).toContain(res5.status);
  });

  it('prevents symlink escapes outside the asset directory', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        fallthrough: false,
      })
      .build();

    // Attempting to access the outside symlink
    const res = await router.fetch(
      new Request('http://localhost/assets/symlink-outside/secret.txt'),
    );
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('sensitive outside data');

    // Accessing safe internal symlink works
    const safeRes = await router.fetch(new Request('http://localhost/assets/safe-link.css'));
    if (safeRes.status === 200) {
      expect(await safeRes.text()).toBe('body { color: red; }');
    }
  });

  it('disables directory listings by default (returns 404)', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        fallthrough: false,
      })
      .build();

    // Mount prefix itself
    const rootRes = await router.fetch(new Request('http://localhost/assets'));
    expect(rootRes.status).toBe(404);

    const rootSlashRes = await router.fetch(new Request('http://localhost/assets/'));
    expect(rootSlashRes.status).toBe(404);

    // Subdirectory
    const subRes = await router.fetch(new Request('http://localhost/assets/subdir'));
    expect(subRes.status).toBe(404);

    const subSlashRes = await router.fetch(new Request('http://localhost/assets/subdir/'));
    expect(subSlashRes.status).toBe(404);
  });

  it('disables hidden-file serving by default (returns 404)', async () => {
    const router = HttpRouter.builder()
      .static('/assets', {
        directory: TEST_DIR,
        fallthrough: false,
      })
      .build();

    // Hidden file at root of assets
    const envRes = await router.fetch(new Request('http://localhost/assets/.env'));
    expect(envRes.status).toBe(404);
    expect(await envRes.text()).not.toContain('SECRET');

    // Hidden file in subdir
    const subHiddenRes = await router.fetch(
      new Request('http://localhost/assets/subdir/.hidden.txt'),
    );
    expect(subHiddenRes.status).toBe(404);
  });

  it('demonstrates fallthrough: true vs fallthrough: false', async () => {
    // 1. With fallthrough: false, missing files return 404
    const strictRouter = HttpRouter.builder()
      .static('/assets', { directory: TEST_DIR, fallthrough: false })
      .build();
    strictRouter.get('/assets/*', () => new Response('catchall route'));

    const strictRes = await strictRouter.fetch(
      new Request('http://localhost/assets/nonexistent.txt'),
    );
    expect(strictRes.status).toBe(404);

    // 2. With fallthrough: true, missing files fall through to subsequent routes
    const fallthroughRouter = HttpRouter.builder()
      .static('/assets', { directory: TEST_DIR, fallthrough: true })
      .build();
    fallthroughRouter.get('/assets/*', () => new Response('hit fallback!'));

    const ftRes = await fallthroughRouter.fetch(
      new Request('http://localhost/assets/nonexistent.txt'),
    );
    expect(ftRes.status).toBe(200);
    expect(await ftRes.text()).toBe('hit fallback!');
  });

  it('local dev: reads directory live so edits appear without rebuild', async () => {
    const router = HttpRouter.builder().static('/assets', { directory: TEST_DIR }).build();

    const fileToEdit = join(TEST_DIR, 'live.txt');
    writeFileSync(fileToEdit, 'version 1');

    const res1 = await router.fetch(new Request('http://localhost/assets/live.txt'));
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe('version 1');
    const etag1 = res1.headers.get('etag');

    // Edit file on disk live
    writeFileSync(fileToEdit, 'version 2 updated live!');

    const res2 = await router.fetch(new Request('http://localhost/assets/live.txt'));
    expect(res2.status).toBe(200);
    expect(await res2.text()).toBe('version 2 updated live!');
    const etag2 = res2.headers.get('etag');
    expect(etag2).not.toBe(etag1);

    // Add another new file live
    const newFile = join(TEST_DIR, 'brand-new.json');
    writeFileSync(newFile, '{"live":true}');

    const res3 = await router.fetch(new Request('http://localhost/assets/brand-new.json'));
    expect(res3.status).toBe(200);
    expect(await res3.json()).toEqual({ live: true });
  });

  it('build-time packaging: generateAssetManifest creates complete index with hashes and ETags', () => {
    const manifest = generateAssetManifest(TEST_DIR);
    expect(manifest.version).toBe(1);
    expect(manifest.generatedAt).toBeDefined();

    const htmlAsset = manifest.assets['/index.html'];
    expect(htmlAsset).toBeDefined();
    expect(htmlAsset?.contentType).toBe('text/html; charset=utf-8');
    expect(htmlAsset?.size).toBe(Buffer.byteLength('<!doctype html><html>Hello</html>'));
    expect(htmlAsset?.hash).toBeDefined();
    expect(htmlAsset?.etag).toBeDefined();

    const cssAsset = manifest.assets['/style.css'];
    expect(cssAsset).toBeDefined();
    expect(cssAsset?.contentType).toBe('text/css; charset=utf-8');

    expect(manifest.assets['/subdir/subfile.txt']).toBeDefined();

    // Hidden files should NOT be included in manifest
    expect(manifest.assets['/.env']).toBeUndefined();
    expect(manifest.assets['/subdir/.hidden.txt']).toBeUndefined();
  });

  it('build-time packaging: packageStaticAssets bundles assets for server & wasmCloud runtime without source dir', async () => {
    const pkg = packageStaticAssets({
      directory: TEST_DIR,
      outFile: join(TEST_DIR, 'packaged-assets.json'),
    });

    expect(pkg.version).toBe(1);
    const cssAsset = pkg.assets['/style.css'];
    expect(cssAsset).toBeDefined();
    expect(cssAsset?.content).toBe('body { color: red; }');
    expect(cssAsset?.encoding).toBe('utf-8');

    const pngAsset = pkg.assets['/image.png'];
    expect(pngAsset).toBeDefined();
    expect(pngAsset?.encoding).toBe('base64');

    // Test serving purely from package without source directory on disk
    const mockVirtualDir = '/nonexistent/virtual/path/' + Math.random().toString(36).slice(2);
    const router = HttpRouter.builder()
      .static('/static', {
        directory: mockVirtualDir,
        package: pkg,
      })
      .build();

    const cssRes = await router.fetch(new Request('http://localhost/static/style.css'));
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await cssRes.text()).toBe('body { color: red; }');

    const pngRes = await router.fetch(new Request('http://localhost/static/image.png'));
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get('content-type')).toBe('image/png');
    const pngBytes = new Uint8Array(await pngRes.arrayBuffer());
    expect(pngBytes.length).toBe(8);

    // HEAD works on packaged assets
    const headRes = await router.fetch(
      new Request('http://localhost/static/style.css', { method: 'HEAD' }),
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('etag')).toBe(cssRes.headers.get('etag'));
    expect(await headRes.text()).toBe('');

    // ETag conditional request on packaged assets
    const etag = cssRes.headers.get('etag')!;
    const notModRes = await router.fetch(
      new Request('http://localhost/static/style.css', {
        headers: { 'If-None-Match': etag },
      }),
    );
    expect(notModRes.status).toBe(304);

    // Traversal on packaged assets
    const travRes = await router.fetch(new Request('http://localhost/static/%2e%2e%2fsecret.txt'));
    expect([403, 404]).toContain(travRes.status);
  });

  it('allows registering static assets globally for seamless runtime resolution', async () => {
    const pkg = packageStaticAssets({ directory: TEST_DIR });
    registerStaticAssets('/global-assets', pkg);

    const router = HttpRouter.builder()
      .static('/global-assets', {
        directory: '/path/does/not/exist',
      })
      .build();

    const res = await router.fetch(new Request('http://localhost/global-assets/style.css'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body { color: red; }');
  });

  it('supports mounting via router.static() on built router instance', async () => {
    const router = HttpRouter.builder().build();
    router.static('/mounted', { directory: TEST_DIR });

    const res = await router.fetch(new Request('http://localhost/mounted/style.css'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body { color: red; }');
  });
  it('prefers packaged contents over a live directory unless live is explicitly enabled', async () => {
    const pkg = packageStaticAssets({ directory: TEST_DIR });
    unlinkSync(join(TEST_DIR, 'style.css'));
    const handler = createStaticAssetHandler('/assets', {
      directory: TEST_DIR,
      package: pkg,
      cacheControl: 'max-age=60',
    });
    const response = (await handler(new Request('http://localhost/assets/style.css')))!;
    expect(await response.text()).toBe('body { color: red; }');
    const conditional = (await handler(
      new Request('http://localhost/assets/style.css', {
        headers: { 'if-none-match': response.headers.get('etag')! },
      }),
    ))!;
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('cache-control')).toBe('max-age=60');
    const live = createStaticAssetHandler('/assets', {
      directory: TEST_DIR,
      package: pkg,
      live: true,
    });
    expect((await live(new Request('http://localhost/assets/style.css')))!.status).toBe(404);
  });

  it('writes package outputs and loads object, file and registered manifests', async () => {
    const outputDir = join(outsideDir, 'build');
    const pkg = packageStaticAssets({
      directory: TEST_DIR,
      outputDir,
      outFile: join(outputDir, 'assets.js'),
      prefix: '/generated',
    });
    expect(readFileSync(join(outputDir, 'assets.js'), 'utf8')).toContain(
      'registerStaticAssets("/generated"',
    );
    expect(
      JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')).assets['/style.css'],
    ).toBeDefined();
    for (const manifest of [pkg, join(outputDir, 'static-assets.json')]) {
      const handler = createStaticAssetHandler('/assets/', { directory: TEST_DIR, manifest });
      expect(await (await handler(new Request('http://localhost/assets/style.css')))!.text()).toBe(
        'body { color: red; }',
      );
    }
    writeFileSync(join(outputDir, 'broken.json'), '{');
    const invalid = createStaticAssetHandler('/assets', {
      directory: 'missing',
      manifest: join(outputDir, 'broken.json'),
    });
    expect((await invalid(new Request('http://localhost/assets/x')))!.status).toBe(404);
    registerStaticAssets('virtual-directory', pkg);
    const registered = createStaticAssetHandler('/virtual', { directory: 'virtual-directory' });
    expect((await registered(new Request('http://localhost/virtual/style.css')))!.status).toBe(200);
    expect(() => generateAssetManifest(join(TEST_DIR, 'missing'))).toThrow('Directory not found');
    symlinkSync(join(outsideDir, 'build/assets.js'), join(TEST_DIR, 'external.js'));
    expect(generateAssetManifest(TEST_DIR).assets['/external.js']).toBeUndefined();
  });

  it('handles malformed paths and missing assets consistently with fallthrough', async () => {
    for (const fallthrough of [false, true]) {
      const handler = createStaticAssetHandler('/assets', { directory: TEST_DIR, fallthrough });
      expect(await handler(new Request('http://localhost/unrelated'))).toBeUndefined();
      for (const [suffix, status] of [
        ['%', 400],
        ['bad%00', 403],
        ['%252e%252e%2ffile', 403],
        ['..%2ffile', 403],
        ['.hidden', 404],
        ['', 404],
        ['subdir', 404],
      ] as const) {
        const response = await handler(new Request('http://localhost/assets/' + suffix));
        if (fallthrough) expect(response).toBeUndefined();
        else expect(response!.status).toBe(status);
      }
      const pkg = packageStaticAssets({ directory: TEST_DIR });
      const packaged = createStaticAssetHandler('/assets', {
        directory: 'missing',
        package: pkg,
        fallthrough,
      });
      const missing = await packaged(new Request('http://localhost/assets/missing'));
      expect(missing?.status).toBe(fallthrough ? undefined : 404);
      const empty = createStaticAssetHandler('/assets', { directory: 'missing', fallthrough });
      expect((await empty(new Request('http://localhost/assets/missing')))?.status).toBe(
        fallthrough ? undefined : 404,
      );
    }
    expect(getMimeType('unknown.xyz')).toBe('application/octet-stream');
    expect(matchesIfNoneMatch('"other", W/"value"', '"value"')).toBe(true);
  });

  it('streams files under Node ESM without Bun globals or require', async () => {
    const { spawnSync } = await import('node:child_process');
    const outFile = join(outsideDir, 'static-assets.mjs');
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, 'static-assets.ts')],
      target: 'node',
      format: 'esm',
      outdir: outsideDir,
      naming: 'static-assets.mjs',
    });
    expect(result.success).toBe(true);
    const child = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
      const { createStaticAssetHandler, createFileStream } = await import(process.argv[1]);
      const handler = createStaticAssetHandler('/assets', { directory: process.argv[2] });
      const response = await handler(new Request('http://localhost/assets/style.css'));
      if (response.status !== 200) throw new Error('Unexpected status');
      console.log(await response.text());
      const stream = createFileStream(process.argv[2] + '/style.css', 2);
      console.log(await new Response(stream).text());
    `,
        outFile,
        TEST_DIR,
      ],
      { encoding: 'utf8' },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('body { color: red; }');
  });

  it('returns a miss if the live root or target disappears during path resolution', async () => {
    const realpath = fs.realpathSync;
    for (const failAt of [TEST_DIR, join(realpath(TEST_DIR), 'style.css')]) {
      for (const fallthrough of [true, false]) {
        const spy = spyOn(fs, 'realpathSync').mockImplementation(((file: any, ...args: any[]) => {
          if (file === failAt) throw new Error('path disappeared');
          return (realpath as any)(file, ...args);
        }) as any);
        try {
          const handler = createStaticAssetHandler('/assets', { directory: TEST_DIR, fallthrough });
          expect((await handler(new Request('http://localhost/assets/style.css')))?.status).toBe(
            fallthrough ? undefined : 404,
          );
        } finally {
          spy.mockRestore();
        }
      }
    }
    const handler = createStaticAssetHandler('/assets', { directory: TEST_DIR });
    expect((await handler(new Request('http://localhost/assets/%25')))!.status).toBe(404);
    expect((await handler(new Request('http://localhost/assets/%2541')))!.status).toBe(404);
    symlinkSync(TEST_DIR, join(TEST_DIR, 'self-link'));
    const dirLink = join(TEST_DIR, 'outside-link');
    symlinkSync(outsideDir, dirLink);
    expect(generateAssetManifest(TEST_DIR).assets['/outside-link']).toBeUndefined();
  });
  it('uses live files with metadata-only manifests and refuses missing packaged contents', async () => {
    const manifest = generateAssetManifest(TEST_DIR);
    const live = createStaticAssetHandler('/assets', { directory: TEST_DIR, manifest });
    const response = (await live(new Request('http://localhost/assets/style.css')))!;
    expect(await response.text()).toBe('body { color: red; }');
    const missing = createStaticAssetHandler('/assets', { directory: 'missing', manifest });
    expect((await missing(new Request('http://localhost/assets/style.css')))!.status).toBe(404);
  });
});
